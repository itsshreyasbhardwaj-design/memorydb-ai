/**
 * Postgres adapter tests.
 *
 * These run against a recording fake driver rather than a live database, which
 * lets CI verify the parts that are easy to get wrong and expensive to debug in
 * production: that every user-supplied value is bound as a placeholder (so
 * injection is structurally impossible), that filters compile to the intended
 * predicates, and that rows map back to domain objects correctly.
 *
 * `tests/integration/postgres.test.ts` exercises the same adapter against a
 * real PostgreSQL instance when `DATABASE_URL` is set.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { PostgresStorageAdapter, type SqlDriver } from '../storage/postgres-adapter.js';
import type { Memory } from '../types.js';

interface RecordedQuery {
  text: string;
  params: unknown[];
}

class FakeDriver implements SqlDriver {
  readonly queries: RecordedQuery[] = [];
  private responses: Array<{ rows: unknown[] }> = [];

  respondWith(rows: unknown[]): void {
    this.responses.push({ rows });
  }

  async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
    this.queries.push({ text, params });
    // A real `SET` returns no result set, so it must not consume a queued
    // response — otherwise session tuning would swallow the row data.
    if (text.trim().toLowerCase().startsWith('set ')) {
      return { rows: [] as T[], rowCount: 0 };
    }
    const response = this.responses.shift();
    return { rows: (response?.rows ?? []) as T[], rowCount: response?.rows.length ?? 0 };
  }

  /** The last query, ignoring the `set local` session tweaks. */
  get lastMeaningful(): RecordedQuery {
    for (let i = this.queries.length - 1; i >= 0; i--) {
      const query = this.queries[i]!;
      if (!query.text.trim().startsWith('set local')) return query;
    }
    throw new Error('no queries recorded');
  }

  find(fragment: string): RecordedQuery | undefined {
    return this.queries.find((q) => q.text.includes(fragment));
  }
}

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: 'mem_1', namespace: 'ns', userId: null, agentId: null, sessionId: null,
    type: 'semantic', kind: 'note', status: 'active',
    content: 'content', summary: null, title: null,
    metadata: {}, tags: [], importance: 0.5, confidence: 1,
    embedding: null, embeddingModel: null, tokens: 1, accessCount: 0, lastAccessedAt: null,
    createdAt: now, updatedAt: now, expiresAt: null, archivedAt: null,
    supersededBy: null, sourceId: null, contentHash: 'hash', version: 1,
    ...overrides,
  };
}

describe('PostgresStorageAdapter', () => {
  let driver: FakeDriver;
  let adapter: PostgresStorageAdapter;

  beforeEach(() => {
    driver = new FakeDriver();
    adapter = new PostgresStorageAdapter({ driver, dimensions: 4, autoCreateNamespace: false });
  });

  describe('injection safety', () => {
    it('binds a malicious namespace as a parameter, never as SQL text', async () => {
      const malicious = "ns'; drop table memories; --";
      await adapter.countMemories(malicious);

      const query = driver.lastMeaningful;
      expect(query.text).not.toContain('drop table');
      expect(query.params).toContain(malicious);
      expect(query.text).toMatch(/namespace = \$\d+/);
    });

    it('binds a malicious search query as a parameter', async () => {
      await adapter.keywordSearch('ns', { query: "'; delete from memories where '1'='1", limit: 10 });

      const query = driver.lastMeaningful;
      expect(query.text).not.toContain('delete from memories');
      expect(query.params).toContain("'; delete from memories where '1'='1");
    });

    it('binds malicious tag values', async () => {
      await adapter.countMemories('ns', { tags: ["'); drop table entities; --"] });

      const query = driver.lastMeaningful;
      expect(query.text).not.toContain('drop table');
      expect(query.text).toMatch(/tags @> \$\d+::text\[\]/);
    });

    it('binds malicious metadata paths', async () => {
      await adapter.countMemories('ns', { metadata: { "evil'; drop--": 1 } });

      const query = driver.lastMeaningful;
      expect(query.text).not.toContain('drop--');
      expect(JSON.stringify(query.params)).toContain('evil');
    });

    it('never interpolates a sort direction or column directly from input', async () => {
      await adapter.listMemories('ns', {
        limit: 10, offset: 0, sortBy: 'importance', sortDir: 'asc',
      });
      // Only whitelisted identifiers reach the ORDER BY clause.
      expect(driver.lastMeaningful.text).toContain('order by m.importance asc');
    });
  });

  describe('filter compilation', () => {
    it('excludes deleted, superseded, archived, and expired rows by default', async () => {
      await adapter.countMemories('ns');
      const sql = driver.lastMeaningful.text;

      expect(sql).toContain("status <> 'deleted'");
      expect(sql).toContain("status <> 'superseded'");
      expect(sql).toContain("status <> 'archived'");
      expect(sql).toContain('expires_at > now()');
    });

    it('includes archived rows when requested', async () => {
      await adapter.countMemories('ns', { includeArchived: true });
      expect(driver.lastMeaningful.text).not.toContain("status <> 'archived'");
    });

    it('includes expired rows when requested', async () => {
      await adapter.countMemories('ns', { includeExpired: true });
      expect(driver.lastMeaningful.text).not.toContain('expires_at > now()');
    });

    it('uses array containment for all-tags and overlap for any-tags', async () => {
      await adapter.countMemories('ns', { tags: ['a'], anyTags: ['b'] });
      const sql = driver.lastMeaningful.text;

      expect(sql).toMatch(/tags @> \$\d+::text\[\]/);
      expect(sql).toMatch(/tags && \$\d+::text\[\]/);
    });

    it('casts metadata numeric comparisons out of jsonb', async () => {
      await adapter.countMemories('ns', { metadata: { score: { gte: 10 } } });
      const query = driver.lastMeaningful;

      expect(query.text).toContain('::numeric >=');
      expect(query.params).toContain(10);
    });

    it('compiles metadata existence checks to null tests', async () => {
      await adapter.countMemories('ns', { metadata: { maybe: { exists: false } } });
      expect(driver.lastMeaningful.text).toContain('is null');
    });

    it('resolves dotted metadata paths to a jsonb path array', async () => {
      await adapter.countMemories('ns', { metadata: { 'source.channel': 'email' } });
      const query = driver.lastMeaningful;

      expect(query.text).toContain('metadata #>');
      expect(query.params).toContainEqual(['source', 'channel']);
    });
  });

  describe('vector search', () => {
    it('orders by cosine distance and reports similarity', async () => {
      driver.respondWith([{ id: 'mem_1', similarity: 0.8 }]);
      const results = await adapter.vectorSearch('ns', { embedding: [1, 0, 0, 0], limit: 5 });

      const query = driver.lastMeaningful;
      expect(query.text).toContain('<=>');
      expect(query.text).toContain('order by m.embedding <=>');
      expect(query.params).toContain('[1,0,0,0]');
      expect(results).toEqual([{ id: 'mem_1', score: 0.8 }]);
    });

    it('rejects an embedding whose width does not match the column', async () => {
      await expect(
        adapter.vectorSearch('ns', { embedding: [1, 2, 3], limit: 5 }),
      ).rejects.toThrow(/3 dimensions but the column is vector\(4\)/);
    });

    it('applies an absolute similarity floor when given one', async () => {
      await adapter.vectorSearch('ns', { embedding: [1, 0, 0, 0], limit: 5, minSimilarity: 0.5 });
      expect(driver.lastMeaningful.text).toContain('1 - (m.embedding <=>');
      expect(driver.lastMeaningful.params).toContain(0.5);
    });

    it('raises ef_search for recall before querying', async () => {
      await adapter.vectorSearch('ns', { embedding: [1, 0, 0, 0], limit: 5 });
      expect(driver.find('hnsw.ef_search')).toBeDefined();
    });
  });

  describe('keyword search', () => {
    it('uses websearch_to_tsquery against the generated tsvector', async () => {
      driver.respondWith([{ id: 'mem_1', rank: 0.4 }]);
      const results = await adapter.keywordSearch('ns', { query: 'hello world', limit: 5 });

      const sql = driver.lastMeaningful.text;
      expect(sql).toContain('websearch_to_tsquery');
      expect(sql).toContain('search_vector @@');
      expect(sql).toContain('ts_rank_cd');
      expect(results).toEqual([{ id: 'mem_1', score: 0.4 }]);
    });
  });

  describe('row mapping', () => {
    it('maps snake_case columns onto the domain model', async () => {
      driver.respondWith([
        {
          id: 'mem_1', namespace: 'ns', user_id: 'u1', agent_id: null, session_id: null,
          type: 'semantic', kind: 'note', status: 'active', content: 'hello',
          summary: null, title: 'T', metadata: { a: 1 }, tags: ['x'],
          importance: 0.7, confidence: 0.9, embedding: '[0.1,0.2,0.3,0.4]',
          embedding_model: 'local-hash-v1-4', tokens: 5, access_count: 2,
          last_accessed_at: new Date('2026-01-02T00:00:00Z'),
          created_at: new Date('2026-01-01T00:00:00Z'),
          updated_at: new Date('2026-01-01T00:00:00Z'),
          expires_at: null, archived_at: null, superseded_by: null,
          source_id: 'doc-1', content_hash: 'abc', version: 3,
        },
      ]);

      const memory = await adapter.getMemory('ns', 'mem_1');

      expect(memory).toMatchObject({
        id: 'mem_1', userId: 'u1', title: 'T', tags: ['x'],
        importance: 0.7, accessCount: 2, sourceId: 'doc-1', version: 3,
        embeddingModel: 'local-hash-v1-4',
      });
      expect(memory!.embedding).toEqual([0.1, 0.2, 0.3, 0.4]);
      expect(memory!.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(memory!.lastAccessedAt).toBe('2026-01-02T00:00:00.000Z');
    });

    it('parses jsonb delivered as a string', async () => {
      driver.respondWith([
        {
          id: 'm', namespace: 'ns', user_id: null, agent_id: null, session_id: null,
          type: 'note' as never, kind: 'note', status: 'active', content: 'c',
          summary: null, title: null, metadata: '{"parsed":true}', tags: [],
          importance: 0.5, confidence: 1, embedding: null, embedding_model: null,
          tokens: 0, access_count: 0, last_accessed_at: null,
          created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
          expires_at: null, archived_at: null, superseded_by: null,
          source_id: null, content_hash: 'h', version: 1,
        },
      ]);

      const memory = await adapter.getMemory('ns', 'm');
      expect(memory!.metadata).toEqual({ parsed: true });
    });

    it('preserves the requested id ordering in getMemories', async () => {
      driver.respondWith([
        { ...toRow(makeMemory({ id: 'b' })) },
        { ...toRow(makeMemory({ id: 'a' })) },
      ]);

      const memories = await adapter.getMemories('ns', ['a', 'b']);
      expect(memories.map((m) => m.id)).toEqual(['a', 'b']);
    });
  });

  describe('writes', () => {
    it('serialises embeddings to the pgvector literal on insert', async () => {
      driver.respondWith([toRow(makeMemory({ embedding: [0.1, 0.2, 0.3, 0.4] }))]);
      await adapter.insertMemories([makeMemory({ embedding: [0.1, 0.2, 0.3, 0.4] })]);

      const query = driver.lastMeaningful;
      expect(query.params).toContain('[0.1,0.2,0.3,0.4]');
      expect(query.text).toContain('::vector');
    });

    it('inserts a batch as a single multi-row statement', async () => {
      driver.respondWith([toRow(makeMemory({ id: 'a' })), toRow(makeMemory({ id: 'b' }))]);
      await adapter.insertMemories([makeMemory({ id: 'a' }), makeMemory({ id: 'b' })]);

      const query = driver.lastMeaningful;
      expect(query.text.match(/insert into memories/g)).toHaveLength(1);
      expect(query.text).toContain('on conflict');
    });

    it('soft-deletes by updating status', async () => {
      await adapter.deleteMemory('ns', 'mem_1');
      expect(driver.lastMeaningful.text).toContain("set status = 'deleted'");
    });

    it('hard-deletes with a real DELETE', async () => {
      await adapter.deleteMemory('ns', 'mem_1', true);
      expect(driver.lastMeaningful.text).toContain('delete from memories');
    });

    it('only updates the fields present in the patch', async () => {
      driver.respondWith([toRow(makeMemory())]);
      await adapter.updateMemory('ns', 'mem_1', { importance: 0.9 });

      const sql = driver.lastMeaningful.text;
      expect(sql).toContain('importance =');
      expect(sql).not.toContain('content =');
    });

    it('accumulates entity mention counts rather than overwriting', async () => {
      driver.respondWith([]);
      await adapter.upsertEntities([
        {
          id: 'ent_1', namespace: 'ns', type: 'person', name: 'Ada', normalizedName: 'ada',
          aliases: [], description: null, metadata: {}, mentionCount: 1, salience: 0.5,
          firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z',
        },
      ]);

      const sql = driver.lastMeaningful.text;
      expect(sql).toContain('entities.mention_count + excluded.mention_count');
      expect(sql).toContain('on conflict (namespace, normalized_name)');
    });

    it('reinforces relation weight on repeated observation', async () => {
      driver.respondWith([]);
      await adapter.upsertRelations([
        {
          id: 'rel_1', namespace: 'ns', sourceId: 'a', targetId: 'b', type: 'works_at',
          weight: 0.8, confidence: 0.8, memoryIds: ['m1'], metadata: {},
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]);

      const sql = driver.lastMeaningful.text;
      expect(sql).toContain('least(1.0, relations.weight + excluded.weight * 0.25)');
    });
  });

  describe('pagination', () => {
    it('returns the total from a window function alongside the page', async () => {
      driver.respondWith([{ ...toRow(makeMemory()), total_count: '42' }]);
      const page = await adapter.listMemories('ns', {
        limit: 1, offset: 0, sortBy: 'createdAt', sortDir: 'desc',
      });

      expect(driver.lastMeaningful.text).toContain('count(*) over ()');
      expect(page.total).toBe(42);
      expect(page.hasMore).toBe(true);
    });

    it('iterates with keyset pagination rather than OFFSET', async () => {
      driver.respondWith([toRow(makeMemory({ id: 'a' })), toRow(makeMemory({ id: 'b' }))]);
      driver.respondWith([]);

      const batches: Memory[][] = [];
      for await (const batch of adapter.iterateMemories('ns', undefined, 2)) batches.push(batch);

      expect(batches).toHaveLength(1);
      const second = driver.queries.filter((q) => q.text.includes('order by m.id asc'))[1];
      expect(second!.text).toContain('m.id >');
      expect(second!.params).toContain('b');
    });
  });

  describe('init', () => {
    it('fails with an actionable message when the schema is missing', async () => {
      driver.respondWith([{ exists: false }]);
      await expect(adapter.init()).rejects.toThrow(/0001_initial_schema\.sql/);
    });

    it('succeeds when the schema is present', async () => {
      driver.respondWith([{ exists: true }]);
      await expect(adapter.init()).resolves.toBeUndefined();
    });
  });

  describe('health', () => {
    it('reports the pgvector version', async () => {
      driver.respondWith([{ version: 'PostgreSQL 16.2 on x86_64', vector: '0.7.0' }]);
      const health = await adapter.healthCheck();

      expect(health.ok).toBe(true);
      expect(health.details!.pgvector).toBe('0.7.0');
    });
  });
});

function toRow(memory: Memory): Record<string, unknown> {
  return {
    id: memory.id, namespace: memory.namespace, user_id: memory.userId,
    agent_id: memory.agentId, session_id: memory.sessionId, type: memory.type,
    kind: memory.kind, status: memory.status, content: memory.content,
    summary: memory.summary, title: memory.title, metadata: memory.metadata,
    tags: memory.tags, importance: memory.importance, confidence: memory.confidence,
    embedding: memory.embedding ? `[${memory.embedding.join(',')}]` : null,
    embedding_model: memory.embeddingModel, tokens: memory.tokens,
    access_count: memory.accessCount, last_accessed_at: memory.lastAccessedAt,
    created_at: memory.createdAt, updated_at: memory.updatedAt,
    expires_at: memory.expiresAt, archived_at: memory.archivedAt,
    superseded_by: memory.supersededBy, source_id: memory.sourceId,
    content_hash: memory.contentHash, version: memory.version,
  };
}
