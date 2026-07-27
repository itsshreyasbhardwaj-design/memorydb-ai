/**
 * MemoryDB AI — core engine.
 *
 * ```ts
 * import { MemoryClient } from '@memorydb/core';
 *
 * const memory = await MemoryClient.create();
 * await memory.store({ content: 'Ada prefers dark mode.', type: 'semantic' });
 * const { context } = await memory.retrieve({ query: 'What are Ada’s preferences?' });
 * ```
 *
 * With no configuration this runs entirely in-process with local embeddings —
 * no database, no API key, no network calls.
 */

export * from './types.js';
export * from './errors.js';
export * from './logger.js';
export * from './retention.js';
export * from './metrics.js';

export { MemoryClient } from './client.js';
export type { MemoryClientOptions, StoreResult } from './client.js';

export * from './embeddings/index.js';

export type {
  StorageAdapter,
  ScoredId,
  VectorSearchOptions,
  KeywordSearchOptions,
  EntityListOptions,
  RelationListOptions,
  StatsOptions,
  HealthStatus,
  MemoryPatch,
} from './storage/types.js';
export { InMemoryStorageAdapter } from './storage/memory-adapter.js';
export type { MemoryAdapterOptions } from './storage/memory-adapter.js';
export { PostgresStorageAdapter } from './storage/postgres-adapter.js';
export type { PostgresAdapterOptions, SqlDriver } from './storage/postgres-adapter.js';
export { matchesFilter, matchesMetadataFilter, isExpired, getMetadataPath } from './storage/filter.js';

export { BM25Index } from './search/bm25.js';
export type { BM25Options, BM25Document } from './search/bm25.js';
export { fuse, RRF_K } from './search/fusion.js';
export type { FusionLeg, FusedResult, FuseOptions } from './search/fusion.js';
export { rankMemories, diversify, recencyScore, usageScore, TYPE_PRIORS } from './search/ranking.js';
export type { RankingWeights, RankedItem } from './search/ranking.js';

export { GraphService, normalizeEntityName } from './graph/service.js';
export type { GraphIngestResult, GraphQueryOptions } from './graph/service.js';
export {
  RuleBasedExtractor,
  createDefaultExtractor,
  inferEntityType,
} from './graph/extractor.js';
export type {
  EntityExtractor,
  ExtractedEntity,
  ExtractedRelation,
  ExtractionResult,
  ExtractionHints,
} from './graph/extractor.js';

export { Consolidator, ExtractiveSummarizer, LLMSummarizer } from './consolidation/index.js';
export type {
  ConsolidationOptions,
  ConsolidationReport,
  MemoryCluster,
  Summarizer,
  SummarizeRequest,
  SummarizeResult,
} from './consolidation/index.js';

export * from './portability/index.js';

export {
  LRUCache,
  MemoryAsyncCache,
  nullCache,
  createReadThrough,
} from './util/cache.js';
export type { AsyncCache, LRUCacheOptions } from './util/cache.js';

export { sha256, contentHash, fnv1a32, murmur3, timingSafeEqual } from './util/hash.js';
export { generateId, generateApiKey, generateSecret, ulid, timestampFromId } from './util/id.js';
export type { IdPrefix } from './util/id.js';
export {
  tokenize,
  analyze,
  stem,
  estimateTokens,
  chunkText,
  truncate,
  normalizeWhitespace,
  bestMatchingSpan,
  ngrams,
  charNgrams,
  isStopword,
} from './util/text.js';
export type { ChunkOptions, TextChunk, AnalyzeOptions } from './util/text.js';
export {
  cosineSimilarity,
  cosineSimilarityNormalized,
  normalize,
  normalizeInPlace,
  dot,
  magnitude,
  euclideanDistance,
  centroid,
  similarityToScore,
  topK,
  toPgVector,
  fromPgVector,
} from './util/vector.js';
export type { Vector } from './util/vector.js';

/** Package version, kept in sync with package.json by CI. */
export const VERSION = '0.1.0';
