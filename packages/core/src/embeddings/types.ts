import type { AsyncCache } from '../util/cache.js';

/**
 * The contract every embedding backend implements.
 *
 * Implementations MUST return L2-normalised vectors of exactly `dimensions`
 * length, in the same order as the input, so the retrieval layer can use the
 * dot product directly as cosine similarity.
 */
export interface EmbeddingProvider {
  /** Stable provider identifier, e.g. `local`, `openai`, `openrouter`. */
  readonly id: string;
  /** Model identifier persisted alongside each vector. */
  readonly model: string;
  readonly dimensions: number;
  /** Maximum inputs accepted in one `embed` call. */
  readonly maxBatchSize: number;
  /** True when the provider makes billable network calls. */
  readonly remote: boolean;
  /**
   * Cosine similarity at which a match should be considered fully confident,
   * used to calibrate raw similarity into a 0..1 relevance score.
   *
   * This differs by an order of magnitude between backends: neural embedders
   * put related pairs around 0.7-0.9, while feature-hashing embedders produce
   * much smaller magnitudes because short queries share few features with long
   * documents. Without per-provider calibration a fixed threshold would either
   * reject every local-provider match or accept every neural one.
   */
  readonly fullConfidenceSimilarity: number;

  embed(texts: string[]): Promise<number[][]>;
}

export interface EmbeddingProviderStats {
  calls: number;
  texts: number;
  cacheHits: number;
  errors: number;
  totalLatencyMs: number;
}

export interface CachingOptions {
  cache: AsyncCache;
  /** Cache lifetime for a vector. Defaults to 24h — vectors are immutable per model. */
  ttlSeconds?: number;
}
