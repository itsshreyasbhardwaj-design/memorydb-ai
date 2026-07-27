/**
 * `/api/v1/auth/session` — dashboard sign-in and sign-out.
 *
 * Deliberately outside the standard `handler` wrapper: this endpoint runs
 * *before* a caller has any credentials, so the usual authentication step would
 * reject every request to it. Rate limiting is applied directly instead, keyed
 * by IP, to make brute-forcing the API key impractical.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { checkRateLimit, rateLimitHeaders } from '@/lib/rate-limit';
import {
  SESSION_COOKIE,
  createSessionToken,
  isValidApiKey,
  sessionCookieOptions,
} from '@/lib/session';
import { logger } from '@/lib/memory';

export const dynamic = 'force-dynamic';

const signInSchema = z.object({ apiKey: z.string().min(1) });

export async function POST(request: Request): Promise<NextResponse> {
  // A stricter budget than normal writes: this is the one endpoint where a
  // successful guess is catastrophic.
  const limit = await checkRateLimit(request, { write: true });
  if (!limit.allowed) {
    return NextResponse.json(
      {
        error: {
          code: 'rate_limited',
          message: `too many sign-in attempts — retry in ${limit.retryAfterSeconds}s`,
          retryable: true,
        },
      },
      { status: 429, headers: rateLimitHeaders(limit) },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'validation_error', message: 'request body is not valid JSON', retryable: false } },
      { status: 400 },
    );
  }

  const parsed = signInSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'validation_error', message: 'apiKey is required', retryable: false } },
      { status: 400 },
    );
  }

  if (!isValidApiKey(parsed.data.apiKey)) {
    // Deliberately vague: distinguishing "no key configured" from "wrong key"
    // would tell an attacker whether the deployment is worth attacking.
    logger.warn('failed dashboard sign-in attempt');
    return NextResponse.json(
      { error: { code: 'unauthorized', message: 'invalid API key', retryable: false } },
      { status: 401, headers: rateLimitHeaders(limit) },
    );
  }

  const token = await createSessionToken();
  if (!token) {
    return NextResponse.json(
      {
        error: {
          code: 'not_supported',
          message: 'no API key is configured on this server, so dashboard sign-in is unavailable',
          retryable: false,
        },
      },
      { status: 501 },
    );
  }

  const response = NextResponse.json({ data: { authenticated: true }, error: null });
  response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return response;
}

/** Sign out by expiring the cookie. */
export async function DELETE(): Promise<NextResponse> {
  const response = NextResponse.json({ data: { authenticated: false }, error: null });
  response.cookies.set(SESSION_COOKIE, '', sessionCookieOptions(0));
  return response;
}
