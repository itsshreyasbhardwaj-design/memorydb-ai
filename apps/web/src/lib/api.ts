/**
 * Route handler composition.
 *
 * Every API route is wrapped by `handler`, which applies — in order — request
 * identity, rate limiting, authentication, scope checks, body-size limits, and
 * uniform error serialisation. Routes themselves contain only business logic,
 * so a route cannot accidentally skip a security control by forgetting a step.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { MemoryDBError, isMemoryDBError, generateId, type MemoryClient } from '@memorydb/core';
import { AuthError, authenticate, requireScope, type AuthContext, type Scope } from './auth';
import { checkRateLimit, rateLimitHeaders } from './rate-limit';
import { getNamespacedClient, logger, metrics } from './memory';
import { env } from './env';

export interface RouteContext<TBody = unknown, TQuery = unknown> {
  request: Request;
  auth: AuthContext;
  client: MemoryClient;
  body: TBody;
  query: TQuery;
  params: Record<string, string>;
  requestId: string;
}

export interface HandlerOptions<TBody, TQuery> {
  /** Scope required to invoke the route. */
  scope?: Scope;
  /** Body schema. Presence implies the body is parsed and validated as JSON. */
  bodySchema?: z.ZodType<TBody>;
  /** Query-string schema, fed from `searchParams`. */
  querySchema?: z.ZodType<TQuery>;
  /** Count against the stricter write budget. */
  write?: boolean;
  /** Skip JSON body parsing — for binary uploads the route reads itself. */
  rawBody?: boolean;
  /** Maximum accepted body size. Defaults to `MAX_CONTENT_LENGTH`. */
  maxBodyBytes?: number;
}

/** Serialise any error into the uniform API error envelope. */
function errorResponse(err: unknown, requestId: string, extraHeaders: Record<string, string> = {}): NextResponse {
  const headers = { 'x-request-id': requestId, ...extraHeaders };

  if (err instanceof AuthError) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message, retryable: false }, requestId },
      { status: err.status, headers },
    );
  }

  if (isMemoryDBError(err)) {
    // 5xx indicates our fault and deserves a log line; 4xx is the caller's.
    if (err.status >= 500) {
      logger.error('request failed', { requestId, code: err.code, message: err.message, error: err });
    }
    return NextResponse.json({ ...err.toJSON(), requestId }, { status: err.status, headers });
  }

  if (err instanceof z.ZodError) {
    return NextResponse.json(
      {
        error: { code: 'validation_error', message: 'request validation failed', details: err.flatten(), retryable: false },
        requestId,
      },
      { status: 400, headers },
    );
  }

  logger.error('unhandled route error', { requestId, error: err });
  return NextResponse.json(
    {
      // Never leak an internal message or stack trace to the client.
      error: { code: 'internal_error', message: 'an unexpected error occurred', retryable: true },
      requestId,
    },
    { status: 500, headers },
  );
}

/** Convert `URLSearchParams` into a plain object, collapsing repeats into arrays. */
function searchParamsToObject(url: URL): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of url.searchParams) {
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[key] = [existing, value];
  }
  return out;
}

/**
 * Next 15 passes every App Router handler a context whose `params` is a promise.
 * The shape must be declared exactly — Next type-checks route exports against its
 * own generated `RouteContext`, and a widened or optional second parameter is
 * rejected at build time.
 */
type NextRouteContext = { params: Promise<Record<string, string>> };

export function handler<TBody = unknown, TQuery = unknown>(
  options: HandlerOptions<TBody, TQuery>,
  route: (context: RouteContext<TBody, TQuery>) => Promise<NextResponse | Response>,
): (request: Request, next: NextRouteContext) => Promise<Response> {
  return async function wrapped(request: Request, next: NextRouteContext): Promise<Response> {
    const requestId = generateId('evt');
    const startedAt = performance.now();
    const url = new URL(request.url);
    const routeLabel = url.pathname;

    let rateHeaders: Record<string, string> = {};

    try {
      // ---- Rate limit ----
      // Applied before authentication so an unauthenticated flood is cheap to
      // reject, keyed by IP until a key identifies the caller.
      const preAuthKey = request.headers.get('x-api-key') ?? request.headers.get('authorization') ?? undefined;
      const limit = await checkRateLimit(request, {
        identifier: preAuthKey ? preAuthKey.slice(-16) : undefined,
        write: options.write ?? false,
      });
      rateHeaders = rateLimitHeaders(limit);

      if (!limit.allowed) {
        metrics.increment('api.rate_limited', 1, { route: routeLabel });
        return NextResponse.json(
          {
            error: {
              code: 'rate_limited',
              message: `rate limit exceeded — retry in ${limit.retryAfterSeconds}s`,
              retryable: true,
            },
            requestId,
          },
          { status: 429, headers: { 'x-request-id': requestId, ...rateHeaders } },
        );
      }

      // ---- Authenticate & authorize ----
      const auth = await authenticate(request);
      if (options.scope) requireScope(auth, options.scope);

      // ---- Body ----
      const declaredLength = Number(request.headers.get('content-length') ?? 0);
      const maxBytes = options.maxBodyBytes ?? env.MAX_CONTENT_LENGTH;
      if (declaredLength > maxBytes) {
        throw new MemoryDBError('payload_too_large', `request body exceeds the ${maxBytes} byte limit`);
      }

      let body = undefined as TBody;
      if (options.bodySchema && !options.rawBody) {
        let raw: unknown;
        try {
          const text = await request.text();
          if (text.length > maxBytes) {
            throw new MemoryDBError('payload_too_large', `request body exceeds the ${maxBytes} byte limit`);
          }
          raw = text ? JSON.parse(text) : {};
        } catch (err) {
          if (isMemoryDBError(err)) throw err;
          throw new MemoryDBError('validation_error', 'request body is not valid JSON');
        }
        body = options.bodySchema.parse(raw);
      }

      // ---- Query ----
      let query = undefined as TQuery;
      if (options.querySchema) {
        query = options.querySchema.parse(searchParamsToObject(url));
      }

      // Static routes still receive a context, but guard anyway so the wrapper
      // stays usable from tests that invoke it directly.
      const params = next?.params ? await next.params : {};
      const client = await getNamespacedClient(auth.namespace);

      const response = await route({ request, auth, client, body, query, params, requestId });

      for (const [key, value] of Object.entries({ 'x-request-id': requestId, ...rateHeaders })) {
        response.headers.set(key, value);
      }

      const durationMs = performance.now() - startedAt;
      metrics.observe('api.request', durationMs, { route: routeLabel, method: request.method });
      metrics.increment('api.requests', 1, { route: routeLabel, status: String(response.status) });

      logger.info('request completed', {
        requestId,
        method: request.method,
        path: routeLabel,
        status: response.status,
        durationMs: Math.round(durationMs * 100) / 100,
        namespace: auth.namespace,
      });

      return response;
    } catch (err) {
      const durationMs = performance.now() - startedAt;
      metrics.observe('api.request', durationMs, { route: routeLabel, method: request.method });
      metrics.increment('api.errors', 1, { route: routeLabel });
      return errorResponse(err, requestId, rateHeaders);
    }
  };
}

/** Success envelope, so every response has a predictable shape. */
export function ok<T>(data: T, init: ResponseInit = {}): NextResponse {
  return NextResponse.json({ data, error: null }, { status: 200, ...init });
}

export function created<T>(data: T): NextResponse {
  return NextResponse.json({ data, error: null }, { status: 201 });
}

export function noContent(): NextResponse {
  return new NextResponse(null, { status: 204 }) as NextResponse;
}

/* -------------------------------------------------------------------------- */
/*                            Shared query schemas                             */
/* -------------------------------------------------------------------------- */

/** Query params arrive as strings; these coerce and validate them. */
export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

/** Accepts `tags=a&tags=b` and `tags=a,b` alike. */
export const csvArray = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    const list = Array.isArray(value) ? value : value.split(',');
    const cleaned = list.map((item) => item.trim()).filter(Boolean);
    return cleaned.length > 0 ? cleaned : undefined;
  });
