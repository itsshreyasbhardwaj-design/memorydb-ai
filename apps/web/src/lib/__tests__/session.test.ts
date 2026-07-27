/**
 * Session token tests.
 *
 * The token is the only thing standing between an attacker and a dashboard
 * session on a self-hosted deployment, so forgery, expiry, and tampering are
 * covered explicitly.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as SessionModule from '../session';

// The session module reads the resolved API key from env at import time, so it
// has to be set before the module graph is loaded.
process.env.MEMORYDB_API_KEY = 'mdb_test_UNITTESTKEY000000000000000000';

let session: typeof SessionModule;

beforeAll(async () => {
  session = await import('../session');
});

describe('createSessionToken', () => {
  it('produces an expiry.signature pair', async () => {
    const token = await session.createSessionToken();
    expect(token).toMatch(/^\d+\.[0-9a-f]{64}$/);
  });

  it('carries no secret material', async () => {
    const token = await session.createSessionToken();
    expect(token).not.toContain(process.env.MEMORYDB_API_KEY);
  });
});

describe('verifySessionToken', () => {
  it('accepts a freshly issued token', async () => {
    const token = await session.createSessionToken();
    expect(await session.verifySessionToken(token!)).toBe(true);
  });

  it('rejects a token whose expiry has passed', async () => {
    // Issued eight hours and one minute ago — just past the TTL.
    const token = await session.createSessionToken(Date.now() - 8 * 60 * 60 * 1000 - 60_000);
    expect(await session.verifySessionToken(token!)).toBe(false);
  });

  it('rejects a tampered expiry', async () => {
    const token = await session.createSessionToken();
    const [, signature] = token!.split('.');
    // Extend the expiry far into the future while keeping the old signature.
    const forged = `${Date.now() + 10 ** 10}.${signature}`;

    expect(await session.verifySessionToken(forged)).toBe(false);
  });

  it('rejects a tampered signature', async () => {
    const token = await session.createSessionToken();
    const [expiry] = token!.split('.');
    expect(await session.verifySessionToken(`${expiry}.${'0'.repeat(64)}`)).toBe(false);
  });

  it('rejects malformed input', async () => {
    for (const bad of ['', 'nonsense', 'no-dot-here', '.', 'abc.def', '123']) {
      expect(await session.verifySessionToken(bad)).toBe(false);
    }
  });

  it('rejects undefined', async () => {
    expect(await session.verifySessionToken(undefined)).toBe(false);
  });
});

describe('isValidApiKey', () => {
  it('accepts the configured key', () => {
    expect(session.isValidApiKey(process.env.MEMORYDB_API_KEY as string)).toBe(true);
  });

  it('rejects a wrong key of the same length', () => {
    const wrong = 'mdb_test_WRONGKEY0000000000000000000X'.slice(
      0,
      (process.env.MEMORYDB_API_KEY as string).length,
    );
    expect(session.isValidApiKey(wrong)).toBe(false);
  });

  it('rejects a prefix of the real key', () => {
    expect(session.isValidApiKey('mdb_test_')).toBe(false);
  });

  it('rejects an empty key', () => {
    expect(session.isValidApiKey('')).toBe(false);
  });
});

describe('readSessionCookie', () => {
  const withCookie = (value: string) =>
    new Request('http://localhost/', { headers: { cookie: value } });

  it('extracts the session cookie', () => {
    const request = withCookie(`${session.SESSION_COOKIE}=abc123`);
    expect(session.readSessionCookie(request)).toBe('abc123');
  });

  it('finds it among other cookies', () => {
    const request = withCookie(`theme=dark; ${session.SESSION_COOKIE}=xyz; other=1`);
    expect(session.readSessionCookie(request)).toBe('xyz');
  });

  it('preserves a value containing "="', () => {
    const request = withCookie(`${session.SESSION_COOKIE}=a=b=c`);
    expect(session.readSessionCookie(request)).toBe('a=b=c');
  });

  it('returns undefined when absent', () => {
    expect(session.readSessionCookie(withCookie('theme=dark'))).toBeUndefined();
    expect(session.readSessionCookie(new Request('http://localhost/'))).toBeUndefined();
  });
});

describe('sessionCookieOptions', () => {
  it('sets the flags that make the cookie safe', () => {
    const options = session.sessionCookieOptions();
    // HttpOnly keeps it away from scripts; SameSite=Strict blocks CSRF.
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe('strict');
    expect(options.path).toBe('/');
  });

  it('supports immediate expiry for sign-out', () => {
    expect(session.sessionCookieOptions(0).maxAge).toBe(0);
  });
});

describe('key rotation', () => {
  it('invalidates outstanding sessions when the key changes', async () => {
    const token = await session.createSessionToken();
    expect(await session.verifySessionToken(token!)).toBe(true);

    // Re-import the module with a different key, simulating a rotation.
    vi.resetModules();
    process.env.MEMORYDB_API_KEY = 'mdb_test_ROTATEDKEY0000000000000000000';
    const rotated = await import('../session');

    expect(await rotated.verifySessionToken(token!)).toBe(false);
  });
});
