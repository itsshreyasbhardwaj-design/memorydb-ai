/**
 * Embedding provider composition: caching, instrumentation, and config-driven
 * construction.
 */
import type { EmbeddingProvider, EmbeddingProviderStats } from './types.js';
import { LocalEmbeddingProvider, createLocalEmbeddingProvider } from './local.js';
import { RemoteEmbeddingProvider, createOllamaProvider, createOpenRouterProvider } from './remote.js';
import type { AsyncCache } from '../util/cache.js';
import { MemoryAsyncCache } from '../util/cache.js';
import { sha256 } from '../util/hash.js';

export * from './types.js';
export { LocalEmbeddingProvider, createLocalEmbeddingProvider };
export { RemoteEmbeddingProvider, createOpenRouterProvider, createOllamaProvider };

/**
 * Decorator adding a content-addressed cache in front of any provider.
 *
 * Cache keys include the model id, so switching models can never serve a stale
 * vector from the previous one. Partial hits are supported: only the misses are
 * forwarded upstream, which matters most for remote providers billed per token.
 */
export class CachingEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dimensions: number;
  readonly maxBatchSize: number;
  readonly remote: boolean;
  readonly fullConfidenceSimilarity: number;

  private readonly inner: EmbeddingProvider;
  private readonly cache: AsyncCache;
  private readonly ttlSeconds: number;
  private readonly counters: EmbeddingProviderStats = {
    calls: 0,
    texts: 0,
    cacheHits: 0,
    errors: 0,
    totalLatencyMs: 0,
  };

  constructor(inner: EmbeddingProvider, cache: AsyncCache = new MemoryAsyncCache(), ttlSeconds = 86_400) {
    this.inner = inner;
    this.cache = cache;
    this.ttlSeconds = ttlSeconds;
    this.id = inner.id;
    this.model = inner.model;
    this.dimensions = inner.dimensions;
    this.maxBatchSize = inner.maxBatchSize;
    this.remote = inner.remote;
    this.fullConfidenceSimilarity = inner.fullConfidenceSimilarity;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const startedAt = Date.now();
    this.counters.calls++;
    this.counters.texts += texts.length;

    const keys = await Promise.all(texts.map((text) => this.cacheKey(text)));
    const results = new Array<number[] | undefined>(texts.length);
    const missIndexes: number[] = [];

    await Promise.all(
      keys.map(async (key, index) => {
        const hit = await this.cache.get<number[]>(key);
        if (hit) {
          results[index] = hit;
          this.counters.cacheHits++;
        } else {
          missIndexes.push(index);
        }
      }),
    );

    if (missIndexes.length > 0) {
      const missTexts = missIndexes.map((index) => texts[index] as string);
      try {
        const vectors = await this.inner.embed(missTexts);
        await Promise.all(
          vectors.map(async (vector, position) => {
            const index = missIndexes[position];
            if (index === undefined) return;
            results[index] = vector;
            const key = keys[index];
            if (key) await this.cache.set(key, vector, this.ttlSeconds);
          }),
        );
      } catch (err) {
        this.counters.errors++;
        throw err;
      }
    }

    this.counters.totalLatencyMs += Date.now() - startedAt;
    return results.map((vector) => vector ?? new Array<number>(this.dimensions).fill(0));
  }

  stats(): EmbeddingProviderStats & { hitRate: number; avgLatencyMs: number } {
    return {
      ...this.counters,
      hitRate: this.counters.texts === 0 ? 0 : this.counters.cacheHits / this.counters.texts,
      avgLatencyMs: this.counters.calls === 0 ? 0 : this.counters.totalLatencyMs / this.counters.calls,
    };
  }

  private async cacheKey(text: string): Promise<string> {
    return `emb:${this.id}:${this.model}:${await sha256(text)}`;
  }
}

/* -------------------------------------------------------------------------- */
/*                             Config-driven factory                           */
/* -------------------------------------------------------------------------- */

export type EmbeddingProviderKind = 'local' | 'openrouter' | 'openai' | 'ollama' | 'custom';

export interface EmbeddingConfig {
  provider?: EmbeddingProviderKind;
  model?: string;
  dimensions?: number;
  apiKey?: string;
  baseUrl?: string;
  cache?: AsyncCache | false;
  cacheTtlSeconds?: number;
  appUrl?: string;
  appName?: string;
}

/**
 * Build a provider from configuration.
 *
 * Defaults to `local`, so an unconfigured MemoryDB instance is fully functional
 * and never makes a billable call. Selecting a remote provider without an API
 * key throws immediately rather than failing on the first write.
 */
export function createEmbeddingProvider(config: EmbeddingConfig = {}): EmbeddingProvider {
  const kind = config.provider ?? 'local';
  let provider: EmbeddingProvider;

  switch (kind) {
    case 'local':
      provider = createLocalEmbeddingProvider({
        ...(config.dimensions !== undefined ? { dimensions: config.dimensions } : {}),
      });
      break;

    case 'openrouter': {
      if (!config.apiKey) throw new Error('EMBEDDING_API_KEY is required when provider is "openrouter"');
      provider = createOpenRouterProvider({
        apiKey: config.apiKey,
        ...(config.model !== undefined ? { model: config.model } : {}),
        ...(config.dimensions !== undefined ? { dimensions: config.dimensions } : {}),
        ...(config.appUrl !== undefined ? { appUrl: config.appUrl } : {}),
        ...(config.appName !== undefined ? { appName: config.appName } : {}),
      });
      break;
    }

    case 'openai': {
      if (!config.apiKey) throw new Error('EMBEDDING_API_KEY is required when provider is "openai"');
      provider = new RemoteEmbeddingProvider({
        id: 'openai',
        baseUrl: config.baseUrl ?? 'https://api.openai.com/v1',
        model: config.model ?? 'text-embedding-3-small',
        dimensions: config.dimensions ?? 1536,
        apiKey: config.apiKey,
      });
      break;
    }

    case 'ollama':
      provider = createOllamaProvider({
        ...(config.model !== undefined ? { model: config.model } : {}),
        ...(config.dimensions !== undefined ? { dimensions: config.dimensions } : {}),
        ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
      });
      break;

    case 'custom': {
      if (!config.baseUrl) throw new Error('EMBEDDING_BASE_URL is required when provider is "custom"');
      if (!config.model) throw new Error('EMBEDDING_MODEL is required when provider is "custom"');
      provider = new RemoteEmbeddingProvider({
        baseUrl: config.baseUrl,
        model: config.model,
        dimensions: config.dimensions ?? 768,
        ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
      });
      break;
    }

    default: {
      const exhaustive: never = kind;
      throw new Error(`unknown embedding provider: ${String(exhaustive)}`);
    }
  }

  if (config.cache === false) return provider;
  return new CachingEmbeddingProvider(
    provider,
    config.cache ?? new MemoryAsyncCache({ maxSize: 10_000, ttlMs: (config.cacheTtlSeconds ?? 86_400) * 1000 }),
    config.cacheTtlSeconds ?? 86_400,
  );
}
