/**
 * Performance benchmarks.
 *
 * Run with `pnpm bench`. These measure the operations that dominate real
 * workloads — embedding, ingestion, and the two retrieval legs — against the
 * in-memory adapter, so results reflect engine cost without database latency.
 *
 * Numbers are machine-specific; what matters is the *shape*: embedding should
 * be microseconds, keyword search should be roughly constant in corpus size,
 * and exact vector search should grow linearly (which is why the Postgres
 * adapter uses an HNSW index instead).
 */
import { bench, describe } from 'vitest';
import {
  BM25Index,
  InMemoryStorageAdapter,
  LocalEmbeddingProvider,
  MemoryClient,
  cosineSimilarity,
  topK,
  chunkText,
  estimateTokens,
} from '@memorydb/core';

/** Deterministic pseudo-random text so every run measures the same work. */
function makeCorpus(count: number, wordsPerDoc = 60): string[] {
  const vocabulary = [
    'database', 'postgres', 'vector', 'embedding', 'search', 'index', 'query', 'memory',
    'agent', 'retrieval', 'semantic', 'keyword', 'ranking', 'cluster', 'consolidation',
    'deployment', 'pipeline', 'incident', 'latency', 'throughput', 'cache', 'schema',
    'migration', 'namespace', 'tenant', 'graph', 'entity', 'relation', 'summary', 'token',
  ];

  // Linear congruential generator — reproducible across runs and platforms.
  let seed = 42;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  return Array.from({ length: count }, (_, docIndex) => {
    const words = Array.from({ length: wordsPerDoc }, () => {
      const word = vocabulary[Math.floor(next() * vocabulary.length)];
      return word ?? 'memory';
    });
    return `Document ${docIndex}. ${words.join(' ')}.`;
  });
}

const provider = new LocalEmbeddingProvider();

/* -------------------------------------------------------------------------- */
/*                                 Embedding                                   */
/* -------------------------------------------------------------------------- */

describe('embedding', () => {
  const short = 'The production database runs PostgreSQL with pgvector.';
  const long = makeCorpus(1, 500)[0] as string;

  bench('embed a short text', () => {
    provider.embedOne(short);
  });

  bench('embed a 500-word document', () => {
    provider.embedOne(long);
  });

  bench('embed a batch of 100', async () => {
    await provider.embed(makeCorpus(100));
  });
});

/* -------------------------------------------------------------------------- */
/*                              Vector operations                              */
/* -------------------------------------------------------------------------- */

describe('vector operations', () => {
  const a = provider.embedOne('postgres vector index performance tuning');
  const b = provider.embedOne('tuning the performance of a postgres vector index');
  const pool = makeCorpus(10_000, 20).map((text) => provider.embedOne(text));
  const scored = pool.map((vector, id) => ({ id, vector }));

  bench('cosine similarity (384 dimensions)', () => {
    cosineSimilarity(a, b);
  });

  bench('top-10 over 10k vectors', () => {
    topK(scored, 10, (item) => cosineSimilarity(a, item.vector));
  });
});

/* -------------------------------------------------------------------------- */
/*                               Lexical index                                 */
/* -------------------------------------------------------------------------- */

describe('BM25 index', () => {
  const documents = makeCorpus(10_000);

  const index10k = new BM25Index();
  documents.forEach((content, i) => index10k.add({ id: String(i), content }));

  const index1k = new BM25Index();
  documents.slice(0, 1000).forEach((content, i) => index1k.add({ id: String(i), content }));

  bench('index a single document', () => {
    const scratch = new BM25Index();
    scratch.add({ id: 'x', content: documents[0] as string });
  });

  bench('search 1k documents', () => {
    index1k.search('postgres vector index', 10);
  });

  // Should be close to the 1k figure: cost tracks matching documents, not corpus size.
  bench('search 10k documents', () => {
    index10k.search('postgres vector index', 10);
  });
});

/* -------------------------------------------------------------------------- */
/*                              End-to-end engine                              */
/* -------------------------------------------------------------------------- */

describe('engine', () => {
  const corpus = makeCorpus(1000);

  bench('store a single memory', async () => {
    const client = await MemoryClient.create({
      storage: new InMemoryStorageAdapter(),
      namespace: 'bench',
      autoExtractGraph: false,
    });
    await client.store({ content: corpus[0] as string, deduplicate: false });
  });

  bench('bulk store 100 memories', async () => {
    const client = await MemoryClient.create({
      storage: new InMemoryStorageAdapter(),
      namespace: 'bench',
      autoExtractGraph: false,
    });
    await client.storeMany(
      corpus.slice(0, 100).map((content) => ({ content, deduplicate: false })),
    );
  });
});

describe('retrieval over 1k memories', () => {
  // Built once and shared: measuring search, not ingestion.
  const ready = (async () => {
    const client = await MemoryClient.create({
      storage: new InMemoryStorageAdapter(),
      namespace: 'bench-search',
      autoExtractGraph: false,
    });
    await client.storeMany(
      makeCorpus(1000).map((content) => ({ content, deduplicate: false })),
    );
    return client;
  })();

  bench('hybrid search', async () => {
    const client = await ready;
    await client.search({ query: 'postgres vector index performance', limit: 10 });
  });

  bench('semantic search', async () => {
    const client = await ready;
    await client.search({ query: 'postgres vector index performance', mode: 'semantic', limit: 10 });
  });

  bench('keyword search', async () => {
    const client = await ready;
    await client.search({ query: 'postgres vector index performance', mode: 'keyword', limit: 10 });
  });

  bench('retrieve with a token budget', async () => {
    const client = await ready;
    await client.retrieve({ query: 'postgres vector index performance', tokenBudget: 2000 });
  });
});

/* -------------------------------------------------------------------------- */
/*                                   Text                                      */
/* -------------------------------------------------------------------------- */

describe('text processing', () => {
  const document = makeCorpus(1, 5000)[0] as string;

  bench('estimate tokens for a 5k-word document', () => {
    estimateTokens(document);
  });

  bench('chunk a 5k-word document', () => {
    chunkText(document, { maxTokens: 512, overlapTokens: 64 });
  });
});
