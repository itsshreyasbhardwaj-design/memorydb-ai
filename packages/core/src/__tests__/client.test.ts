import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryClient } from '../client.js';
import { InMemoryStorageAdapter } from '../storage/memory-adapter.js';
import { NotFoundError, ValidationError } from '../errors.js';

async function makeClient(options: Partial<ConstructorParameters<typeof MemoryClient>[0]> = {}) {
  return MemoryClient.create({ storage: new InMemoryStorageAdapter(), namespace: 'test', ...options });
}

describe('MemoryClient — store', () => {
  let client: MemoryClient;
  beforeEach(async () => {
    client = await makeClient();
  });

  it('stores a memory with sensible defaults', async () => {
    const { memory, deduplicated } = await client.store({ content: 'Ada prefers dark mode.' });

    expect(deduplicated).toBe(false);
    expect(memory.id).toMatch(/^mem_/);
    expect(memory.namespace).toBe('test');
    expect(memory.type).toBe('long_term');
    expect(memory.kind).toBe('note');
    expect(memory.status).toBe('active');
    expect(memory.embedding).toHaveLength(384);
    expect(memory.tokens).toBeGreaterThan(0);
    expect(memory.contentHash).toHaveLength(64);
  });

  it('rejects empty content', async () => {
    await expect(client.store({ content: '' })).rejects.toThrow(ValidationError);
  });

  it('deduplicates identical content by default', async () => {
    const first = await client.store({ content: 'The deploy key rotates every 90 days.' });
    const second = await client.store({ content: 'The deploy key rotates every 90 days.' });

    expect(second.deduplicated).toBe(true);
    expect(second.memory.id).toBe(first.memory.id);
    expect(await client.count()).toBe(1);
  });

  it('treats whitespace and case differences as duplicates', async () => {
    await client.store({ content: 'Release train ships on Thursdays' });
    const second = await client.store({ content: '  release   train ships on THURSDAYS  ' });
    expect(second.deduplicated).toBe(true);
  });

  it('can opt out of deduplication', async () => {
    await client.store({ content: 'repeated note' });
    const second = await client.store({ content: 'repeated note', deduplicate: false });
    expect(second.deduplicated).toBe(false);
    expect(await client.count()).toBe(2);
  });

  it('scopes deduplication per user', async () => {
    await client.store({ content: 'favourite colour is blue', userId: 'u1' });
    const other = await client.store({ content: 'favourite colour is blue', userId: 'u2' });
    expect(other.deduplicated).toBe(false);
  });

  it('applies retention TTL from the memory type', async () => {
    const shortTerm = await client.store({ content: 'temporary scratch', type: 'short_term' });
    const semantic = await client.store({ content: 'durable fact', type: 'semantic' });

    expect(shortTerm.memory.expiresAt).not.toBeNull();
    expect(semantic.memory.expiresAt).toBeNull();
  });

  it('honours an explicit ttlSeconds override', async () => {
    const { memory } = await client.store({ content: 'expires soon', type: 'semantic', ttlSeconds: 60 });
    expect(memory.expiresAt).not.toBeNull();
    const remaining = Date.parse(memory.expiresAt!) - Date.now();
    expect(remaining).toBeGreaterThan(50_000);
    expect(remaining).toBeLessThanOrEqual(60_000);
  });

  it('assigns higher default importance to procedural than short-term memory', async () => {
    const procedural = await client.store({ content: 'How to rotate the signing key', type: 'procedural' });
    const shortTerm = await client.store({ content: 'user is currently on step 2', type: 'short_term' });
    expect(procedural.memory.importance).toBeGreaterThan(shortTerm.memory.importance);
  });

  it('chunks long content when asked', async () => {
    const long = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} about distributed consensus protocols and their trade-offs in production systems.`).join('\n\n');
    const result = await client.store({ content: long, chunk: true });

    expect(result.chunks!.length).toBeGreaterThan(1);
    for (const chunk of result.chunks!) {
      expect(chunk.metadata.parentId).toBe(result.memory.id);
      expect(chunk.embedding).toHaveLength(384);
    }
  });

  it('stores many memories in one batched call', async () => {
    const results = await client.storeMany([
      { content: 'first fact' },
      { content: 'second fact' },
      { content: 'first fact' },
    ]);

    expect(results).toHaveLength(3);
    expect(results[2]!.deduplicated).toBe(true);
    expect(results[2]!.memory.id).toBe(results[0]!.memory.id);
    expect(await client.count()).toBe(2);
  });
});

describe('MemoryClient — read, update, delete', () => {
  let client: MemoryClient;
  beforeEach(async () => {
    client = await makeClient();
  });

  it('round-trips a memory by id', async () => {
    const { memory } = await client.store({ content: 'round trip me' });
    const fetched = await client.get(memory.id);
    expect(fetched?.content).toBe('round trip me');
  });

  it('returns null for an unknown id', async () => {
    expect(await client.get('mem_missing')).toBeNull();
  });

  it('updates content and re-embeds', async () => {
    const { memory } = await client.store({ content: 'original content about cats' });
    const before = memory.embedding!.slice();

    const updated = await client.update(memory.id, { content: 'entirely different text about spacecraft' });

    expect(updated.content).toBe('entirely different text about spacecraft');
    expect(updated.version).toBe(2);
    expect(updated.embedding).not.toEqual(before);
    expect(updated.contentHash).not.toBe(memory.contentHash);
  });

  it('supports incremental tag edits', async () => {
    const { memory } = await client.store({ content: 'tagged memory', tags: ['a', 'b'] });
    const updated = await client.update(memory.id, { addTags: ['c'], removeTags: ['a'] });
    expect(updated.tags.sort()).toEqual(['b', 'c']);
  });

  it('merges metadata rather than replacing it', async () => {
    const { memory } = await client.store({ content: 'meta', metadata: { source: 'slack', team: 'infra' } });
    const updated = await client.update(memory.id, { metadata: { team: 'platform' } });
    expect(updated.metadata).toEqual({ source: 'slack', team: 'platform' });
  });

  it('throws NotFoundError when updating a missing memory', async () => {
    await expect(client.update('mem_nope', { content: 'x' })).rejects.toThrow(NotFoundError);
  });

  it('rejects an empty update', async () => {
    const { memory } = await client.store({ content: 'x' });
    await expect(client.update(memory.id, {})).rejects.toThrow(ValidationError);
  });

  it('soft-deletes by default and hides the memory from queries', async () => {
    const { memory } = await client.store({ content: 'soft delete me' });
    expect(await client.delete(memory.id)).toBe(true);

    expect(await client.count()).toBe(0);
    const raw = await client.get(memory.id);
    expect(raw?.status).toBe('deleted');
  });

  it('hard-deletes when requested', async () => {
    const { memory } = await client.store({ content: 'hard delete me' });
    await client.delete(memory.id, true);
    expect(await client.get(memory.id)).toBeNull();
  });

  it('allows re-storing content after a soft delete', async () => {
    const { memory } = await client.store({ content: 'recreate me' });
    await client.delete(memory.id);
    const again = await client.store({ content: 'recreate me' });
    expect(again.deduplicated).toBe(false);
  });
});

describe('MemoryClient — list and filter', () => {
  let client: MemoryClient;

  beforeEach(async () => {
    client = await makeClient();
    await client.storeMany([
      { content: 'infra runbook for failover', type: 'procedural', tags: ['infra', 'ops'], userId: 'u1' },
      { content: 'user prefers metric units', type: 'semantic', tags: ['prefs'], userId: 'u1', importance: 0.9 },
      { content: 'standup notes from Tuesday', type: 'episodic', tags: ['notes'], userId: 'u2' },
      { content: 'draft plan for Q3 roadmap', type: 'long_term', tags: ['infra', 'planning'], userId: 'u2' },
    ]);
  });

  it('lists everything by default', async () => {
    const page = await client.list();
    expect(page.total).toBe(4);
    expect(page.hasMore).toBe(false);
  });

  it('filters by type', async () => {
    const page = await client.list({ filter: { type: ['procedural', 'semantic'] } });
    expect(page.total).toBe(2);
  });

  it('filters by userId', async () => {
    const page = await client.list({ filter: { userId: 'u1' } });
    expect(page.total).toBe(2);
  });

  it('requires all tags with `tags` and any with `anyTags`', async () => {
    expect((await client.list({ filter: { tags: ['infra', 'planning'] } })).total).toBe(1);
    expect((await client.list({ filter: { anyTags: ['infra', 'notes'] } })).total).toBe(3);
  });

  it('filters by minimum importance', async () => {
    const page = await client.list({ filter: { minImportance: 0.85 } });
    expect(page.total).toBe(1);
    expect(page.items[0]!.content).toContain('metric units');
  });

  it('paginates', async () => {
    const page = await client.list({ limit: 2, offset: 0 });
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);

    const next = await client.list({ limit: 2, offset: 2 });
    expect(next.hasMore).toBe(false);
  });

  it('sorts by importance descending', async () => {
    const page = await client.list({ sortBy: 'importance', sortDir: 'desc' });
    expect(page.items[0]!.importance).toBeGreaterThanOrEqual(page.items[1]!.importance);
  });

  it('supports metadata operators', async () => {
    await client.store({ content: 'scored item', metadata: { score: 42, channel: 'email' } });

    expect((await client.list({ filter: { metadata: { score: { gt: 40 } } } })).total).toBe(1);
    expect((await client.list({ filter: { metadata: { score: { lt: 40 } } } })).total).toBe(0);
    expect((await client.list({ filter: { metadata: { channel: 'email' } } })).total).toBe(1);
    expect((await client.list({ filter: { metadata: { channel: { in: ['email', 'sms'] } } } })).total).toBe(1);
    expect((await client.list({ filter: { metadata: { missing: { exists: false } } } })).total).toBe(5);
  });
});

describe('MemoryClient — search and retrieve', () => {
  let client: MemoryClient;

  beforeEach(async () => {
    client = await makeClient();
    await client.storeMany([
      { content: 'The production database runs PostgreSQL 16 with pgvector for embeddings.', tags: ['db'] },
      { content: 'Deployments go out through GitHub Actions to Vercel every Thursday.', tags: ['ci'] },
      { content: 'Ada Lovelace leads the platform team and prefers async written updates.', tags: ['people'] },
      { content: 'Our incident retro process requires a blameless writeup within 48 hours.', tags: ['process'] },
      { content: 'Redis caches search results with a sixty second TTL.', tags: ['db'] },
    ]);
  });

  it('finds semantically relevant memories', async () => {
    const result = await client.search({ query: 'what database do we use?' });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]!.memory.content).toMatch(/PostgreSQL|Redis/);
  });

  it('finds memories by exact keyword', async () => {
    const result = await client.search({ query: 'pgvector', mode: 'keyword' });
    expect(result.hits[0]!.memory.content).toContain('pgvector');
  });

  it('supports semantic-only mode', async () => {
    const result = await client.search({ query: 'caching layer', mode: 'semantic' });
    expect(result.mode).toBe('semantic');
    expect(result.hits.length).toBeGreaterThan(0);
  });

  it('returns scores in the unit interval, ordered descending', async () => {
    const result = await client.search({ query: 'deployment pipeline' });
    for (const hit of result.hits) {
      expect(hit.score).toBeGreaterThanOrEqual(0);
      expect(hit.score).toBeLessThanOrEqual(1);
    }
    const scores = result.hits.map((hit) => hit.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('attaches a citation with a matching snippet', async () => {
    const result = await client.search({ query: 'pgvector embeddings' });
    const citation = result.hits[0]!.citation;
    expect(citation.memoryId).toBe(result.hits[0]!.memory.id);
    expect(citation.snippet.length).toBeGreaterThan(0);
    expect(citation.span).not.toBeNull();
  });

  it('exposes a score breakdown when explain is set', async () => {
    const result = await client.search({ query: 'database', explain: true });
    const scores = result.hits[0]!.scores;
    expect(scores).toBeDefined();
    expect(scores!.final).toBeCloseTo(result.hits[0]!.score, 6);
    expect(scores).toHaveProperty('vector');
    expect(scores).toHaveProperty('keyword');
    expect(scores).toHaveProperty('recency');
  });

  it('applies filters during search', async () => {
    const result = await client.search({ query: 'database', filter: { tags: ['db'] } });
    expect(result.hits.every((hit) => hit.memory.tags.includes('db'))).toBe(true);
  });

  it('respects the limit', async () => {
    const result = await client.search({ query: 'the', limit: 2 });
    expect(result.hits.length).toBeLessThanOrEqual(2);
  });

  it('returns no hits for a query matching nothing', async () => {
    const result = await client.search({ query: 'zzzz nonexistent quantum flux capacitor', minScore: 0.5 });
    expect(result.hits).toHaveLength(0);
  });

  it('builds a formatted context block with citation markers', async () => {
    const result = await client.retrieve({ query: 'how do we deploy?', limit: 3 });

    expect(result.context).toContain('Relevant memories:');
    expect(result.context).toContain('[1]');
    expect(result.citations.length).toBe(result.hits.length);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('enforces the token budget', async () => {
    const result = await client.retrieve({ query: 'database deployment team', tokenBudget: 20 });
    expect(result.tokensUsed).toBeLessThanOrEqual(20);
  });

  it('drops near-duplicate hits when diversifying', async () => {
    const fresh = await makeClient();
    for (let i = 0; i < 5; i++) {
      await fresh.store({ content: `The API rate limit is 1000 requests per minute. Note ${i}.`, deduplicate: false });
    }
    await fresh.store({ content: 'Completely unrelated: the office plant needs watering weekly.' });

    const diversified = await fresh.retrieve({ query: 'rate limit', diversify: true, limit: 10 });
    const raw = await fresh.retrieve({ query: 'rate limit', diversify: false, limit: 10 });

    expect(diversified.hits.length).toBeLessThan(raw.hits.length);
    expect(diversified.dropped).toBeGreaterThan(0);
  });

  it('tracks access counts when asked', async () => {
    const result = await client.search({ query: 'PostgreSQL', trackAccess: true, limit: 1 });
    const id = result.hits[0]!.memory.id;

    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = await client.get(id);
    expect(after!.accessCount).toBeGreaterThan(0);
  });

  it('rejects an empty query', async () => {
    await expect(client.search({ query: '' })).rejects.toThrow(ValidationError);
  });
});

describe('MemoryClient — namespaces', () => {
  it('isolates memories between namespaces', async () => {
    const storage = new InMemoryStorageAdapter();
    const alpha = await MemoryClient.create({ storage, namespace: 'alpha' });
    const beta = await MemoryClient.create({ storage, namespace: 'beta' });

    await alpha.store({ content: 'alpha secret' });
    await beta.store({ content: 'beta secret' });

    expect(await alpha.count()).toBe(1);
    expect(await beta.count()).toBe(1);

    const alphaSearch = await alpha.search({ query: 'secret' });
    expect(alphaSearch.hits.every((hit) => hit.memory.content.includes('alpha'))).toBe(true);
  });

  it('derives a scoped client with forNamespace', async () => {
    const client = await makeClient();
    await client.store({ content: 'in default' });

    const scoped = client.forNamespace('other');
    expect(scoped.namespace).toBe('other');
    expect(await scoped.count()).toBe(0);
  });
});

describe('MemoryClient — maintenance', () => {
  it('reports health', async () => {
    const client = await makeClient();
    const health = await client.health();
    expect(health.ok).toBe(true);
    expect(health.embeddings.dimensions).toBe(384);
  });

  it('purges expired memories', async () => {
    const client = await makeClient();
    await client.store({ content: 'already gone', expiresAt: new Date(Date.now() - 1000).toISOString() });
    await client.store({ content: 'still here' });

    expect(await client.purgeExpired()).toBe(1);
    expect(await client.count()).toBe(1);
  });

  it('hides expired memories from queries before they are purged', async () => {
    const client = await makeClient();
    await client.store({ content: 'expired item', expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(await client.count()).toBe(0);
  });

  it('backfills embeddings with reindex', async () => {
    const client = await MemoryClient.create({
      storage: new InMemoryStorageAdapter(),
      namespace: 'test',
      autoEmbed: false,
    });

    await client.store({ content: 'needs an embedding' });
    expect((await client.list()).items[0]!.embedding).toBeNull();

    const updated = await client.reindex();
    expect(updated).toBe(1);
    expect((await client.list()).items[0]!.embedding).toHaveLength(384);
  });

  it('reports statistics', async () => {
    const client = await makeClient();
    await client.storeMany([
      { content: 'one', type: 'semantic', tags: ['x'] },
      { content: 'two', type: 'semantic', tags: ['x', 'y'] },
      { content: 'three', type: 'episodic', tags: ['y'] },
    ]);

    const stats = await client.stats();
    expect(stats.total).toBe(3);
    expect(stats.active).toBe(3);
    expect(stats.byType.semantic).toBe(2);
    expect(stats.byType.episodic).toBe(1);
    expect(stats.totalTokens).toBeGreaterThan(0);
    expect(stats.growth.length).toBe(30);
    expect(stats.topTags[0]).toEqual({ tag: expect.any(String), count: 2 });
  });
});
