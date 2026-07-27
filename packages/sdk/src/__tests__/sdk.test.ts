/**
 * TypeScript SDK tests.
 *
 * Driven by an injected `fetch` stub, so they need no server, no network, and
 * no database. They pin the contract that is easiest to break silently:
 * URL/header construction, retry policy, and error mapping.
 */
import { describe, expect, it, vi } from 'vitest';
import { MemoryDB, MemoryDBApiError } from '../index.js';

interface StubCall {
  url: string;
  init: RequestInit;
}

function stubFetch(
  responses: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>,
): { fetch: typeof fetch; calls: StubCall[] } {
  const calls: StubCall[] = [];
  let index = 0;

  const impl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    // Repeat the final response once the script is exhausted.
    const spec = responses[Math.min(index++, responses.length - 1)] ?? { status: 200, body: {} };
    return new Response(JSON.stringify(spec.body), {
      status: spec.status ?? 200,
      headers: { 'content-type': 'application/json', ...(spec.headers ?? {}) },
    });
  }) as unknown as typeof fetch;

  return { fetch: impl, calls };
}

const MEMORY = {
  id: 'mem_1',
  namespace: 'default',
  type: 'semantic',
  kind: 'note',
  status: 'active',
  content: 'Ada prefers dark mode.',
  summary: null,
  title: 'Preference',
  metadata: {},
  tags: ['people'],
  importance: 0.8,
  confidence: 1,
  embedding: null,
  embeddingModel: null,
  tokens: 6,
  accessCount: 0,
  lastAccessedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: null,
  archivedAt: null,
  supersededBy: null,
  userId: null,
  agentId: null,
  sessionId: null,
  sourceId: null,
  contentHash: 'abc',
  version: 1,
};

describe('MemoryDB SDK', () => {
  it('sends the API key and namespace headers', async () => {
    const { fetch, calls } = stubFetch([{ body: { data: { memory: MEMORY }, error: null } }]);
    const client = new MemoryDB({ apiKey: 'secret', namespace: 'tenant-a', fetch });

    await client.store({ content: 'hello' });

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer secret');
    expect(headers['x-namespace']).toBe('tenant-a');
    expect(calls[0]!.url).toBe('http://localhost:3000/api/v1/memories');
  });

  it('unwraps the response envelope', async () => {
    const { fetch } = stubFetch([
      { body: { data: { memory: MEMORY, deduplicated: false, entitiesExtracted: 1 }, error: null } },
    ]);
    const result = await new MemoryDB({ fetch }).store({ content: 'hello' });

    expect(result.memory.id).toBe('mem_1');
    expect(result.deduplicated).toBe(false);
  });

  it('serialises array query params as comma-separated values', async () => {
    const { fetch, calls } = stubFetch([{ body: { data: { items: [], total: 0 }, error: null } }]);

    await new MemoryDB({ fetch }).list({ type: ['semantic', 'episodic'], limit: 5 });

    expect(calls[0]!.url).toContain('type=semantic%2Cepisodic');
    expect(calls[0]!.url).toContain('limit=5');
  });

  it('omits undefined query params', async () => {
    const { fetch, calls } = stubFetch([{ body: { data: { items: [] }, error: null } }]);

    await new MemoryDB({ fetch }).list({ limit: 10 });

    expect(calls[0]!.url).not.toContain('undefined');
    expect(calls[0]!.url).not.toContain('offset=');
  });

  it('maps error responses to a typed error', async () => {
    const { fetch } = stubFetch([
      {
        status: 404,
        body: { error: { code: 'not_found', message: "memory 'x' was not found" }, requestId: 'evt_1' },
      },
    ]);

    const client = new MemoryDB({ fetch, maxRetries: 0 });
    await expect(client.get('x')).rejects.toThrow(MemoryDBApiError);

    try {
      await client.get('x');
    } catch (err) {
      const error = err as MemoryDBApiError;
      expect(error.status).toBe(404);
      expect(error.code).toBe('not_found');
      expect(error.requestId).toBe('evt_1');
    }
  });

  it('flags rate-limit errors', async () => {
    const { fetch } = stubFetch([
      { status: 429, body: { error: { code: 'rate_limited', message: 'slow down' } } },
    ]);

    try {
      await new MemoryDB({ fetch, maxRetries: 0 }).stats();
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as MemoryDBApiError).isRateLimit).toBe(true);
    }
  });

  it('retries transient failures then succeeds', async () => {
    const { fetch, calls } = stubFetch([
      { status: 503, body: { error: { code: 'storage_error', message: 'retry' } } },
      { status: 503, body: { error: { code: 'storage_error', message: 'retry' } } },
      { body: { data: { total: 7 }, error: null } },
    ]);

    const stats = await new MemoryDB({ fetch, maxRetries: 3 }).stats();

    expect(stats.total).toBe(7);
    expect(calls).toHaveLength(3);
  });

  it('does not retry a 4xx that cannot succeed', async () => {
    const { fetch, calls } = stubFetch([
      { status: 400, body: { error: { code: 'validation_error', message: 'bad' } } },
    ]);

    await expect(new MemoryDB({ fetch, maxRetries: 3 }).stats()).rejects.toThrow(MemoryDBApiError);
    expect(calls).toHaveLength(1);
  });

  it('bounds retries', async () => {
    const { fetch, calls } = stubFetch([
      { status: 500, body: { error: { code: 'internal_error', message: 'boom' } } },
    ]);

    await expect(new MemoryDB({ fetch, maxRetries: 2 }).stats()).rejects.toThrow();
    expect(calls).toHaveLength(3); // initial attempt + 2 retries
  });

  it('surfaces a network failure as a typed error', async () => {
    const failing = (async () => {
      throw new TypeError('connection refused');
    }) as unknown as typeof fetch;

    try {
      await new MemoryDB({ fetch: failing, maxRetries: 0 }).stats();
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as MemoryDBApiError).code).toBe('network_error');
      expect((err as MemoryDBApiError).retryable).toBe(true);
    }
  });

  it('times out a slow request', async () => {
    const slow = ((_url: string, init: RequestInit = {}) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })) as unknown as typeof fetch;

    try {
      await new MemoryDB({ fetch: slow, timeoutMs: 30, maxRetries: 0 }).stats();
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as MemoryDBApiError).code).toBe('timeout');
    }
  });

  it('returns the context string from the shorthand', async () => {
    const { fetch } = stubFetch([
      { body: { data: { hits: [], context: 'Relevant memories:\n\n[1] x', citations: [] }, error: null } },
    ]);

    const context = await new MemoryDB({ fetch }).context('query');
    expect(context).toContain('Relevant memories');
  });

  it('pages transparently when iterating', async () => {
    const { fetch } = stubFetch([
      { body: { data: { items: [MEMORY], total: 2, limit: 1, offset: 0, hasMore: true }, error: null } },
      { body: { data: { items: [MEMORY], total: 2, limit: 1, offset: 1, hasMore: false }, error: null } },
    ]);

    const collected = [];
    for await (const memory of new MemoryDB({ fetch }).iterate({ batchSize: 1 })) {
      collected.push(memory);
    }
    expect(collected).toHaveLength(2);
  });

  it('derives a namespace-scoped client sharing configuration', () => {
    const { fetch } = stubFetch([{ body: { data: {}, error: null } }]);
    const base = new MemoryDB({ apiKey: 'k', baseUrl: 'https://api.example.com', fetch });
    const scoped = base.forNamespace('tenant-b');

    expect(scoped).toBeInstanceOf(MemoryDB);
    expect(scoped).not.toBe(base);
  });

  it('rejects a non-JSON response with a clear message', async () => {
    const html = (async () =>
      new Response('<html>502 Bad Gateway</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof fetch;

    await expect(new MemoryDB({ fetch: html }).stats()).rejects.toThrow(/expected JSON/);
  });

  it('throws when no fetch implementation exists', () => {
    const original = globalThis.fetch;
    // @ts-expect-error deliberately removing the global for this assertion
    delete globalThis.fetch;
    try {
      expect(() => new MemoryDB()).toThrow(/No fetch implementation/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('honours Retry-After on a rate-limited response', async () => {
    const { fetch, calls } = stubFetch([
      { status: 429, body: { error: { code: 'rate_limited', message: 'slow' } }, headers: { 'retry-after': '0' } },
      { body: { data: { total: 1 }, error: null } },
    ]);

    const spy = vi.spyOn(globalThis, 'setTimeout');
    await new MemoryDB({ fetch, maxRetries: 2 }).stats();

    expect(calls).toHaveLength(2);
    spy.mockRestore();
  });
});
