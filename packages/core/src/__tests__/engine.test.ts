import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryClient } from '../client.js';
import { InMemoryStorageAdapter } from '../storage/memory-adapter.js';
import { BM25Index } from '../search/bm25.js';
import { fuse } from '../search/fusion.js';
import { recencyScore, usageScore, diversify } from '../search/ranking.js';
import { RuleBasedExtractor, inferEntityType } from '../graph/extractor.js';
import { normalizeEntityName } from '../graph/service.js';
import { ExtractiveSummarizer } from '../consolidation/summarizer.js';
import { computeExpiry, DEFAULT_RETENTION_POLICIES, isStale, boostImportance } from '../retention.js';
import { chunkText, estimateTokens, bestMatchingSpan, analyze, stem } from '../util/text.js';
import { LRUCache, MemoryAsyncCache, createReadThrough } from '../util/cache.js';
import { topK, centroid, normalize, cosineSimilarity, toPgVector, fromPgVector } from '../util/vector.js';
import { Histogram, Metrics } from '../metrics.js';
import { createZip, readZip, crc32 } from '../portability/zip.js';
import { exportMemories, importMemories } from '../portability/index.js';
import { parseCsv, parseMarkdown, parseTxt, serializeCsv, serializeMarkdown } from '../portability/formats.js';
import { timingSafeEqual, contentHash } from '../util/hash.js';
import { generateId, timestampFromId, generateApiKey } from '../util/id.js';

/* ========================================================================== */
/*                                   BM25                                     */
/* ========================================================================== */

describe('BM25Index', () => {
  let index: BM25Index;

  beforeEach(() => {
    index = new BM25Index();
    index.add({ id: '1', content: 'the cat sat on the mat in the kitchen' });
    index.add({ id: '2', content: 'dogs are loyal companions and great pets' });
    index.add({ id: '3', content: 'the cat chased the mouse around the kitchen' });
  });

  it('ranks documents containing query terms', () => {
    const results = index.search('cat kitchen');
    expect(results.length).toBe(2);
    expect(['1', '3']).toContain(results[0]!.id);
  });

  it('returns nothing when no term matches', () => {
    expect(index.search('quantum chromodynamics')).toHaveLength(0);
  });

  it('boosts title matches above body matches', () => {
    const boosted = new BM25Index();
    boosted.add({ id: 'body', content: 'a passing mention of postgres somewhere in here' });
    boosted.add({ id: 'title', content: 'unrelated body text entirely', title: 'postgres' });

    const results = boosted.search('postgres');
    expect(results[0]!.id).toBe('title');
  });

  it('saturates term frequency so repetition cannot dominate', () => {
    const saturating = new BM25Index();
    saturating.add({ id: 'spam', content: `${'spam '.repeat(50)}` });
    saturating.add({ id: 'real', content: 'spam filtering uses bayesian classification' });

    const results = saturating.search('spam filtering');
    expect(results[0]!.id).toBe('real');
  });

  it('supports incremental removal', () => {
    expect(index.remove('1')).toBe(true);
    expect(index.size).toBe(2);
    expect(index.search('mat')).toHaveLength(0);
  });

  it('treats re-adding an id as an update', () => {
    index.add({ id: '1', content: 'completely replaced content about zebras' });
    expect(index.size).toBe(3);
    expect(index.search('mat')).toHaveLength(0);
    expect(index.search('zebras')).toHaveLength(1);
  });

  it('restricts results to an allow-set', () => {
    const results = index.search('kitchen', 10, new Set(['3']));
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe('3');
  });
});

/* ========================================================================== */
/*                                  Fusion                                    */
/* ========================================================================== */

describe('fuse', () => {
  it('rewards documents appearing in both legs', () => {
    const results = fuse([
      { name: 'vector', results: [{ id: 'both', score: 0.9 }, { id: 'vec', score: 0.8 }], weight: 0.5 },
      { name: 'keyword', results: [{ id: 'both', score: 5 }, { id: 'kw', score: 4 }], weight: 0.5 },
    ]);
    expect(results[0]!.id).toBe('both');
  });

  it('handles a single leg without error', () => {
    const results = fuse([{ name: 'vector', results: [{ id: 'a', score: 1 }], weight: 1 }]);
    expect(results).toHaveLength(1);
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  it('ignores legs with zero weight', () => {
    const results = fuse([
      { name: 'vector', results: [{ id: 'v', score: 1 }], weight: 0 },
      { name: 'keyword', results: [{ id: 'k', score: 1 }], weight: 1 },
    ]);
    expect(results.map((r) => r.id)).toEqual(['k']);
  });

  it('returns an empty array when every leg is empty', () => {
    expect(fuse([{ name: 'vector', results: [], weight: 1 }])).toHaveLength(0);
  });

  it('records per-leg ranks and scores', () => {
    const [top] = fuse([
      { name: 'vector', results: [{ id: 'a', score: 0.7 }], weight: 1 },
      { name: 'keyword', results: [{ id: 'a', score: 3 }], weight: 1 },
    ]);
    expect(top!.legRanks).toEqual({ vector: 1, keyword: 1 });
    expect(top!.legScores).toEqual({ vector: 0.7, keyword: 3 });
  });
});

/* ========================================================================== */
/*                                 Ranking                                    */
/* ========================================================================== */

describe('ranking signals', () => {
  it('halves the recency score at exactly one half-life', () => {
    const created = new Date(Date.now() - 30 * 86_400_000).toISOString();
    expect(recencyScore(created, 30)).toBeCloseTo(0.5, 2);
  });

  it('returns 1 when recency weighting is disabled', () => {
    expect(recencyScore(new Date(0).toISOString(), 0)).toBe(1);
  });

  it('saturates the usage prior', () => {
    expect(usageScore(0)).toBe(0);
    expect(usageScore(10)).toBeGreaterThan(0);
    expect(usageScore(100_000)).toBe(1);
  });

  it('drops redundant items when diversifying', () => {
    const make = (id: string, content: string, embedding: number[]) => ({
      memory: { id, content, contentHash: id, embedding } as never,
    });
    const { kept, dropped } = diversify(
      [
        make('a', 'x', normalize([1, 0, 0])),
        make('b', 'y', normalize([0.99, 0.01, 0])),
        make('c', 'z', normalize([0, 1, 0])),
      ],
      0.9,
      10,
    );
    expect(kept).toHaveLength(2);
    expect(dropped).toBe(1);
  });
});

/* ========================================================================== */
/*                             Entity extraction                              */
/* ========================================================================== */

describe('RuleBasedExtractor', () => {
  const extractor = new RuleBasedExtractor();

  it('extracts people, organizations, and technologies', async () => {
    const { entities } = await extractor.extract(
      'Ada Lovelace works at Analytical Engines Inc and maintains the parser in TypeScript.',
    );
    const names = entities.map((e) => e.name);
    expect(names).toContain('Ada Lovelace');
    expect(entities.find((e) => e.name === 'Ada Lovelace')?.type).toBe('person');
    expect(names.some((n) => n.toLowerCase().includes('typescript'))).toBe(true);
  });

  it('extracts a works_at relation from surface syntax', async () => {
    const { relations } = await extractor.extract('Grace Hopper works at Remington Rand on the compiler.');
    const worksAt = relations.find((r) => r.type === 'works_at');
    expect(worksAt).toBeDefined();
    expect(worksAt!.source).toContain('Grace');
  });

  it('extracts a depends_on relation', async () => {
    const { relations } = await extractor.extract('The Checkout Service depends on the Billing Gateway.');
    expect(relations.some((r) => r.type === 'depends_on')).toBe(true);
  });

  it('recognises file paths and emails', async () => {
    const { entities } = await extractor.extract('See src/server/index.ts and email ada@example.com for details.');
    expect(entities.some((e) => e.type === 'file' && e.name.includes('index.ts'))).toBe(true);
    expect(entities.some((e) => e.name === 'ada@example.com')).toBe(true);
  });

  it('does not treat sentence-initial common words as entities', async () => {
    const { entities } = await extractor.extract('The meeting was useful. However we should revisit it later.');
    const names = entities.map((e) => e.name.toLowerCase());
    expect(names).not.toContain('the');
    expect(names).not.toContain('however');
  });

  it('promotes supplied tags to trusted concepts', async () => {
    const { entities } = await extractor.extract('some body text', { tags: ['observability'] });
    expect(entities.find((e) => e.name === 'observability')?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('does not treat ordinary English words as technology mentions', async () => {
    const { entities } = await extractor.extract('Releases go out on Thursdays after the tests pass.');
    const names = entities.map((e) => e.name.toLowerCase());

    expect(names).not.toContain('go');
    // Weekday plurals are calendar words, not entities.
    expect(names).not.toContain('thursdays');
  });

  it('still recognises capitalised ambiguous technology names', async () => {
    const { entities } = await extractor.extract('The service is written in Go and Rust.');
    const technologies = entities.filter((e) => e.type === 'technology').map((e) => e.name);

    expect(technologies).toContain('Go');
    expect(technologies).toContain('Rust');
  });

  it('matches a technology followed by sentence punctuation', async () => {
    const { entities } = await extractor.extract('The parser is written in TypeScript.');
    expect(entities.some((e) => e.name.toLowerCase() === 'typescript')).toBe(true);
  });

  it('infers organization from a legal suffix', () => {
    expect(inferEntityType('Initech LLC', 'contract with Initech LLC')).toBe('organization');
  });

  it('normalises entity names for resolution', () => {
    expect(normalizeEntityName('Acme Corp.')).toBe('acme');
    expect(normalizeEntityName('  ACME   corp ')).toBe('acme');
  });
});

describe('GraphService via MemoryClient', () => {
  it('builds a graph from stored memories', async () => {
    const client = await MemoryClient.create({ storage: new InMemoryStorageAdapter(), namespace: 'g' });

    await client.store({ content: 'Ada Lovelace works at Analytical Engines and leads the Difference Project.' });
    await client.store({ content: 'Ada Lovelace prefers TypeScript over Python for the Difference Project.' });

    const graph = await client.graph();
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.stats.nodeCount).toBe(graph.nodes.length);

    const ada = graph.nodes.find((n) => n.name.includes('Ada'));
    expect(ada).toBeDefined();
    // Mentioned in two memories, so the entity must have been merged, not duplicated.
    expect(ada!.mentionCount).toBeGreaterThanOrEqual(2);
  });

  it('lists entities filtered by type', async () => {
    const client = await MemoryClient.create({ storage: new InMemoryStorageAdapter(), namespace: 'g2' });
    await client.store({ content: 'We migrated from MySQL to PostgreSQL using Docker and Kubernetes.' });

    const page = await client.entities({ type: 'technology' });
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((e) => e.type === 'technology')).toBe(true);
  });
});

/* ========================================================================== */
/*                               Consolidation                                */
/* ========================================================================== */

describe('ExtractiveSummarizer', () => {
  const summarizer = new ExtractiveSummarizer();

  it('returns short input unchanged', async () => {
    const result = await summarizer.summarize({ texts: ['A short note.'], maxTokens: 100 });
    expect(result.summary).toBe('A short note.');
    expect(result.method).toBe('extractive');
  });

  it('compresses long input within the token budget', async () => {
    const texts = Array.from({ length: 30 }, (_, i) =>
      `Sentence ${i} discusses the migration of the billing service to the new payment provider and its risks.`,
    );
    const result = await summarizer.summarize({ texts, maxTokens: 60 });

    expect(result.tokens).toBeLessThanOrEqual(70);
    expect(result.summary.length).toBeLessThan(texts.join(' ').length);
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it('only ever reuses source sentences', async () => {
    const source = 'Alpha runs nightly. Beta runs weekly. Gamma runs hourly.';
    const result = await summarizer.summarize({ texts: [source, source, source], maxTokens: 10 });
    for (const sentence of result.summary.split(/(?<=\.)\s+/).filter(Boolean)) {
      expect(source).toContain(sentence.trim());
    }
  });

  it('returns empty output for empty input', async () => {
    expect((await summarizer.summarize({ texts: [] })).summary).toBe('');
  });
});

describe('Consolidator', () => {
  it('merges exact duplicates and marks losers superseded', async () => {
    const client = await MemoryClient.create({ storage: new InMemoryStorageAdapter(), namespace: 'c1' });
    for (let i = 0; i < 3; i++) {
      await client.store({ content: 'The API rate limit is 1000 rpm.', type: 'semantic', deduplicate: false });
    }

    const report = await client.consolidate({ summarize: false, archive: false });
    expect(report.duplicatesMerged).toBe(2);
    expect(await client.count()).toBe(1);
  });

  it('merges near-duplicates above the similarity threshold', async () => {
    const client = await MemoryClient.create({ storage: new InMemoryStorageAdapter(), namespace: 'c2' });
    await client.store({ content: 'The deployment pipeline runs on GitHub Actions.', type: 'semantic' });
    await client.store({ content: 'The deployment pipeline runs on GitHub Actions!', type: 'semantic' });

    const report = await client.consolidate({ duplicateThreshold: 0.9, summarize: false, archive: false });
    expect(report.duplicatesMerged).toBeGreaterThanOrEqual(1);
  });

  it('unions tags and keeps the highest importance on the survivor', async () => {
    const client = await MemoryClient.create({ storage: new InMemoryStorageAdapter(), namespace: 'c3' });
    await client.store({ content: 'shared fact', type: 'semantic', tags: ['a'], importance: 0.9, deduplicate: false });
    await client.store({ content: 'shared fact', type: 'semantic', tags: ['b'], importance: 0.3, deduplicate: false });

    await client.consolidate({ summarize: false, archive: false });
    const survivor = (await client.list()).items[0]!;

    expect(survivor.importance).toBe(0.9);
    expect(survivor.tags.sort()).toEqual(['a', 'b']);
  });

  it('reports without writing in dry-run mode', async () => {
    const client = await MemoryClient.create({ storage: new InMemoryStorageAdapter(), namespace: 'c4' });
    await client.store({ content: 'dupe', type: 'semantic', deduplicate: false });
    await client.store({ content: 'dupe', type: 'semantic', deduplicate: false });

    const report = await client.consolidate({ dryRun: true, summarize: false, archive: false });
    expect(report.duplicatesMerged).toBe(2 - 1);
    expect(await client.count()).toBe(2);
  });

  it('clusters related memories', async () => {
    const client = await MemoryClient.create({ storage: new InMemoryStorageAdapter(), namespace: 'c5' });
    await client.storeMany([
      { content: 'postgres index tuning for faster queries' },
      { content: 'postgres query planner and index selection' },
      { content: 'sourdough bread starter maintenance schedule' },
      { content: 'sourdough bread baking temperature and timing' },
    ]);

    const report = await client.consolidate({ deduplicate: false, summarize: false, archive: false });
    expect(report.clusters.length).toBeGreaterThanOrEqual(1);
    expect(report.clusters[0]!.keywords.length).toBeGreaterThan(0);
    expect(report.clusters[0]!.coherence).toBeGreaterThan(0);
  });

  it('expires memories past their TTL', async () => {
    const client = await MemoryClient.create({ storage: new InMemoryStorageAdapter(), namespace: 'c6' });
    await client.store({ content: 'gone', expiresAt: new Date(Date.now() - 1000).toISOString() });

    const report = await client.consolidate({ deduplicate: false, summarize: false, archive: false });
    expect(report.expired).toBe(1);
  });
});

/* ========================================================================== */
/*                                 Retention                                  */
/* ========================================================================== */

describe('retention', () => {
  it('gives short-term memory a TTL and semantic memory none', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(computeExpiry('short_term', DEFAULT_RETENTION_POLICIES, { now })).toBe('2026-01-01T01:00:00.000Z');
    expect(computeExpiry('semantic', DEFAULT_RETENTION_POLICIES, { now })).toBeNull();
  });

  it('prefers an explicit expiry over the policy', () => {
    const explicit = '2030-01-01T00:00:00.000Z';
    expect(computeExpiry('short_term', DEFAULT_RETENTION_POLICIES, { expiresAt: explicit })).toBe(explicit);
  });

  it('detects staleness only for types that define a horizon', () => {
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
    expect(isStale(old, 'long_term', DEFAULT_RETENTION_POLICIES)).toBe(true);
    expect(isStale(old, 'semantic', DEFAULT_RETENTION_POLICIES)).toBe(false);
  });

  it('boosts importance on access but never past 1', () => {
    expect(boostImportance(0.5, 'semantic', DEFAULT_RETENTION_POLICIES)).toBeGreaterThan(0.5);
    expect(boostImportance(1, 'semantic', DEFAULT_RETENTION_POLICIES)).toBe(1);
  });
});

/* ========================================================================== */
/*                                   Text                                     */
/* ========================================================================== */

describe('text utilities', () => {
  it('estimates tokens within a reasonable band', () => {
    const text = 'The quick brown fox jumps over the lazy dog.';
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(8);
    expect(tokens).toBeLessThan(20);
  });

  it('returns a single chunk for short text', () => {
    const chunks = chunkText('short text', { maxTokens: 100 });
    expect(chunks).toHaveLength(1);
  });

  it('chunks long text with overlap and correct offsets', () => {
    const text = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} contains several words of prose.`).join('\n\n');
    const chunks = chunkText(text, { maxTokens: 60, overlapTokens: 10 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokens).toBeLessThanOrEqual(80);
      expect(chunk.start).toBeGreaterThanOrEqual(0);
      expect(chunk.end).toBeLessThanOrEqual(text.length);
    }
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it('splits a single oversized paragraph', () => {
    const chunks = chunkText('word '.repeat(2000), { maxTokens: 100 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('returns no chunks for whitespace', () => {
    expect(chunkText('   \n  ')).toHaveLength(0);
  });

  it('locates the best matching span for a citation', () => {
    const content = `${'filler text. '.repeat(40)}The secret password is hunter2.${' more filler.'.repeat(40)}`;
    const span = bestMatchingSpan(content, 'secret password', 120);
    expect(span.snippet.toLowerCase()).toContain('secret');
  });

  it('removes stopwords and stems during analysis', () => {
    expect(analyze('the running dogs are here')).not.toContain('the');
    expect(analyze('running')).toEqual(['runn']);
  });

  it('applies stemming steps in sequence so plural derivations reduce fully', () => {
    // "deployments" must lose both the plural and the -ment suffix, otherwise a
    // query for "deploy" never matches a document that says "Deployments".
    expect(stem('deployments')).toBe('deploy');
    expect(stem('deployment')).toBe('deploy');
    expect(stem('requirements')).toBe('require');
  });

  it('does not over-stem short words ending in -ment', () => {
    expect(stem('comment')).toBe('comment');
    expect(stem('moment')).toBe('moment');
  });

  it('matches a query term against its inflected form in the index', () => {
    const index = new BM25Index();
    index.add({ id: 'deploy', content: 'Deployments run through GitHub Actions every Thursday.' });

    expect(index.search('deploy')).toHaveLength(1);
  });
});

/* ========================================================================== */
/*                              Vectors & cache                               */
/* ========================================================================== */

describe('vector utilities', () => {
  it('selects the top k by score', () => {
    const items = [{ s: 3 }, { s: 1 }, { s: 5 }, { s: 4 }, { s: 2 }];
    expect(topK(items, 2, (i) => i.s).map((i) => i.s)).toEqual([5, 4]);
  });

  it('returns everything sorted when k exceeds the input length', () => {
    expect(topK([{ s: 1 }, { s: 2 }], 10, (i) => i.s).map((i) => i.s)).toEqual([2, 1]);
  });

  it('computes a normalised centroid', () => {
    const c = centroid([normalize([1, 0]), normalize([0, 1])]);
    expect(cosineSimilarity(c, normalize([1, 1]))).toBeCloseTo(1, 6);
  });

  it('round-trips the pgvector literal format', () => {
    expect(fromPgVector(toPgVector([0.5, -0.25]))).toEqual([0.5, -0.25]);
    expect(fromPgVector(null)).toBeNull();
  });
});

describe('caches', () => {
  it('evicts the least recently used entry', () => {
    const cache = new LRUCache<string, number>({ maxSize: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');
    cache.set('c', 3);

    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
  });

  it('expires entries past their TTL', async () => {
    const cache = new LRUCache<string, number>({ ttlMs: 10 });
    cache.set('x', 1);
    await new Promise((r) => setTimeout(r, 25));
    expect(cache.get('x')).toBeUndefined();
  });

  it('deletes by prefix', async () => {
    const cache = new MemoryAsyncCache();
    await cache.set('ns:a', 1);
    await cache.set('ns:b', 2);
    await cache.set('other', 3);
    await cache.deletePrefix('ns:');

    expect(await cache.get('ns:a')).toBeUndefined();
    expect(await cache.get('other')).toBe(3);
  });

  it('collapses concurrent misses into one upstream call', async () => {
    const cache = new MemoryAsyncCache();
    const readThrough = createReadThrough(cache);
    let calls = 0;

    const load = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return 'value';
    };

    const [a, b, c] = await Promise.all([
      readThrough('k', 60, load),
      readThrough('k', 60, load),
      readThrough('k', 60, load),
    ]);

    expect([a, b, c]).toEqual(['value', 'value', 'value']);
    expect(calls).toBe(1);
  });
});

/* ========================================================================== */
/*                                  Metrics                                   */
/* ========================================================================== */

describe('metrics', () => {
  it('computes histogram quantiles', () => {
    const histogram = new Histogram();
    for (let i = 1; i <= 100; i++) histogram.observe(i);
    const snapshot = histogram.snapshot();

    expect(snapshot.count).toBe(100);
    expect(snapshot.min).toBe(1);
    expect(snapshot.max).toBe(100);
    expect(snapshot.p50).toBeGreaterThan(25);
    expect(snapshot.p99).toBeGreaterThan(snapshot.p50);
  });

  it('records counters and timings', async () => {
    const metrics = new Metrics();
    metrics.increment('hits', 3);
    await metrics.time('op', async () => 'ok');

    const snapshot = metrics.snapshot();
    expect(snapshot.counters.hits).toBe(3);
    expect(snapshot.counters['op.success']).toBe(1);
    expect(snapshot.histograms.op!.count).toBe(1);
  });

  it('counts errors and rethrows', async () => {
    const metrics = new Metrics();
    await expect(metrics.time('bad', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(metrics.snapshot().counters['bad.error']).toBe(1);
  });

  it('renders Prometheus exposition format', () => {
    const metrics = new Metrics();
    metrics.increment('requests', 2, { route: '/v1/search' });
    const output = metrics.toPrometheus();
    expect(output).toContain('memorydb_requests_total{route="/v1/search"} 2');
  });
});

/* ========================================================================== */
/*                              Hashing & ids                                 */
/* ========================================================================== */

describe('hashing and ids', () => {
  it('produces stable content hashes ignoring case and whitespace', async () => {
    expect(await contentHash('Hello   World')).toBe(await contentHash('hello world'));
    expect(await contentHash('a')).not.toBe(await contentHash('b'));
  });

  it('compares strings without early exit', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });

  it('generates prefixed, time-sortable ids', () => {
    const early = generateId('mem', 1_000_000_000_000);
    const later = generateId('mem', 2_000_000_000_000);
    expect(early < later).toBe(true);
    expect(timestampFromId(later)).toBe(2_000_000_000_000);
  });

  it('generates environment-tagged API keys', () => {
    expect(generateApiKey('test')).toMatch(/^mdb_test_[0-9A-Z]{32}$/);
  });
});

/* ========================================================================== */
/*                            Import / export                                 */
/* ========================================================================== */

describe('ZIP', () => {
  it('computes the standard CRC-32 of "123456789"', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('round-trips entries through a real archive', async () => {
    const archive = createZip([
      { name: 'a.txt', data: 'hello' },
      { name: 'nested/b.json', data: '{"k":1}' },
    ]);
    expect(archive[0]).toBe(0x50);
    expect(archive[1]).toBe(0x4b);

    const entries = await readZip(archive);
    expect(entries.map((e) => e.name)).toEqual(['a.txt', 'nested/b.json']);
    expect(entries[0]!.text()).toBe('hello');
    expect(JSON.parse(entries[1]!.text())).toEqual({ k: 1 });
  });
});

describe('formats', () => {
  it('round-trips CSV including embedded commas and quotes', () => {
    const memories = [
      { id: 'm1', content: 'value, with "quotes" and, commas', type: 'semantic', kind: 'note',
        title: null, summary: null, tags: ['a', 'b'], metadata: { k: 1 }, importance: 0.5, confidence: 1,
        userId: null, agentId: null, sessionId: null, sourceId: null, createdAt: '2026-01-01T00:00:00.000Z' },
    ] as never[];

    const parsed = parseCsv(serializeCsv(memories));
    expect(parsed[0]!.content).toBe('value, with "quotes" and, commas');
    expect(parsed[0]!.tags).toEqual(['a', 'b']);
    expect(parsed[0]!.metadata).toEqual({ k: 1 });
  });

  it('rejects CSV without a content column', () => {
    expect(() => parseCsv('a,b\n1,2')).toThrow(/content/);
  });

  it('round-trips Markdown', () => {
    const memories = [
      { id: 'm1', content: 'Body text here.', type: 'semantic', kind: 'note', title: 'A title',
        tags: ['x'], importance: 0.7, confidence: 1, createdAt: '2026-01-01T00:00:00.000Z',
        userId: null, summary: null, metadata: {} },
    ] as never[];

    const parsed = parseMarkdown(serializeMarkdown(memories));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.title).toBe('A title');
    expect(parsed[0]!.content).toContain('Body text here.');
    expect(parsed[0]!.tags).toEqual(['x']);
  });

  it('imports a plain markdown document as one memory', () => {
    const parsed = parseMarkdown('Just some notes\n\nwith two paragraphs.');
    expect(parsed).toHaveLength(1);
  });

  it('splits plain text on blank-line boundaries', () => {
    expect(parseTxt('first block\n\n\nsecond block')).toHaveLength(2);
    expect(parseTxt('only one block')).toHaveLength(1);
  });
});

describe('export / import round trip', () => {
  async function seed(namespace: string) {
    const client = await MemoryClient.create({ storage: new InMemoryStorageAdapter(), namespace });
    await client.storeMany([
      { content: 'First memory about databases', tags: ['db'], type: 'semantic' },
      { content: 'Second memory about deployment', tags: ['ci'], type: 'procedural' },
    ]);
    return client;
  }

  it.each(['json', 'jsonl', 'csv', 'markdown'] as const)('round-trips via %s', async (format) => {
    const source = await seed(`exp-${format}`);
    const exported = await exportMemories(source, { format });
    expect(exported.count).toBe(2);

    const target = await MemoryClient.create({ storage: new InMemoryStorageAdapter(), namespace: 'imp' });
    const result = await importMemories(target, { data: exported.data as string, format });

    expect(result.imported).toBe(2);
    expect(result.failed).toBe(0);
    expect(await target.count()).toBe(2);
  });

  it('exports and re-imports a ZIP archive', async () => {
    const source = await seed('exp-zip');
    const exported = await exportMemories(source, { format: 'zip', includeGraph: true });
    expect(exported.contentType).toBe('application/zip');

    const entries = await readZip(exported.data as Uint8Array);
    expect(entries.map((e) => e.name)).toContain('memories.json');
    expect(entries.map((e) => e.name)).toContain('graph.json');

    const target = await MemoryClient.create({ storage: new InMemoryStorageAdapter(), namespace: 'imp-zip' });
    const result = await importMemories(target, { data: exported.data as Uint8Array, format: 'zip' });
    expect(result.imported).toBe(2);
  });

  it('validates without writing in dry-run mode', async () => {
    const target = await MemoryClient.create({ storage: new InMemoryStorageAdapter(), namespace: 'dry' });
    const result = await importMemories(target, {
      data: JSON.stringify([{ content: 'a' }, { content: 'b' }]),
      format: 'json',
      dryRun: true,
    });

    expect(result.imported).toBe(2);
    expect(await target.count()).toBe(0);
  });

  it('reports per-record failures without aborting the import', async () => {
    const target = await MemoryClient.create({ storage: new InMemoryStorageAdapter(), namespace: 'partial' });
    const result = await importMemories(target, {
      data: JSON.stringify([{ content: 'good' }, { notContent: 'bad' }, { content: 'also good' }]),
      format: 'json',
    });

    expect(result.imported).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errors[0]!.index).toBe(1);
  });

  it('applies import tags to every record', async () => {
    const target = await MemoryClient.create({ storage: new InMemoryStorageAdapter(), namespace: 'tagged' });
    await importMemories(target, {
      data: JSON.stringify([{ content: 'imported item' }]),
      format: 'json',
      tags: ['from-backup'],
    });

    expect((await target.list()).items[0]!.tags).toContain('from-backup');
  });
});
