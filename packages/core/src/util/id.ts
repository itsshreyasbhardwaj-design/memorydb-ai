/**
 * Identifier generation.
 *
 * IDs are prefixed, k-sortable, and URL-safe: `mem_01JAV7X4K2Q8ZB3N5Y6R7T8W9V`.
 * The 48-bit millisecond timestamp prefix means IDs sort chronologically as
 * plain strings, which keeps B-tree index inserts append-only.
 */

/** Crockford base32 — no I, L, O, or U, so IDs survive being read aloud. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export type IdPrefix = 'mem' | 'ent' | 'rel' | 'ns' | 'key' | 'usr' | 'evt' | 'job' | 'cls';

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function encodeTime(ms: number): string {
  let out = '';
  let value = ms;
  for (let i = 9; i >= 0; i--) {
    out = CROCKFORD[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeRandom(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const byte of bytes) out += CROCKFORD[byte % 32];
  return out;
}

/**
 * ULID-style identifier: 10 chars of timestamp + 16 chars of entropy.
 * Monotonic within a millisecond is not guaranteed, but 80 bits of randomness
 * makes intra-millisecond collision negligible.
 */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom(16);
}

export function generateId(prefix: IdPrefix, now: number = Date.now()): string {
  return `${prefix}_${ulid(now)}`;
}

/** Extract the creation timestamp encoded in a generated id, if parseable. */
export function timestampFromId(id: string): number | null {
  const raw = id.includes('_') ? id.slice(id.indexOf('_') + 1) : id;
  if (raw.length < 10) return null;
  let value = 0;
  for (let i = 0; i < 10; i++) {
    const index = CROCKFORD.indexOf(raw[i] as string);
    if (index < 0) return null;
    value = value * 32 + index;
  }
  return value;
}

/**
 * A high-entropy secret suitable for an API key. Returned raw to the caller
 * exactly once; only its SHA-256 digest is ever persisted.
 */
export function generateSecret(bytes = 32): string {
  const buf = randomBytes(bytes);
  let out = '';
  for (const byte of buf) out += CROCKFORD[byte % 32];
  return out;
}

export function generateApiKey(environment: 'live' | 'test' = 'live'): string {
  return `mdb_${environment}_${generateSecret(32)}`;
}
