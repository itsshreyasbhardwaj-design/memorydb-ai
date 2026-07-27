/**
 * Core domain types for MemoryDB AI.
 *
 * Schemas are declared with Zod so that the exact same definitions validate
 * REST payloads, SDK inputs, and internal engine calls. Types are inferred
 * from the schemas rather than duplicated, so drift is impossible.
 */
import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/*                                 Primitives                                  */
/* -------------------------------------------------------------------------- */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const metadataSchema = z.record(z.string(), jsonValueSchema);
export type Metadata = z.infer<typeof metadataSchema>;

/** ISO-8601 timestamp string. Stored as text everywhere for portability. */
export const isoDateSchema = z.string().datetime({ offset: true });

/* -------------------------------------------------------------------------- */
/*                                Memory types                                 */
/* -------------------------------------------------------------------------- */

/**
 * The seven cognitive memory classes MemoryDB models. Each one carries a
 * distinct default retention strategy and retrieval prior — see `memory-types.ts`.
 */
export const MEMORY_TYPES = [
  /** Ephemeral scratch space for the current turn. Evicted aggressively. */
  'short_term',
  /** Durable facts that should survive indefinitely. */
  'long_term',
  /** Active task context for an in-flight agent run. */
  'working',
  /** Decontextualised knowledge: facts, definitions, preferences. */
  'semantic',
  /** Time-anchored events: "what happened, when, to whom". */
  'episodic',
  /** How-to knowledge: procedures, workflows, learned routines. */
  'procedural',
  /** Entity/relationship memory backing the knowledge graph. */
  'graph',
] as const;

export const memoryTypeSchema = z.enum(MEMORY_TYPES);
export type MemoryType = z.infer<typeof memoryTypeSchema>;

/** What the stored payload actually *is*, independent of its cognitive class. */
export const MEMORY_KINDS = [
  'conversation',
  'document',
  'note',
  'preference',
  'profile',
  'task',
  'event',
  'knowledge',
  'code',
  'other',
] as const;

export const memoryKindSchema = z.enum(MEMORY_KINDS);
export type MemoryKind = z.infer<typeof memoryKindSchema>;

export const MEMORY_STATUSES = ['active', 'archived', 'superseded', 'deleted'] as const;
export const memoryStatusSchema = z.enum(MEMORY_STATUSES);
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;

/* -------------------------------------------------------------------------- */
/*                                  Memory                                     */
/* -------------------------------------------------------------------------- */

export const memorySchema = z.object({
  id: z.string().min(1),
  /** Hard tenant boundary. Every query is scoped to exactly one namespace. */
  namespace: z.string().min(1),
  /** The human this memory is *about* (not necessarily the writer). */
  userId: z.string().nullable().default(null),
  /** The agent that wrote it, for provenance and per-agent recall. */
  agentId: z.string().nullable().default(null),
  /** Groups memories produced in one conversation or run. */
  sessionId: z.string().nullable().default(null),

  type: memoryTypeSchema,
  kind: memoryKindSchema,
  status: memoryStatusSchema.default('active'),

  content: z.string(),
  /** Consolidation-generated abstract; used for display and cheap re-embedding. */
  summary: z.string().nullable().default(null),
  title: z.string().nullable().default(null),

  metadata: metadataSchema.default({}),
  tags: z.array(z.string()).default([]),

  /** 0..1 — how much this memory should be favoured during retrieval. */
  importance: z.number().min(0).max(1).default(0.5),
  /** 0..1 — how much we trust the content to be correct. */
  confidence: z.number().min(0).max(1).default(1),

  /** Dense vector. Absent until the embedding job runs. */
  embedding: z.array(z.number()).nullable().default(null),
  embeddingModel: z.string().nullable().default(null),

  /** Approximate token count, used for budgeting context windows. */
  tokens: z.number().int().nonnegative().default(0),
  accessCount: z.number().int().nonnegative().default(0),
  lastAccessedAt: z.string().nullable().default(null),

  createdAt: z.string(),
  updatedAt: z.string(),
  /** Retention deadline. Null means "never expires". */
  expiresAt: z.string().nullable().default(null),
  archivedAt: z.string().nullable().default(null),

  /** Set when consolidation merges this record into a newer one. */
  supersededBy: z.string().nullable().default(null),
  /** Upstream provenance (document id, message id, external system key). */
  sourceId: z.string().nullable().default(null),
  /** Stable hash of normalised content — powers exact dedupe. */
  contentHash: z.string(),
  version: z.number().int().positive().default(1),
});

export type Memory = z.infer<typeof memorySchema>;

/* -------------------------------------------------------------------------- */
/*                              Write operations                               */
/* -------------------------------------------------------------------------- */

export const storeMemoryInputSchema = z.object({
  content: z.string().min(1, 'content must not be empty'),
  type: memoryTypeSchema.default('long_term'),
  kind: memoryKindSchema.default('note'),
  title: z.string().max(512).nullish(),
  summary: z.string().nullish(),
  userId: z.string().max(256).nullish(),
  agentId: z.string().max(256).nullish(),
  sessionId: z.string().max(256).nullish(),
  metadata: metadataSchema.optional(),
  tags: z.array(z.string().min(1).max(128)).max(64).optional(),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  sourceId: z.string().max(512).nullish(),
  /** Explicit retention override; otherwise derived from the memory type. */
  ttlSeconds: z.number().int().positive().nullish(),
  expiresAt: z.string().nullish(),
  /**
   * When true (default) an exact content-hash match inside the same namespace
   * is returned instead of inserting a duplicate.
   */
  deduplicate: z.boolean().default(true),
  /** Split long content into semantically coherent chunks before storing. */
  chunk: z.boolean().default(false),
});

export type StoreMemoryInput = z.input<typeof storeMemoryInputSchema>;
export type ResolvedStoreMemoryInput = z.output<typeof storeMemoryInputSchema>;

export const updateMemoryInputSchema = z
  .object({
    content: z.string().min(1).optional(),
    title: z.string().max(512).nullish(),
    summary: z.string().nullish(),
    type: memoryTypeSchema.optional(),
    kind: memoryKindSchema.optional(),
    status: memoryStatusSchema.optional(),
    metadata: metadataSchema.optional(),
    /** Replaces the tag set wholesale. Use `addTags`/`removeTags` for deltas. */
    tags: z.array(z.string().min(1).max(128)).max(64).optional(),
    addTags: z.array(z.string().min(1).max(128)).max(64).optional(),
    removeTags: z.array(z.string().min(1).max(128)).max(64).optional(),
    importance: z.number().min(0).max(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
    expiresAt: z.string().nullish(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'update requires at least one field' });

export type UpdateMemoryInput = z.infer<typeof updateMemoryInputSchema>;

/* -------------------------------------------------------------------------- */
/*                                  Filters                                    */
/* -------------------------------------------------------------------------- */

/** Metadata predicates. Mongo-ish operators kept deliberately small and pushable to SQL. */
export const metadataFilterSchema = z.record(
  z.string(),
  z.union([
    jsonValueSchema,
    z.object({
      eq: jsonValueSchema.optional(),
      ne: jsonValueSchema.optional(),
      gt: z.number().optional(),
      gte: z.number().optional(),
      lt: z.number().optional(),
      lte: z.number().optional(),
      in: z.array(jsonValueSchema).optional(),
      nin: z.array(jsonValueSchema).optional(),
      contains: z.string().optional(),
      exists: z.boolean().optional(),
    }),
  ]),
);

export type MetadataFilter = z.infer<typeof metadataFilterSchema>;

export const memoryFilterSchema = z.object({
  type: z.union([memoryTypeSchema, z.array(memoryTypeSchema)]).optional(),
  kind: z.union([memoryKindSchema, z.array(memoryKindSchema)]).optional(),
  status: z.union([memoryStatusSchema, z.array(memoryStatusSchema)]).optional(),
  userId: z.string().optional(),
  agentId: z.string().optional(),
  sessionId: z.string().optional(),
  sourceId: z.string().optional(),
  ids: z.array(z.string()).optional(),
  /** Every listed tag must be present. */
  tags: z.array(z.string()).optional(),
  /** At least one listed tag must be present. */
  anyTags: z.array(z.string()).optional(),
  metadata: metadataFilterSchema.optional(),
  createdAfter: z.string().optional(),
  createdBefore: z.string().optional(),
  updatedAfter: z.string().optional(),
  updatedBefore: z.string().optional(),
  minImportance: z.number().min(0).max(1).optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  /** Excluded by default; set true to include expired-but-not-yet-swept rows. */
  includeExpired: z.boolean().optional(),
  includeArchived: z.boolean().optional(),
});

export type MemoryFilter = z.infer<typeof memoryFilterSchema>;

/* -------------------------------------------------------------------------- */
/*                                  Retrieval                                  */
/* -------------------------------------------------------------------------- */

export const SEARCH_MODES = ['hybrid', 'semantic', 'keyword'] as const;
export const searchModeSchema = z.enum(SEARCH_MODES);
export type SearchMode = z.infer<typeof searchModeSchema>;

export const searchInputSchema = z.object({
  query: z.string().min(1),
  mode: searchModeSchema.default('hybrid'),
  limit: z.number().int().positive().max(200).default(10),
  offset: z.number().int().nonnegative().default(0),
  filter: memoryFilterSchema.optional(),
  /** Drop results scoring below this after fusion and re-ranking. */
  minScore: z.number().min(0).max(1).default(0),
  /** Relative weight of the dense vector leg in hybrid mode. */
  vectorWeight: z.number().min(0).max(1).default(0.6),
  /** Relative weight of the lexical BM25 leg in hybrid mode. */
  keywordWeight: z.number().min(0).max(1).default(0.4),
  /** Exponential recency decay half-life. 0 disables recency weighting. */
  recencyHalfLifeDays: z.number().nonnegative().default(30),
  /** How strongly `importance` boosts the final score (0..1). */
  importanceWeight: z.number().min(0).max(1).default(0.15),
  /** Candidate pool size pulled from each leg before fusion. */
  candidateMultiplier: z.number().int().min(1).max(20).default(4),
  /**
   * Absolute cosine floor for the dense leg. Candidates at or below this are
   * dropped before fusion. The default of 0 discards only non-positive
   * similarity (genuinely unrelated); relevance calibration in the ranking
   * stage handles the rest, so this rarely needs raising.
   */
  minVectorSimilarity: z.number().min(0).max(1).default(0),
  /** Record an access event (increments accessCount) for returned memories. */
  trackAccess: z.boolean().default(false),
  /** Include the raw per-signal score breakdown in each hit. */
  explain: z.boolean().default(false),
});

export type SearchInput = z.input<typeof searchInputSchema>;
export type ResolvedSearchInput = z.output<typeof searchInputSchema>;

/** Per-signal score breakdown, returned when `explain` is set. */
export interface ScoreBreakdown {
  vector: number;
  keyword: number;
  fusion: number;
  recency: number;
  importance: number;
  confidence: number;
  final: number;
}

export interface Citation {
  memoryId: string;
  title: string | null;
  sourceId: string | null;
  createdAt: string;
  /** Character offsets of the best-matching span inside `content`. */
  span: { start: number; end: number } | null;
  snippet: string;
}

export interface SearchHit {
  memory: Memory;
  /** Final blended relevance in 0..1. */
  score: number;
  rank: number;
  citation: Citation;
  scores?: ScoreBreakdown;
}

export interface SearchResult {
  hits: SearchHit[];
  total: number;
  mode: SearchMode;
  query: string;
  /** Wall-clock milliseconds spent inside the engine. */
  tookMs: number;
}

/* -------------------------------------------------------------------------- */
/*                            Intelligent retrieval                            */
/* -------------------------------------------------------------------------- */

export const retrieveInputSchema = searchInputSchema.extend({
  /** Hard cap on the tokens the returned set may occupy. */
  tokenBudget: z.number().int().positive().max(200_000).default(4000),
  /** Collapse near-identical hits so the budget isn't wasted on repeats. */
  diversify: z.boolean().default(true),
  /** Cosine similarity above which two hits count as redundant. */
  diversityThreshold: z.number().min(0).max(1).default(0.92),
  /** Emit a ready-to-paste context block alongside the structured hits. */
  formatContext: z.boolean().default(true),
});

export type RetrieveInput = z.input<typeof retrieveInputSchema>;
export type ResolvedRetrieveInput = z.output<typeof retrieveInputSchema>;

export interface RetrieveResult extends SearchResult {
  /** Model-ready context block with inline `[n]` citation markers. */
  context: string;
  citations: Citation[];
  tokensUsed: number;
  /** 0..1 aggregate confidence that the returned set answers the query. */
  confidence: number;
  /** Hits dropped by the diversity filter or the token budget. */
  dropped: number;
}

/* -------------------------------------------------------------------------- */
/*                              Knowledge graph                                */
/* -------------------------------------------------------------------------- */

export const ENTITY_TYPES = [
  'person',
  'project',
  'concept',
  'file',
  'organization',
  'event',
  'location',
  'product',
  'technology',
  'other',
] as const;

export const entityTypeSchema = z.enum(ENTITY_TYPES);
export type EntityType = z.infer<typeof entityTypeSchema>;

export const entitySchema = z.object({
  id: z.string(),
  namespace: z.string(),
  type: entityTypeSchema,
  /** Display form, e.g. "Ada Lovelace". */
  name: z.string(),
  /** Case/whitespace-normalised key used for resolution and dedupe. */
  normalizedName: z.string(),
  aliases: z.array(z.string()).default([]),
  description: z.string().nullable().default(null),
  metadata: metadataSchema.default({}),
  /** Number of memories this entity was observed in. */
  mentionCount: z.number().int().nonnegative().default(0),
  salience: z.number().min(0).max(1).default(0),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
});

export type Entity = z.infer<typeof entitySchema>;

export const RELATION_TYPES = [
  'mentions',
  'related_to',
  'works_on',
  'works_at',
  'part_of',
  'located_in',
  'created_by',
  'depends_on',
  'occurred_at',
  'knows',
  'derived_from',
] as const;

export const relationTypeSchema = z.enum(RELATION_TYPES);
export type RelationType = z.infer<typeof relationTypeSchema>;

export const relationSchema = z.object({
  id: z.string(),
  namespace: z.string(),
  sourceId: z.string(),
  targetId: z.string(),
  type: relationTypeSchema,
  /** Edge strength in 0..1, reinforced by repeated co-occurrence. */
  weight: z.number().min(0).max(1).default(0.5),
  confidence: z.number().min(0).max(1).default(0.5),
  /** Memories that evidence this edge. */
  memoryIds: z.array(z.string()).default([]),
  metadata: metadataSchema.default({}),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Relation = z.infer<typeof relationSchema>;

export interface GraphNode extends Entity {
  degree: number;
}

export interface GraphEdge extends Relation {
  sourceName: string;
  targetName: string;
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    nodeCount: number;
    edgeCount: number;
    density: number;
    topEntities: Array<{ id: string; name: string; type: EntityType; degree: number }>;
  };
}

/* -------------------------------------------------------------------------- */
/*                                 Statistics                                  */
/* -------------------------------------------------------------------------- */

export interface MemoryStats {
  total: number;
  active: number;
  archived: number;
  superseded: number;
  byType: Record<MemoryType, number>;
  byKind: Record<MemoryKind, number>;
  totalTokens: number;
  avgImportance: number;
  /** Daily counts for the requested window, oldest first. */
  growth: Array<{ date: string; count: number; cumulative: number }>;
  topTags: Array<{ tag: string; count: number }>;
  entityCount: number;
  relationCount: number;
  storageBytes: number;
  oldestMemoryAt: string | null;
  newestMemoryAt: string | null;
}

/* -------------------------------------------------------------------------- */
/*                                  Paging                                     */
/* -------------------------------------------------------------------------- */

export const listInputSchema = z.object({
  filter: memoryFilterSchema.optional(),
  limit: z.number().int().positive().max(500).default(50),
  offset: z.number().int().nonnegative().default(0),
  sortBy: z
    .enum(['createdAt', 'updatedAt', 'importance', 'accessCount', 'lastAccessedAt'])
    .default('createdAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

export type ListInput = z.input<typeof listInputSchema>;
export type ResolvedListInput = z.output<typeof listInputSchema>;

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}
