/**
 * Dashboard sessions for self-hosted deployments.
 *
 * Clerk is the recommended identity provider, but requiring it would make the
 * dashboard unusable for anyone self-hosting without it — the API would work
 * while the UI returned 401 on every request. This module provides the fallback:
 * the operator signs in with the same API key the SDKs use, and receives a
 * short-lived signed cookie.
 *
 * The token is `expiry.hmac`, where the HMAC is computed over the expiry using
 * the API key as the secret. That means:
 *
 *  - the cookie is unforgeable without the key,
 *  - it carries no secret material itself, so leaking it exposes a session
 *    rather than the key,
 *  - rotating the API key invalidates every outstanding session for free,
 *  - and no additional configuration or storage is required.
 *
 * The cookie is HttpOnly (invisible to scripts), SameSite=Strict (not sent
 * cross-site, which blocks CSRF), and Secure in production.
 */
import { timingSafeEqual } from '@memorydb/core';
import { apiKey, isProduction } from './env';

export const SESSION_COOKIE = 'memorydb_session';

/** Eight hours: long enough for a working day, short enough to limit exposure. */
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

const encoder = new TextEncoder();

async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));

  let hex = '';
  for (const byte of new Uint8Array(signature)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** Issue a session token. Returns null when no API key is configured. */
export async function createSessionToken(now: number = Date.now()): Promise<string | null> {
  if (!apiKey) return null;
  const expiry = String(now + SESSION_TTL_MS);
  return `${expiry}.${await sign(expiry, apiKey)}`;
}

/**
 * Verify a session token.
 *
 * Signature is checked in constant time, and the expiry is validated *after*
 * the signature so an attacker cannot use timing on an unsigned payload.
 */
export async function verifySessionToken(token: string | undefined, now: number = Date.now()): Promise<boolean> {
  if (!token || !apiKey) return false;

  const separator = token.lastIndexOf('.');
  if (separator <= 0) return false;

  const expiry = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!/^\d+$/.test(expiry)) return false;

  const expected = await sign(expiry, apiKey);
  if (!timingSafeEqual(signature, expected)) return false;

  return Number(expiry) > now;
}

/** Verify the API key presented at sign-in, in constant time. */
export function isValidApiKey(candidate: string): boolean {
  if (!apiKey) return false;
  return timingSafeEqual(candidate, apiKey);
}

export function sessionCookieOptions(maxAgeSeconds = SESSION_TTL_MS / 1000) {
  return {
    httpOnly: true,
    // Blocks the cookie from being sent on cross-site requests, which is what
    // makes CSRF against the dashboard's own API calls impossible.
    sameSite: 'strict' as const,
    secure: isProduction,
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

/** Read the session cookie out of a raw Cookie header. */
export function readSessionCookie(request: Request): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) return undefined;

  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return rest.join('=');
  }
  return undefined;
}
