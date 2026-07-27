/**
 * API authentication and authorization.
 *
 * Two mechanisms, one interface:
 *  - **API keys** for programmatic access (SDKs, agents, servers).
 *  - **Dashboard sessions** for the browser UI, backed by Clerk when it is
 *    configured and by a local development identity otherwise.
 *
 * Keys are compared by SHA-256 digest with a constant-time comparison, so
 * neither the key nor its length leaks through response timing.
 */
import { sha256, timingSafeEqual } from '@memorydb/core';
import { apiKey as configuredApiKey, clerkEnabled, env, isProduction } from './env';
import { readSessionCookie, verifySessionToken } from './session';

export const SCOPES = ['read', 'write', 'admin'] as const;
export type Scope = (typeof SCOPES)[number];

export interface AuthContext {
  authenticated: boolean;
  namespace: string;
  scopes: Scope[];
  /** How the caller proved identity. */
  method: 'api_key' | 'session' | 'disabled';
  keyId?: string;
  userId?: string;
}

export class AuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly code: 'unauthorized' | 'forbidden',
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Cached digest of the configured key so we hash the secret once, not per request. */
let configuredKeyDigest: Promise<string> | null = null;

function getConfiguredKeyDigest(): Promise<string> | null {
  if (!configuredApiKey) return null;
  configuredKeyDigest ??= sha256(configuredApiKey);
  return configuredKeyDigest;
}

/**
 * Extract a bearer token.
 *
 * Accepts `Authorization: Bearer <key>` and the `X-API-Key` header. Query
 * parameters are deliberately *not* supported: URLs end up in access logs,
 * browser history, and Referer headers.
 */
export function extractApiKey(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  if (authorization) {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) return match[1].trim();
  }

  const header = request.headers.get('x-api-key');
  return header?.trim() || null;
}

/**
 * Resolve the namespace for a request.
 *
 * An explicit `X-Namespace` header wins; otherwise the configured default is
 * used. The value is validated because it flows into storage queries.
 */
export function extractNamespace(request: Request): string {
  const requested = request.headers.get('x-namespace')?.trim();
  if (!requested) return env.DEFAULT_NAMESPACE;

  if (!/^[a-zA-Z0-9_:.-]{1,128}$/.test(requested)) {
    throw new AuthError(403, 'forbidden', 'namespace must match [a-zA-Z0-9_:.-]{1,128}');
  }
  return requested;
}

/**
 * Authenticate a request.
 *
 * Throws `AuthError` rather than returning a falsy value, so a caller that
 * forgets to check the result fails closed instead of open.
 */
export async function authenticate(request: Request): Promise<AuthContext> {
  const namespace = extractNamespace(request);

  // Explicit local-development escape hatch. `env.ts` refuses to boot with this
  // enabled in production, so it cannot be turned on by accident where it matters.
  if (env.AUTH_DISABLED && !isProduction) {
    return { authenticated: true, namespace, scopes: ['read', 'write', 'admin'], method: 'disabled' };
  }

  const presented = extractApiKey(request);
  if (presented) {
    const expected = getConfiguredKeyDigest();
    if (!expected) {
      throw new AuthError(401, 'unauthorized', 'API key authentication is not configured on this server');
    }

    const presentedDigest = await sha256(presented);
    if (!timingSafeEqual(presentedDigest, await expected)) {
      throw new AuthError(401, 'unauthorized', 'invalid API key');
    }

    return {
      authenticated: true,
      namespace,
      // The bootstrap key is full-access by design; per-key scopes live in the
      // api_keys table once a database is configured.
      scopes: ['read', 'write', 'admin'],
      method: 'api_key',
      keyId: `${presented.slice(0, 12)}…`,
    };
  }

  const session = await resolveSession(request);
  if (session) {
    return { authenticated: true, namespace, scopes: ['read', 'write', 'admin'], method: 'session', userId: session };
  }

  throw new AuthError(
    401,
    'unauthorized',
    'authentication required — send an API key via the Authorization: Bearer header',
  );
}

/**
 * Resolve a dashboard session.
 *
 * Three mechanisms, in priority order:
 *
 *  1. **Clerk**, when configured — the recommended path for hosted deployments.
 *  2. **A signed session cookie**, issued when the operator signs in with the
 *     API key. This is what makes the dashboard usable on a self-hosted
 *     deployment that does not use Clerk; without it the UI would return 401 on
 *     every request while the API worked fine.
 *  3. **A local development identity**, for same-origin browser requests when
 *     nothing is configured. Never available in production.
 */
async function resolveSession(request: Request): Promise<string | null> {
  if (clerkEnabled) {
    try {
      const { auth } = (await import('@clerk/nextjs/server')) as unknown as {
        auth: () => Promise<{ userId: string | null }>;
      };
      const { userId } = await auth();
      if (userId) return userId;
    } catch {
      // Fall through to the cookie path rather than failing closed on a Clerk outage.
    }
  }

  if (await verifySessionToken(readSessionCookie(request))) {
    return 'dashboard-user';
  }

  if (isProduction) return null;

  // Same-origin check: a cross-site request must not inherit the dev identity.
  const origin = request.headers.get('origin');
  if (origin && !origin.startsWith(env.NEXT_PUBLIC_APP_URL)) return null;

  const accepts = request.headers.get('accept') ?? '';
  const isBrowserNavigation = accepts.includes('text/html') || request.headers.get('sec-fetch-mode') === 'cors';
  return isBrowserNavigation ? 'dev-user' : null;
}

/** Assert a scope, throwing 403 when absent. */
export function requireScope(context: AuthContext, scope: Scope): void {
  if (context.scopes.includes(scope)) return;
  if (context.scopes.includes('admin')) return; // admin implies everything
  throw new AuthError(403, 'forbidden', `this operation requires the "${scope}" scope`);
}
