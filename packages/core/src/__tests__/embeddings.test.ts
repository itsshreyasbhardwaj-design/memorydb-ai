import { describe, expect, it } from 'vitest';
import { LocalEmbeddingProvider, CachingEmbeddingProvider, createEmbeddingProvider } from '../embeddings/index.js';
import { MemoryAsyncCache } from '../util/cache.js';
import { cosineSimilarity, magnitude } from '../util/vector.js';

describe('LocalEmbeddingProvider', () => {
  const provider = new LocalEmbeddingProvider();

  it('produces vectors of the configured dimensionality', async () => {
    const [vector] = await provider.embed(['hello world']);
    expect(vector).toHaveLength(384);
  });

  it('produces L2-normalised vectors so dot product equals cosine', async () => {
    const [vector] = await provider.embed(['the quick brown fox jumps over the lazy dog']);
    expect(magnitude(vector!)).toBeCloseTo(1, 6);
  });

  it('is deterministic across calls and instances', async () => {
    const other = new LocalEmbeddingProvider();
    const [a] = await provider.embed(['consistent input text']);
    const [b] = await other.embed(['consistent input text']);
    expect(a).toEqual(b);
  });

  it('scores identical text at similarity 1', async () => {
    const [a, b] = await provider.embed(['machine learning pipeline', 'machine learning pipeline']);
    expect(cosineSimilarity(a!, b!)).toBeCloseTo(1, 6);
  });

  it('ranks related text above unrelated text', async () => {
    const [query, related, unrelated] = await provider.embed([
      'postgres database indexing and query performance',
      'optimising database indexes to speed up postgres queries',
      'the chef sautéed onions and garlic for the risotto',
    ]);

    const relatedScore = cosineSimilarity(query!, related!);
    const unrelatedScore = cosineSimilarity(query!, unrelated!);

    expect(relatedScore).toBeGreaterThan(unrelatedScore);
    expect(relatedScore).toBeGreaterThan(0.2);
  });

  it('tolerates typos via character n-grams', async () => {
    const [correct, typo, unrelated] = await provider.embed([
      'kubernetes deployment configuration',
      'kubernets deploymnt configuraton',
      'banana bread recipe with walnuts',
    ]);
    expect(cosineSimilarity(correct!, typo!)).toBeGreaterThan(cosineSimilarity(correct!, unrelated!));
  });

  it('returns a zero vector for empty input without throwing', async () => {
    const [vector] = await provider.embed(['']);
    expect(vector).toHaveLength(384);
    expect(vector!.every((value) => value === 0)).toBe(true);
  });

  it('honours a custom dimension count', async () => {
    const wide = new LocalEmbeddingProvider({ dimensions: 768 });
    const [vector] = await wide.embed(['test']);
    expect(vector).toHaveLength(768);
  });

  it('rejects out-of-range dimensions', () => {
    expect(() => new LocalEmbeddingProvider({ dimensions: 8 })).toThrow(RangeError);
  });

  it('embeds a batch preserving input order', async () => {
    const texts = ['alpha', 'beta', 'gamma'];
    const vectors = await provider.embed(texts);
    expect(vectors).toHaveLength(3);
    const [alphaAgain] = await provider.embed(['alpha']);
    expect(vectors[0]).toEqual(alphaAgain);
  });
});

describe('CachingEmbeddingProvider', () => {
  it('serves repeat texts from cache', async () => {
    let calls = 0;
    const counting = {
      id: 'test',
      model: 'test-model',
      dimensions: 4,
      maxBatchSize: 100,
      remote: false,
      async embed(texts: string[]) {
        calls += texts.length;
        return texts.map(() => [1, 0, 0, 0]);
      },
    };

    const cached = new CachingEmbeddingProvider(counting, new MemoryAsyncCache());
    await cached.embed(['a', 'b']);
    await cached.embed(['a', 'b']);

    expect(calls).toBe(2);
    expect(cached.stats().cacheHits).toBe(2);
  });

  it('only forwards cache misses upstream', async () => {
    const seen: string[][] = [];
    const provider = {
      id: 'test',
      model: 'test-model',
      dimensions: 2,
      maxBatchSize: 100,
      remote: false,
      async embed(texts: string[]) {
        seen.push(texts);
        return texts.map(() => [1, 0]);
      },
    };

    const cached = new CachingEmbeddingProvider(provider, new MemoryAsyncCache());
    await cached.embed(['x']);
    await cached.embed(['x', 'y']);

    expect(seen).toEqual([['x'], ['y']]);
  });
});

describe('createEmbeddingProvider', () => {
  it('defaults to the free local provider', () => {
    const provider = createEmbeddingProvider();
    expect(provider.remote).toBe(false);
    expect(provider.id).toBe('local');
  });

  it('refuses to build a remote provider without an API key', () => {
    expect(() => createEmbeddingProvider({ provider: 'openrouter' })).toThrow(/EMBEDDING_API_KEY/);
  });
});
