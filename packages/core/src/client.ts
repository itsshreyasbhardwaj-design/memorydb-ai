/**
 * `MemoryClient` — the public engine surface.
 *
 * Everything a developer touches goes through this class: store, retrieve,
 * search, update, delete, plus consolidation, graph, and stats. It composes the
 * storage adapter, embedding provider, graph service, and consolidator, and
 * owns the retrieval pipeline that turns a query into ranked, cited memories.
 */
import type {
  Citation,
  Entity,
  KnowledgeGraph,
  ListInput,
  Memory,
  MemoryFilter,
  MemoryStats,
  MemoryType,
  Page,
  ResolvedRetrieveInput,
  ResolvedSearchInput,
  RetrieveInput,
  RetrieveResult,
  SearchHit,
  SearchInput,
  SearchResult,
  StoreMemoryInput,
  UpdateMemoryInput,
} from './types.js';
import {
  listInputSchema,
  retrieveInputSchema,
  searchInputSchema,
  storeMemoryInputSchema,
  updateMemoryInputSchema,
} from './types.js';
import type { HealthStatus, MemoryPatch, ScoredId, StorageAdapter } from './storage/types.js';
import { InMemoryStorageAdapter } from './storage/memory-adapter.js';
import type { EmbeddingProvider } from './embeddings/index.js';
import { createEmbeddingProvider } from './embeddings/index.js';
import type { EntityExtractor } from './graph/extractor.js';
import { createDefaultExtractor } from './graph/extractor.js';
import { GraphService } from './graph/service.js';
import type { GraphQueryOptions } from './graph/service.js';
import type { ConsolidationOptions, ConsolidationReport } from './consolidation/index.js';
import { Consolidator } from './consolidation/index.js';
import type { Summarizer } from './consolidation/summarizer.js';
import type { RetentionOverrides, RetentionPolicy } from './retention.js';
import { boostImportance, computeExpiry, resolveRetentionPolicies } from './retention.js';
import { fuse } from './search/fusion.js';
import { diversify, rankMemories } from './search/ranking.js';
import { NotFoundError, ValidationError, toMemoryDBError } from './errors.js';
import type { Logger } from './logger.js';
import { noopLogger } from './logger.js';
import { Metrics } from './metrics.js';
import { contentHash } from './util/hash.js';
import { generateId } from './util/id.js';
import { bestMatchingSpan, chunkText, estimateTokens, truncate } from './util/text.js';

export interface MemoryClientOptions {
  /** Defaults to the in-memory adapter, so the client works with no setup. */
  storage?: StorageAdapter;
  /** Defaults to the free, offline local provider. */
  embeddings?: EmbeddingProvider;
  extractor?: EntityExtractor;
  summarizer?: Summarizer;
  logger?: Logger;
  metrics?: Metrics;
  /** Tenant scope for every operation. */
  namespace?: string;
  retention?: RetentionOverrides;
  /** Extract entities on write. Adds latency; disable for bulk ingestion. */
  autoExtractGraph?: boolean;
  /** Embed on write. Disable to defer embedding to a background job. */
  autoEmbed?: boolean;
  /** Token size for automatic chunking when `chunk: true` is passed to `store`. */
  chunkTokens?: number;
  chunkOverlapTokens?: number;
}

export interface StoreResult {
  memory: Memory;
  /** True when an existing memory was returned instead of inserting a duplicate. */
  deduplicated: boolean;
  /** Populated when the input was split into multiple chunk memories. */
  chunks?: Memory[];
  entitiesExtracted: number;
}

export class MemoryClient {
  readonly storage: StorageAdapter;
  readonly embeddings: EmbeddingProvider;
  readonly namespace: string;
  readonly metrics: Metrics;

  private readonly graphService: GraphService;
  private readonly consolidator: Consolidator;
  private readonly policies: Record<MemoryType, RetentionPolicy>;
  private readonly logger: Logger;
  private readonly autoExtractGraph: boolean;
  private readonly autoEmbed: boolean;
  private readonly chunkTokens: number;
  private readonly chunkOverlapTokens: number;
  private readonly options: MemoryClientOptions;
  private initialized = false;

  constructor(options: MemoryClientOptions = {}) {
    this.options = options;
    this.storage = options.storage ?? new InMemoryStorageAdapter();
    this.embeddings = options.embeddings ?? createEmbeddingProvider();
    this.namespace = options.namespace ?? 'default';
    this.logger = options.logger ?? noopLogger;
    this.metrics = options.metrics ?? new Metrics();
    this.policies = resolveRetentionPolicies(options.retention);
    this.autoExtractGraph = options.autoExtractGraph ?? true;
    this.autoEmbed = options.autoEmbed ?? true;
    this.chunkTokens = options.chunkTokens ?? 512;
    this.chunkOverlapTokens = options.chunkOverlapTokens ?? 64;

    this.graphService = new GraphService(this.storage, options.extractor ?? createDefaultExtractor());
    this.consolidator = new Consolidator(this.storage, this.policies, {
      ...(options.summarizer ? { summarizer: options.summarizer } : {}),
      logger: this.logger,
      fullConfidenceSimilarity: this.embeddings.fullConfidenceSimilarity,
    });
  }

  /** Construct and initialise in one step. */
  static async create(options: MemoryClientOptions = {}): Promise<MemoryClient> {
    const client = new MemoryClient(options);
    await client.init();
    return client;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.storage.init();
    this.initialized = true;
    this.logger.info('memory client ready', {
      adapter: this.storage.name,
      embeddingModel: this.embeddings.model,
      dimensions: this.embeddings.dimensions,
      namespace: this.namespace,
    });
  }

  async close(): Promise<void> {
    await this.storage.close();
    this.initialized = false;
  }

  /** A client bound to a different namespace, sharing all other dependencies. */
  forNamespace(namespace: string): MemoryClient {
    const client = new MemoryClient({ ...this.options, namespace });
    // Same-class private access: the new client shares our already-initialised
    // storage, so it must not re-run init.
    client.initialized = this.initialized;
    return client;
  }

  async health(): Promise<HealthStatus & { embeddings: { provider: string; model: string; dimensions: number } }> {
    const status = await this.storage.healthCheck();
    return {
      ...status,
      embeddings: {
        provider: this.embeddings.id,
        model: this.embeddings.model,
        dimensions: this.embeddings.dimensions,
      },
    };
  }

  /* ======================================================================== */
  /*                                  Write                                   */
  /* ======================================================================== */

  /**
   * Store a memory.
   *
   * Handles validation, deduplication, retention, embedding, chunking, and
   * graph extraction. Returns the stored memory plus what happened to it.
   */
  async store(input: StoreMemoryInput): Promise<StoreResult> {
    return this.metrics.time('store', async () => {
      const parsed = storeMemoryInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new ValidationError('invalid store input', parsed.error.flatten());
      }
      const data = parsed.data;

      // Long inputs are chunked so each piece embeds cleanly — a single vector
      // over 10k tokens is too diffuse to retrieve anything precisely.
      if (data.chunk && estimateTokens(data.content) > this.chunkTokens) {
        return this.storeChunked(data);
      }

      const hash = await contentHash(data.content, data.userId ?? undefined);

      if (data.deduplicate) {
        const existing = await this.storage.findByContentHash(this.namespace, hash);
        if (existing) {
          this.metrics.increment('store.deduplicated');
          return { memory: existing, deduplicated: true, entitiesExtracted: 0 };
        }
      }

      const now = new Date();
      const nowIso = now.toISOString();
      const embedding = this.autoEmbed ? await this.embedText(data.content) : null;

      const memory: Memory = {
        id: generateId('mem'),
        namespace: this.namespace,
        userId: data.userId ?? null,
        agentId: data.agentId ?? null,
        sessionId: data.sessionId ?? null,
        type: data.type,
        kind: data.kind,
        status: 'active',
        content: data.content,
        summary: data.summary ?? null,
        title: data.title ?? null,
        metadata: data.metadata ?? {},
        tags: data.tags ?? [],
        importance: data.importance ?? defaultImportance(data.type),
        confidence: data.confidence ?? 1,
        embedding,
        embeddingModel: embedding ? this.embeddings.model : null,
        tokens: estimateTokens(data.content),
        accessCount: 0,
        lastAccessedAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        expiresAt: computeExpiry(data.type, this.policies, {
          ttlSeconds: data.ttlSeconds ?? null,
          expiresAt: data.expiresAt ?? null,
          now,
        }),
        archivedAt: null,
        supersededBy: null,
        sourceId: data.sourceId ?? null,
        contentHash: hash,
        version: 1,
      };

      const [stored] = await this.storage.insertMemories([memory]);
      if (!stored) throw toMemoryDBError(new Error('storage did not return the inserted memory'));

      let entitiesExtracted = 0;
      if (this.autoExtractGraph) {
        try {
          const result = await this.graphService.ingestMemory(stored);
          entitiesExtracted = result.entities.length;
        } catch (err) {
          // Graph extraction is enrichment — never fail a write because of it.
          this.logger.warn('graph extraction failed', { memoryId: stored.id, error: err });
        }
      }

      this.metrics.increment('store.created');
      return { memory: stored, deduplicated: false, entitiesExtracted };
    });
  }

  private async storeChunked(data: ReturnType<typeof storeMemoryInputSchema.parse>): Promise<StoreResult> {
    const pieces = chunkText(data.content, {
      maxTokens: this.chunkTokens,
      overlapTokens: this.chunkOverlapTokens,
    });
    if (pieces.length === 0) throw new ValidationError('content produced no chunks');

    const parentId = generateId('mem');
    const now = new Date();
    const nowIso = now.toISOString();
    const embeddings = this.autoEmbed
      ? await this.embeddings.embed(pieces.map((piece) => piece.content))
      : pieces.map(() => null);

    const memories: Memory[] = [];
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      if (!piece) continue;
      const embedding = embeddings[i] ?? null;

      memories.push({
        id: i === 0 ? parentId : generateId('mem'),
        namespace: this.namespace,
        userId: data.userId ?? null,
        agentId: data.agentId ?? null,
        sessionId: data.sessionId ?? null,
        type: data.type,
        kind: data.kind,
        status: 'active',
        content: piece.content,
        summary: null,
        title: data.title ? `${data.title} (${i + 1}/${pieces.length})` : null,
        metadata: {
          ...(data.metadata ?? {}),
          chunkIndex: i,
          chunkCount: pieces.length,
          parentId,
          charStart: piece.start,
          charEnd: piece.end,
        },
        tags: data.tags ?? [],
        importance: data.importance ?? defaultImportance(data.type),
        confidence: data.confidence ?? 1,
        embedding,
        embeddingModel: embedding ? this.embeddings.model : null,
        tokens: piece.tokens,
        accessCount: 0,
        lastAccessedAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        expiresAt: computeExpiry(data.type, this.policies, {
          ttlSeconds: data.ttlSeconds ?? null,
          expiresAt: data.expiresAt ?? null,
          now,
        }),
        archivedAt: null,
        supersededBy: null,
        sourceId: data.sourceId ?? null,
        contentHash: await contentHash(piece.content, `${parentId}:${i}`),
        version: 1,
      });
    }

    const stored = await this.storage.insertMemories(memories);
    const first = stored[0];
    if (!first) throw toMemoryDBError(new Error('storage did not return inserted chunks'));

    let entitiesExtracted = 0;
    if (this.autoExtractGraph) {
      try {
        // Extract from the whole document, not per chunk, so relations spanning
        // a chunk boundary are still found.
        const result = await this.graphService.ingestMemory({ ...first, content: data.content });
        entitiesExtracted = result.entities.length;
      } catch (err) {
        this.logger.warn('graph extraction failed for chunked memory', { parentId, error: err });
      }
    }

    this.metrics.increment('store.created', stored.length);
    return { memory: first, deduplicated: false, chunks: stored, entitiesExtracted };
  }

  /** Bulk store. Embeddings are computed in one batched call. */
  async storeMany(inputs: StoreMemoryInput[]): Promise<StoreResult[]> {
    if (inputs.length === 0) return [];

    return this.metrics.time('storeMany', async () => {
      const parsed = inputs.map((input) => {
        const result = storeMemoryInputSchema.safeParse(input);
        if (!result.success) throw new ValidationError('invalid store input', result.error.flatten());
        return result.data;
      });

      const hashes = await Promise.all(
        parsed.map((data) => contentHash(data.content, data.userId ?? undefined)),
      );

      // Resolve duplicates before embedding — no point paying to embed a repeat.
      const existing = await Promise.all(
        parsed.map((data, i) =>
          data.deduplicate ? this.storage.findByContentHash(this.namespace, hashes[i] as string) : null,
        ),
      );

      // Two records in the *same* batch can be duplicates of each other, which a
      // storage lookup can't catch because neither is persisted yet. Track hashes
      // as we go and point later copies at the first occurrence.
      const toInsert: number[] = [];
      const firstOccurrence = new Map<string, number>();
      const duplicateOf = new Map<number, number>();

      parsed.forEach((data, i) => {
        if (existing[i]) return;
        const hash = hashes[i] as string;
        if (data.deduplicate) {
          const seen = firstOccurrence.get(hash);
          if (seen !== undefined) {
            duplicateOf.set(i, seen);
            return;
          }
          firstOccurrence.set(hash, i);
        }
        toInsert.push(i);
      });

      const embeddings = this.autoEmbed
        ? await this.embeddings.embed(toInsert.map((i) => (parsed[i] as (typeof parsed)[number]).content))
        : [];

      const now = new Date();
      const nowIso = now.toISOString();
      const memories: Memory[] = toInsert.map((sourceIndex, position) => {
        const data = parsed[sourceIndex] as (typeof parsed)[number];
        const embedding = this.autoEmbed ? (embeddings[position] ?? null) : null;

        return {
          id: generateId('mem'),
          namespace: this.namespace,
          userId: data.userId ?? null,
          agentId: data.agentId ?? null,
          sessionId: data.sessionId ?? null,
          type: data.type,
          kind: data.kind,
          status: 'active',
          content: data.content,
          summary: data.summary ?? null,
          title: data.title ?? null,
          metadata: data.metadata ?? {},
          tags: data.tags ?? [],
          importance: data.importance ?? defaultImportance(data.type),
          confidence: data.confidence ?? 1,
          embedding,
          embeddingModel: embedding ? this.embeddings.model : null,
          tokens: estimateTokens(data.content),
          accessCount: 0,
          lastAccessedAt: null,
          createdAt: nowIso,
          updatedAt: nowIso,
          expiresAt: computeExpiry(data.type, this.policies, {
            ttlSeconds: data.ttlSeconds ?? null,
            expiresAt: data.expiresAt ?? null,
            now,
          }),
          archivedAt: null,
          supersededBy: null,
          sourceId: data.sourceId ?? null,
          contentHash: hashes[sourceIndex] as string,
          version: 1,
        };
      });

      const inserted = memories.length > 0 ? await this.storage.insertMemories(memories) : [];
      const insertedById = new Map(toInsert.map((sourceIndex, position) => [sourceIndex, inserted[position]]));

      if (this.autoExtractGraph) {
        for (const memory of inserted) {
          try {
            await this.graphService.ingestMemory(memory);
          } catch (err) {
            this.logger.warn('graph extraction failed', { memoryId: memory.id, error: err });
          }
        }
      }

      this.metrics.increment('store.created', inserted.length);
      this.metrics.increment('store.deduplicated', parsed.length - inserted.length);

      return parsed.map((_, i) => {
        const duplicate = existing[i];
        if (duplicate) return { memory: duplicate, deduplicated: true, entitiesExtracted: 0 };

        const original = duplicateOf.get(i);
        if (original !== undefined) {
          const memory = insertedById.get(original);
          if (!memory) throw toMemoryDBError(new Error('storage did not return an inserted memory'));
          return { memory, deduplicated: true, entitiesExtracted: 0 };
        }

        const memory = insertedById.get(i);
        if (!memory) throw toMemoryDBError(new Error('storage did not return an inserted memory'));
        return { memory, deduplicated: false, entitiesExtracted: 0 };
      });
    });
  }

  async get(id: string): Promise<Memory | null> {
    return this.storage.getMemory(this.namespace, id);
  }

  async update(id: string, input: UpdateMemoryInput): Promise<Memory> {
    const parsed = updateMemoryInputSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError('invalid update input', parsed.error.flatten());

    const existing = await this.storage.getMemory(this.namespace, id);
    if (!existing) throw new NotFoundError('memory', id);

    const data = parsed.data;
    const patch: MemoryPatch = { updatedAt: new Date().toISOString(), version: existing.version + 1 };

    if (data.content !== undefined && data.content !== existing.content) {
      patch.content = data.content;
      patch.contentHash = await contentHash(data.content, existing.userId ?? undefined);
      patch.tokens = estimateTokens(data.content);
      // Content changed, so the stored vector is stale — recompute it.
      if (this.autoEmbed) {
        patch.embedding = await this.embedText(data.content);
        patch.embeddingModel = this.embeddings.model;
      }
    }

    if (data.title !== undefined) patch.title = data.title ?? null;
    if (data.summary !== undefined) patch.summary = data.summary ?? null;
    if (data.type !== undefined) patch.type = data.type;
    if (data.kind !== undefined) patch.kind = data.kind;
    if (data.status !== undefined) {
      patch.status = data.status;
      if (data.status === 'archived') patch.archivedAt = new Date().toISOString();
    }
    if (data.metadata !== undefined) patch.metadata = { ...existing.metadata, ...data.metadata };
    if (data.importance !== undefined) patch.importance = data.importance;
    if (data.confidence !== undefined) patch.confidence = data.confidence;
    if (data.expiresAt !== undefined) patch.expiresAt = data.expiresAt ?? null;

    if (data.tags !== undefined) {
      patch.tags = data.tags;
    } else if (data.addTags || data.removeTags) {
      const next = new Set(existing.tags);
      for (const tag of data.addTags ?? []) next.add(tag);
      for (const tag of data.removeTags ?? []) next.delete(tag);
      patch.tags = Array.from(next);
    }

    const updated = await this.storage.updateMemory(this.namespace, id, patch);
    if (!updated) throw new NotFoundError('memory', id);
    this.metrics.increment('update');
    return updated;
  }

  /** Soft-delete by default; `hard` removes the row entirely. */
  async delete(id: string, hard = false): Promise<boolean> {
    const deleted = await this.storage.deleteMemory(this.namespace, id, hard);
    if (deleted) this.metrics.increment('delete');
    return deleted;
  }

  async deleteMany(filter: MemoryFilter, hard = false): Promise<number> {
    const count = await this.storage.deleteMemories(this.namespace, filter, hard);
    this.metrics.increment('delete', count);
    return count;
  }

  async list(input: ListInput = {}): Promise<Page<Memory>> {
    const parsed = listInputSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError('invalid list input', parsed.error.flatten());
    return this.storage.listMemories(this.namespace, parsed.data);
  }

  async count(filter?: MemoryFilter): Promise<number> {
    return this.storage.countMemories(this.namespace, filter);
  }

  /* ======================================================================== */
  /*                                 Retrieval                                */
  /* ======================================================================== */

  /**
   * Hybrid search.
   *
   * Runs the dense and lexical legs concurrently, fuses them, hydrates the
   * winners, re-ranks with contextual priors, and attaches citations.
   */
  async search(input: SearchInput): Promise<SearchResult> {
    const parsed = searchInputSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError('invalid search input', parsed.error.flatten());
    return this.executeSearch(parsed.data);
  }

  private async executeSearch(options: ResolvedSearchInput): Promise<SearchResult> {
    const startedAt = performance.now();
    // Over-fetch so fusion and re-ranking have real choices to make.
    const candidateLimit = Math.min(500, (options.limit + options.offset) * options.candidateMultiplier);

    const useVector = options.mode !== 'keyword';
    const useKeyword = options.mode !== 'semantic';

    const [vectorResults, keywordResults] = await Promise.all([
      useVector
        ? this.runVectorLeg(options.query, candidateLimit, options.filter, options.minVectorSimilarity)
        : Promise.resolve([]),
      useKeyword
        ? this.storage.keywordSearch(this.namespace, {
            query: options.query,
            limit: candidateLimit,
            filter: options.filter,
          })
        : Promise.resolve([]),
    ]);

    const fused = fuse(
      [
        { name: 'vector', results: vectorResults, weight: useVector ? options.vectorWeight : 0 },
        { name: 'keyword', results: keywordResults, weight: useKeyword ? options.keywordWeight : 0 },
      ],
      { limit: candidateLimit },
    );

    if (fused.length === 0) {
      return { hits: [], total: 0, mode: options.mode, query: options.query, tookMs: performance.now() - startedAt };
    }

    const memories = await this.storage.getMemories(
      this.namespace,
      fused.map((entry) => entry.id),
    );
    const memoryById = new Map(memories.map((memory) => [memory.id, memory]));

    // Fusion output is purely *relative*: whatever ranks first in a pool of
    // uniformly irrelevant candidates still scores ~1.0, because rank-based
    // fusion deliberately discards magnitude. Multiplying by an absolute
    // evidence term restores a calibrated scale, so `minScore` filters on
    // "how good is this really?" rather than "how good is this compared to the
    // other things that happened to come back?".
    const bestKeyword = Math.max(1e-9, ...keywordResults.map((result) => result.score));
    const fullConfidence = Math.max(0.01, this.embeddings.fullConfidenceSimilarity);

    const ranked = rankMemories(
      fused
        .map((entry) => {
          const memory = memoryById.get(entry.id);
          if (!memory) return null;

          // A negative cosine means "unrelated", not "anti-related" — clamp to 0
          // rather than mapping it onto the middle of the range.
          const rawVector = Math.max(0, entry.legScores.vector ?? 0);
          const vector = Math.min(1, rawVector / fullConfidence);

          // BM25 only returns documents sharing a non-stopword term with the
          // query, so any hit at all is genuine lexical evidence — hence the
          // 0.5 floor, scaled up by strength relative to the best hit.
          const rawKeyword = entry.legScores.keyword;
          const keyword = rawKeyword === undefined ? 0 : 0.5 + 0.5 * (rawKeyword / bestKeyword);

          const evidence = Math.max(vector, keyword);
          // Fusion modulates ordering inside the ceiling that evidence sets.
          return { memory, relevance: evidence * (0.7 + 0.3 * entry.score), vector, keyword };
        })
        .filter((item): item is NonNullable<typeof item> => item !== null),
      {
        recencyHalfLifeDays: options.recencyHalfLifeDays,
        importanceWeight: options.importanceWeight,
      },
    );

    const filtered = ranked.filter((item) => item.score >= options.minScore);
    const paged = filtered.slice(options.offset, options.offset + options.limit);

    const hits: SearchHit[] = paged.map((item, index) => ({
      memory: item.memory,
      score: item.score,
      rank: options.offset + index + 1,
      citation: buildCitation(item.memory, options.query),
      ...(options.explain ? { scores: item.breakdown } : {}),
    }));

    if (options.trackAccess && hits.length > 0) {
      // Deliberately not awaited: recall latency shouldn't pay for bookkeeping.
      void this.trackAccess(hits.map((hit) => hit.memory)).catch((err) =>
        this.logger.warn('access tracking failed', { error: err }),
      );
    }

    const tookMs = performance.now() - startedAt;
    this.metrics.observe('search', tookMs, { mode: options.mode });

    return { hits, total: filtered.length, mode: options.mode, query: options.query, tookMs };
  }

  private async runVectorLeg(
    query: string,
    limit: number,
    filter: MemoryFilter | undefined,
    minSimilarity: number,
  ): Promise<ScoredId[]> {
    try {
      const embedding = await this.embedText(query);
      if (!embedding) return [];
      return await this.storage.vectorSearch(this.namespace, { embedding, limit, filter, minSimilarity });
    } catch (err) {
      // Degrade to lexical-only rather than failing the whole query.
      this.logger.warn('vector leg failed; falling back to keyword only', { error: err });
      this.metrics.increment('search.vector_leg_failed');
      return [];
    }
  }

  /**
   * Intelligent retrieval.
   *
   * Search, then shape the result for direct use as model context: redundant
   * hits are dropped, a token budget is enforced, a formatted context block
   * with inline citation markers is produced, and an aggregate confidence is
   * reported so callers can decide whether the memory store actually knew
   * anything useful.
   */
  async retrieve(input: RetrieveInput): Promise<RetrieveResult> {
    const parsed = retrieveInputSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError('invalid retrieve input', parsed.error.flatten());
    const options: ResolvedRetrieveInput = parsed.data;

    // Pull extra candidates so diversification has something to discard.
    const searchResult = await this.executeSearch({
      ...options,
      limit: Math.min(200, options.limit * 3),
      offset: 0,
    });

    let hits = searchResult.hits;
    let dropped = 0;

    if (options.diversify) {
      const result = diversify(hits, options.diversityThreshold, options.limit);
      hits = result.kept;
      dropped += result.dropped;
    } else {
      dropped += Math.max(0, hits.length - options.limit);
      hits = hits.slice(0, options.limit);
    }

    // Enforce the token budget, highest-scoring first.
    const withinBudget: SearchHit[] = [];
    let tokensUsed = 0;
    for (const hit of hits) {
      const cost = hit.memory.tokens || estimateTokens(hit.memory.content);
      if (tokensUsed + cost > options.tokenBudget) {
        dropped++;
        continue;
      }
      withinBudget.push(hit);
      tokensUsed += cost;
    }

    const reranked = withinBudget.map((hit, index) => ({ ...hit, rank: index + 1 }));
    const citations = reranked.map((hit) => hit.citation);

    return {
      hits: reranked,
      total: searchResult.total,
      mode: searchResult.mode,
      query: searchResult.query,
      tookMs: searchResult.tookMs,
      context: options.formatContext ? formatContext(reranked) : '',
      citations,
      tokensUsed,
      confidence: aggregateConfidence(reranked),
      dropped,
    };
  }

  /** Record recall: bump access counters and apply the retention importance boost. */
  private async trackAccess(memories: Memory[]): Promise<void> {
    await this.storage.recordAccess(
      this.namespace,
      memories.map((memory) => memory.id),
    );

    for (const memory of memories) {
      const boosted = boostImportance(memory.importance, memory.type, this.policies);
      // Only write when the boost actually moves the value.
      if (Math.abs(boosted - memory.importance) > 1e-6) {
        await this.storage.updateMemory(this.namespace, memory.id, { importance: boosted });
      }
    }
  }

  private async embedText(text: string): Promise<number[] | null> {
    const [vector] = await this.embeddings.embed([text]);
    return vector ?? null;
  }

  /**
   * Backfill embeddings for memories missing them, or re-embed everything after
   * a model change. Returns the number of memories updated.
   */
  async reindex(options: { batchSize?: number; force?: boolean } = {}): Promise<number> {
    const batchSize = options.batchSize ?? 100;
    let updated = 0;

    for await (const batch of this.storage.iterateMemories(this.namespace, { status: 'active' }, batchSize)) {
      const stale = batch.filter(
        (memory) => options.force || !memory.embedding || memory.embeddingModel !== this.embeddings.model,
      );
      if (stale.length === 0) continue;

      const vectors = await this.embeddings.embed(stale.map((memory) => memory.content));
      for (let i = 0; i < stale.length; i++) {
        const memory = stale[i];
        const vector = vectors[i];
        if (!memory || !vector) continue;
        await this.storage.updateMemory(this.namespace, memory.id, {
          embedding: vector,
          embeddingModel: this.embeddings.model,
        });
        updated++;
      }
    }

    this.logger.info('reindex complete', { namespace: this.namespace, updated });
    return updated;
  }

  /* ======================================================================== */
  /*                            Graph / consolidation                         */
  /* ======================================================================== */

  async graph(options: GraphQueryOptions = {}): Promise<KnowledgeGraph> {
    return this.graphService.buildGraph(this.namespace, options);
  }

  async entities(options: Parameters<GraphService['listEntities']>[1] = {}): Promise<Page<Entity>> {
    return this.graphService.listEntities(this.namespace, options);
  }

  async neighbours(entityId: string, limit = 20) {
    return this.graphService.neighbours(this.namespace, entityId, limit);
  }

  async consolidate(options: ConsolidationOptions = {}): Promise<ConsolidationReport> {
    return this.metrics.time('consolidate', () => this.consolidator.run(this.namespace, options));
  }

  async stats(options: { growthDays?: number; topTagsLimit?: number } = {}): Promise<MemoryStats> {
    return this.storage.stats(this.namespace, options);
  }

  async purgeExpired(): Promise<number> {
    return this.storage.purgeExpired(this.namespace);
  }

  async clear(): Promise<number> {
    return this.storage.clearNamespace(this.namespace);
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                    */
/* -------------------------------------------------------------------------- */

/**
 * Type-appropriate default importance. Procedural knowledge and durable facts
 * start higher than transient scratch, so an unset importance is still sensible.
 */
function defaultImportance(type: MemoryType): number {
  switch (type) {
    case 'short_term':
      return 0.3;
    case 'working':
      return 0.4;
    case 'episodic':
      return 0.5;
    case 'graph':
      return 0.55;
    case 'long_term':
    case 'semantic':
      return 0.6;
    case 'procedural':
      return 0.7;
    default:
      return 0.5;
  }
}

function buildCitation(memory: Memory, query: string): Citation {
  const span = bestMatchingSpan(memory.content, query);
  return {
    memoryId: memory.id,
    title: memory.title,
    sourceId: memory.sourceId,
    createdAt: memory.createdAt,
    span: { start: span.start, end: span.end },
    snippet: span.snippet,
  };
}

/**
 * Render hits as a model-ready context block.
 *
 * Each entry is numbered so the model can cite `[1]`, `[2]` and the caller can
 * resolve those markers back to memory ids via the returned `citations` array.
 */
function formatContext(hits: SearchHit[]): string {
  if (hits.length === 0) return '';

  const lines = hits.map((hit, index) => {
    const { memory } = hit;
    const header = memory.title ? `${memory.title}` : `${memory.kind} memory`;
    const date = memory.createdAt.slice(0, 10);
    const tags = memory.tags.length > 0 ? ` · tags: ${memory.tags.join(', ')}` : '';
    return `[${index + 1}] ${header} (${date}${tags})\n${truncate(memory.content, 2000)}`;
  });

  return `Relevant memories:\n\n${lines.join('\n\n')}`;
}

/**
 * Aggregate confidence that the returned set answers the query.
 *
 * Combines the best hit's score (does anything match well?) with the mean
 * (is there corroboration?) and each memory's own stored confidence.
 */
function aggregateConfidence(hits: SearchHit[]): number {
  if (hits.length === 0) return 0;
  const top = hits[0];
  if (!top) return 0;

  const mean = hits.reduce((sum, hit) => sum + hit.score, 0) / hits.length;
  const meanStoredConfidence = hits.reduce((sum, hit) => sum + hit.memory.confidence, 0) / hits.length;
  // The top hit dominates: one excellent memory is worth more than five mediocre ones.
  return Math.max(0, Math.min(1, (top.score * 0.6 + mean * 0.4) * meanStoredConfidence));
}
