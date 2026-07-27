/**
 * Storage adapter contract.
 *
 * Everything above this line is pure logic; everything below is pluggable
 * persistence. The engine never issues a query that a competent adapter cannot
 * push down to its backing store, which is why `vectorSearch` and
 * `keywordSearch` return scored ids rather than hydrated rows — the adapter
 * decides how much work happens in the database.
 */
import type {
  Entity,
  EntityType,
  Memory,
  MemoryFilter,
  MemoryStats,
  Page,
  Relation,
  ResolvedListInput,
} from '../types.js';

/** A candidate returned from a retrieval leg, before fusion. */
export interface ScoredId {
  id: string;
  /** Leg-local relevance. Vector legs return cosine in [-1,1]; BM25 returns raw scores. */
  score: number;
}

export interface VectorSearchOptions {
  embedding: number[];
  limit: number;
  filter?: MemoryFilter | undefined;
  /** Discard candidates below this cosine similarity before ranking. */
  minSimilarity?: number | undefined;
}

export interface KeywordSearchOptions {
  query: string;
  limit: number;
  filter?: MemoryFilter | undefined;
}

export interface EntityListOptions {
  type?: EntityType | EntityType[] | undefined;
  search?: string | undefined;
  minMentions?: number | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  sortBy?: 'mentionCount' | 'salience' | 'lastSeenAt' | 'name' | undefined;
}

export interface RelationListOptions {
  entityIds?: string[] | undefined;
  types?: string[] | undefined;
  minWeight?: number | undefined;
  limit?: number | undefined;
}

export interface StatsOptions {
  /** Number of days of daily growth buckets to compute. */
  growthDays?: number | undefined;
  topTagsLimit?: number | undefined;
}

export interface HealthStatus {
  ok: boolean;
  latencyMs: number;
  adapter: string;
  details?: Record<string, unknown>;
}

/**
 * A partial memory update. Distinct from the public `UpdateMemoryInput`: this
 * is the already-resolved column-level patch the engine hands to storage.
 */
export type MemoryPatch = Partial<
  Pick<
    Memory,
    | 'content'
    | 'title'
    | 'summary'
    | 'type'
    | 'kind'
    | 'status'
    | 'metadata'
    | 'tags'
    | 'importance'
    | 'confidence'
    | 'embedding'
    | 'embeddingModel'
    | 'tokens'
    | 'expiresAt'
    | 'archivedAt'
    | 'supersededBy'
    | 'contentHash'
    | 'updatedAt'
    | 'version'
    | 'accessCount'
    | 'lastAccessedAt'
  >
>;

export interface StorageAdapter {
  readonly name: string;

  /** Idempotent: create schema, verify extensions, warm pools. */
  init(): Promise<void>;
  close(): Promise<void>;
  healthCheck(): Promise<HealthStatus>;

  /* ----------------------------- memories ------------------------------- */

  insertMemories(memories: Memory[]): Promise<Memory[]>;
  getMemory(namespace: string, id: string): Promise<Memory | null>;
  getMemories(namespace: string, ids: string[]): Promise<Memory[]>;
  updateMemory(namespace: string, id: string, patch: MemoryPatch): Promise<Memory | null>;
  /** Soft-deletes unless `hard` is set. Soft deletes remain queryable for audit. */
  deleteMemory(namespace: string, id: string, hard?: boolean): Promise<boolean>;
  deleteMemories(namespace: string, filter: MemoryFilter, hard?: boolean): Promise<number>;
  listMemories(namespace: string, input: ResolvedListInput): Promise<Page<Memory>>;
  countMemories(namespace: string, filter?: MemoryFilter): Promise<number>;
  findByContentHash(namespace: string, contentHash: string): Promise<Memory | null>;
  /** Stream every matching memory in batches, for export and consolidation jobs. */
  iterateMemories(
    namespace: string,
    filter: MemoryFilter | undefined,
    batchSize: number,
  ): AsyncIterable<Memory[]>;

  /* ----------------------------- retrieval ------------------------------ */

  vectorSearch(namespace: string, options: VectorSearchOptions): Promise<ScoredId[]>;
  keywordSearch(namespace: string, options: KeywordSearchOptions): Promise<ScoredId[]>;
  /** Bump accessCount/lastAccessedAt. Fire-and-forget from the caller's view. */
  recordAccess(namespace: string, ids: string[]): Promise<void>;

  /* ------------------------------- graph -------------------------------- */

  upsertEntities(entities: Entity[]): Promise<Entity[]>;
  getEntity(namespace: string, id: string): Promise<Entity | null>;
  findEntityByNormalizedName(namespace: string, normalizedName: string): Promise<Entity | null>;
  listEntities(namespace: string, options: EntityListOptions): Promise<Page<Entity>>;
  deleteEntity(namespace: string, id: string): Promise<boolean>;

  upsertRelations(relations: Relation[]): Promise<Relation[]>;
  listRelations(namespace: string, options: RelationListOptions): Promise<Relation[]>;
  deleteRelation(namespace: string, id: string): Promise<boolean>;

  /* ------------------------------- admin -------------------------------- */

  stats(namespace: string, options?: StatsOptions): Promise<MemoryStats>;
  /** Hard-delete rows whose `expiresAt` has passed. Returns the number removed. */
  purgeExpired(namespace: string, now?: Date): Promise<number>;
  /** Remove every row in a namespace. Guarded behind admin scope at the API layer. */
  clearNamespace(namespace: string): Promise<number>;
}
