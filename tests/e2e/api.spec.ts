/**
 * API end-to-end tests.
 *
 * These exercise the real HTTP surface against a running production build —
 * middleware, auth, rate limiting, validation, and serialisation included.
 */
import { expect, test } from '@playwright/test';

const API_KEY = 'mdb_test_E2EKEYNOTUSEDANYWHEREELSE0000';
const auth = { authorization: `Bearer ${API_KEY}` };

test.describe('health', () => {
  test('is reachable without authentication', async ({ request }) => {
    const response = await request.get('/api/v1/health');
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body.status).toBe('healthy');
    expect(body.checks.storage.ok).toBe(true);
    expect(body.checks.embeddings.dimensions).toBe(384);
  });
});

test.describe('authentication', () => {
  test('rejects an unauthenticated request', async ({ request }) => {
    const response = await request.get('/api/v1/stats');
    expect(response.status()).toBe(401);
    expect((await response.json()).error.code).toBe('unauthorized');
  });

  test('rejects an invalid key', async ({ request }) => {
    const response = await request.get('/api/v1/stats', {
      headers: { authorization: 'Bearer definitely-not-the-key' },
    });
    expect(response.status()).toBe(401);
  });

  test('accepts a valid key via either header', async ({ request }) => {
    expect((await request.get('/api/v1/stats', { headers: auth })).ok()).toBeTruthy();
    expect(
      (await request.get('/api/v1/stats', { headers: { 'x-api-key': API_KEY } })).ok(),
    ).toBeTruthy();
  });

  test('rejects a malformed namespace', async ({ request }) => {
    const response = await request.get('/api/v1/stats', {
      headers: { ...auth, 'x-namespace': 'bad namespace!' },
    });
    expect(response.status()).toBe(403);
  });
});

test.describe('memory lifecycle', () => {
  test('creates, reads, searches, updates, and deletes', async ({ request }) => {
    const namespace = `e2e-${Date.now()}`;
    const headers = { ...auth, 'x-namespace': namespace };

    // Create
    const created = await request.post('/api/v1/memories', {
      headers,
      data: {
        content: 'The staging cluster runs Kubernetes 1.31 with Cilium for networking.',
        type: 'semantic',
        title: 'Staging cluster',
        tags: ['infra', 'k8s'],
        importance: 0.8,
      },
    });
    expect(created.status()).toBe(201);

    const { data } = await created.json();
    const id = data.memory.id;
    expect(id).toMatch(/^mem_/);
    expect(data.memory.embedding).toHaveLength(384);
    expect(data.deduplicated).toBe(false);

    // Read
    const fetched = await request.get(`/api/v1/memories/${id}`, { headers });
    expect((await fetched.json()).data.memory.title).toBe('Staging cluster');

    // Search finds it
    const searched = await request.post('/api/v1/search', {
      headers,
      data: { query: 'kubernetes staging cluster', explain: true },
    });
    const results = (await searched.json()).data;
    expect(results.hits.length).toBeGreaterThan(0);
    expect(results.hits[0].memory.id).toBe(id);
    expect(results.hits[0].scores).toHaveProperty('vector');

    // Update
    const updated = await request.patch(`/api/v1/memories/${id}`, {
      headers,
      data: { addTags: ['networking'], importance: 0.95 },
    });
    const updatedMemory = (await updated.json()).data.memory;
    expect(updatedMemory.tags).toContain('networking');
    expect(updatedMemory.importance).toBe(0.95);
    expect(updatedMemory.version).toBe(2);

    // Delete
    expect((await request.delete(`/api/v1/memories/${id}`, { headers })).ok()).toBeTruthy();
    expect((await request.get(`/api/v1/memories/${id}`, { headers })).status()).toBe(404);
  });

  test('deduplicates identical content', async ({ request }) => {
    const headers = { ...auth, 'x-namespace': `e2e-dedupe-${Date.now()}` };
    const data = { content: 'A fact that will be written twice.' };

    const first = await request.post('/api/v1/memories', { headers, data });
    const second = await request.post('/api/v1/memories', { headers, data });

    const firstBody = (await first.json()).data;
    const secondBody = (await second.json()).data;

    expect(secondBody.deduplicated).toBe(true);
    expect(secondBody.memory.id).toBe(firstBody.memory.id);
  });

  test('isolates namespaces', async ({ request }) => {
    const stamp = Date.now();
    const alpha = { ...auth, 'x-namespace': `e2e-alpha-${stamp}` };
    const beta = { ...auth, 'x-namespace': `e2e-beta-${stamp}` };

    await request.post('/api/v1/memories', {
      headers: alpha,
      data: { content: 'A secret that belongs only to alpha.' },
    });

    const betaSearch = await request.post('/api/v1/search', {
      headers: beta,
      data: { query: 'secret belongs alpha' },
    });
    expect((await betaSearch.json()).data.hits).toHaveLength(0);
  });
});

test.describe('validation', () => {
  test('rejects empty content', async ({ request }) => {
    const response = await request.post('/api/v1/memories', {
      headers: auth,
      data: { content: '' },
    });
    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe('validation_error');
  });

  test('rejects malformed JSON', async ({ request }) => {
    const response = await request.post('/api/v1/memories', {
      headers: { ...auth, 'content-type': 'application/json' },
      data: '{ not valid json',
    });
    expect(response.status()).toBe(400);
  });

  test('rejects an out-of-range importance', async ({ request }) => {
    const response = await request.post('/api/v1/memories', {
      headers: auth,
      data: { content: 'x', importance: 5 },
    });
    expect(response.status()).toBe(400);
  });

  test('requires a filter for bulk delete', async ({ request }) => {
    const response = await request.delete('/api/v1/memories', {
      headers: auth,
      data: { filter: {} },
    });
    expect(response.status()).toBe(400);
  });
});

test.describe('retrieval', () => {
  test('returns context with citations within a token budget', async ({ request }) => {
    const headers = { ...auth, 'x-namespace': `e2e-retrieve-${Date.now()}` };

    await request.post('/api/v1/memories', {
      headers,
      data: {
        memories: [
          { content: 'Backups run nightly at 02:00 UTC and are retained for 30 days.', tags: ['ops'] },
          { content: 'The on-call rotation changes every Monday at 09:00.', tags: ['ops'] },
          { content: 'Espresso machine descaling is due every 90 days.', tags: ['office'] },
        ],
      },
    });

    const response = await request.post('/api/v1/retrieve', {
      headers,
      data: { query: 'when do backups run?', tokenBudget: 500 },
    });

    const result = (await response.json()).data;
    expect(result.context).toContain('Relevant memories:');
    expect(result.context).toContain('[1]');
    expect(result.tokensUsed).toBeLessThanOrEqual(500);
    expect(result.citations.length).toBe(result.hits.length);
    expect(result.hits[0].memory.content).toContain('Backups');
  });

  test('returns nothing for a query with no real matches', async ({ request }) => {
    const headers = { ...auth, 'x-namespace': `e2e-nomatch-${Date.now()}` };
    await request.post('/api/v1/memories', {
      headers,
      data: { content: 'Some entirely unrelated content about gardening.' },
    });

    const response = await request.post('/api/v1/search', {
      headers,
      data: { query: 'zzzz nonexistent quantum flux capacitor', minScore: 0.5 },
    });
    expect((await response.json()).data.hits).toHaveLength(0);
  });
});

test.describe('knowledge graph', () => {
  test('extracts entities and relations automatically', async ({ request }) => {
    const headers = { ...auth, 'x-namespace': `e2e-graph-${Date.now()}` };

    await request.post('/api/v1/memories', {
      headers,
      data: {
        content:
          'Grace Hopper works at Remington Rand and leads the COBOL project using TypeScript and PostgreSQL.',
      },
    });

    const graph = (await (await request.get('/api/v1/graph', { headers })).json()).data;
    expect(graph.nodes.length).toBeGreaterThan(0);

    const names = graph.nodes.map((node: { name: string }) => node.name.toLowerCase());
    expect(names.some((name: string) => name.includes('grace'))).toBe(true);
    expect(names.some((name: string) => name.includes('postgresql'))).toBe(true);
  });
});

test.describe('import and export', () => {
  test('round-trips through JSON', async ({ request }) => {
    const stamp = Date.now();
    const source = { ...auth, 'x-namespace': `e2e-export-${stamp}` };
    const target = { ...auth, 'x-namespace': `e2e-import-${stamp}` };

    await request.post('/api/v1/memories', {
      headers: source,
      data: { memories: [{ content: 'Exported memory one.' }, { content: 'Exported memory two.' }] },
    });

    const exported = await request.get('/api/v1/batch/export?format=json', { headers: source });
    expect(exported.ok()).toBeTruthy();
    expect(exported.headers()['x-memorydb-count']).toBe('2');

    const imported = await request.post('/api/v1/batch/import?format=json', {
      headers: { ...target, 'content-type': 'application/json' },
      data: await exported.text(),
    });

    const result = (await imported.json()).data;
    expect(result.imported).toBe(2);
    expect(result.failed).toBe(0);
  });

  test('exports a valid ZIP archive', async ({ request }) => {
    const response = await request.get('/api/v1/batch/export?format=zip&includeGraph=true', {
      headers: auth,
    });

    expect(response.headers()['content-type']).toBe('application/zip');
    const body = await response.body();
    // Local file header signature: PK\x03\x04
    expect(body[0]).toBe(0x50);
    expect(body[1]).toBe(0x4b);
  });
});

test.describe('openapi', () => {
  test('serves a valid 3.1 specification', async ({ request }) => {
    const spec = await (await request.get('/api/v1/openapi')).json();

    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title).toBe('MemoryDB AI');
    expect(Object.keys(spec.paths).length).toBeGreaterThan(10);
    expect(spec.components.securitySchemes).toHaveProperty('bearerAuth');
  });
});

test.describe('response headers', () => {
  test('includes rate-limit and request-id headers', async ({ request }) => {
    const headers = (await request.get('/api/v1/stats', { headers: auth })).headers();

    expect(headers['ratelimit-limit']).toBeDefined();
    expect(headers['ratelimit-remaining']).toBeDefined();
    expect(headers['x-request-id']).toMatch(/^evt_/);
  });

  test('applies security headers', async ({ request }) => {
    const headers = (await request.get('/')).headers();

    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  test('marks API responses as uncacheable', async ({ request }) => {
    const headers = (await request.get('/api/v1/stats', { headers: auth })).headers();
    expect(headers['cache-control']).toContain('no-store');
  });
});
