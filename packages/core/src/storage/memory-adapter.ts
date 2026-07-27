/**
 * In-memory storage adapter.
 *
 * The reference implementation of `StorageAdapter`. It is the default backend,
 * which means MemoryDB starts and runs a full workload with no database at all —
 * ideal for tests, local development, ephemeral agent sessions, and embedding
 * MemoryDB inside another process.
 *
 * It is a real implementation, not a stub: BM25 lexical search over an
 * incremental inverted index, exhaustive-scan vector search with a bounded
 * top-k heap, the complete filter grammar, and full graph support.
 *
 * Vector search is exact (a flat scan), so recall is 100% but latency grows
 * linearly with corpus size. Comfortable to ~100k memories per namespace; use
 * the Postgres adapter with HNSW beyond that.
 */
import type {
  Entity,
  Memory,
  MemoryFilter,
  MemoryKind,
  MemoryStats,
  MemoryType,
  Page,
  Relation,
  ResolvedListInput,
} from '../types.js';
import { MEMORY_KINDS, MEMORY_TYPES } from '../types.js';
import type {
  EntityListOptions,
  HealthStatus,
  KeywordSearchOptions,
  MemoryPatch,
  RelationListOptions,
  ScoredId,
  StatsOptions,
  StorageAdapter,
  VectorSearchOptions,
} from './types.js';
import { isExpired, matchesFilter } from './filter.js';
import { BM25Index } from '../search/bm25.js';
import { cosineSimilarity, topK } from '../util/vector.js';

interface NamespaceState {
  memories: Map<string, Memory>;
  entities: Map<string, Entity>;
  relations: Map<string, Relation>;
  /** normalizedName -> entity id, for O(1) entity resolution. */
  entityByName: Map<string, string>;
  /** contentHash -> memory id, for O(1) exact dedupe. */
  byContentHash: Map<string, string>;
  index: BM25Index;
}

export interface MemoryAdapterOptions {
  /** Reject writes once a namespace holds this many memories. 0 disables the cap. */
  maxMemoriesPerNamespace?: number;
}

export class InMemoryStorageAdapter implements StorageAdapter {
  readonly name = 'in-memory';

  private readonly namespaces = new Map<string, NamespaceState>();
  private readonly maxPerNamespace: number;

  constructor(options: MemoryAdapterOptions = {}) {
    this.maxPerNamespace = options.maxMemoriesPerNamespace ?? 0;
  }

  async init(): Promise<void> {
    // Nothing to provision.
  }

  async close(): Promise<void> {
    this.namespaces.clear();
  }

  async healthCheck(): Promise<HealthStatus> {
    const startedAt = performance.now();
    let memories = 0;
    for (const state of this.namespaces.values()) memories += state.memories.size;
    return {
      ok: true,
      latencyMs: performance.now() - startedAt,
      adapter: this.name,
      details: { namespaces: this.namespaces.size, memories },
    };
  }

  private state(namespace: string): NamespaceState {
    let state = this.namespaces.get(namespace);
    if (!state) {
      state = {
        memories: new Map(),
        entities: new Map(),
        relations: new Map(),
        entityByName: new Map(),
        byContentHash: new Map(),
        index: new BM25Index(),
      };
      this.namespaces.set(namespace, state);
    }
    return state;
  }

  /* ----------------------------- memories ------------------------------- */

  async insertMemories(memories: Memory[]): Promise<Memory[]> {
    const inserted: Memory[] = [];
    for (const memory of memories) {
      const state = this.state(memory.namespace);
      if (this.maxPerNamespace > 0 && state.memories.size >= this.maxPerNamespace) {
        throw new Error(
          `namespace '${memory.namespace}' reached its ${this.maxPerNamespace} memory limit`,
        );
      }
      // Defensive copy: callers must not be able to mutate stored state by reference.
      const stored: Memory = { ...memory, tags: [...memory.tags], metadata: { ...memory.metadata } };
      state.memories.set(stored.id, stored);
      state.byContentHash.set(stored.contentHash, stored.id);
      this.indexMemory(state, stored);
      inserted.push({ ...stored });
    }
    return inserted;
  }

  private indexMemory(state: NamespaceState, memory: Memory): void {
    // Only live memories are searchable.
    if (memory.status === 'active') {
      state.index.add({
        id: memory.id,
        content: memory.content,
        title: memory.title,
        summary: memory.summary,
        tags: memory.tags,
      });
    } else {
      state.index.remove(memory.id);
    }
  }

  async getMemory(namespace: string, id: string): Promise<Memory | null> {
    const memory = this.namespaces.get(namespace)?.memories.get(id);
    return memory ? { ...memory } : null;
  }

  async getMemories(namespace: string, ids: string[]): Promise<Memory[]> {
    const state = this.namespaces.get(namespace);
    if (!state) return [];
    const out: Memory[] = [];
    for (const id of ids) {
      const memory = state.memories.get(id);
      if (memory) out.push({ ...memory });
    }
    return out;
  }

  async updateMemory(namespace: string, id: string, patch: MemoryPatch): Promise<Memory | null> {
    const state = this.namespaces.get(namespace);
    const existing = state?.memories.get(id);
    if (!state || !existing) return null;

    if (patch.contentHash && patch.contentHash !== existing.contentHash) {
      state.byContentHash.delete(existing.contentHash);
      state.byContentHash.set(patch.contentHash, id);
    }

    const updated: Memory = {
      ...existing,
      ...patch,
      tags: patch.tags ? [...patch.tags] : existing.tags,
      metadata: patch.metadata ? { ...patch.metadata } : existing.metadata,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };

    state.memories.set(id, updated);
    this.indexMemory(state, updated);
    return { ...updated };
  }

  async deleteMemory(namespace: string, id: string, hard = false): Promise<boolean> {
    const state = this.namespaces.get(namespace);
    const existing = state?.memories.get(id);
    if (!state || !existing) return false;

    state.index.remove(id);
    if (hard) {
      state.memories.delete(id);
      state.byContentHash.delete(existing.contentHash);
      // Detach the memory from any edges it evidenced.
      for (const [relationId, relation] of state.relations) {
        if (relation.memoryIds.includes(id)) {
          const remaining = relation.memoryIds.filter((memoryId) => memoryId !== id);
          if (remaining.length === 0) state.relations.delete(relationId);
          else state.relations.set(relationId, { ...relation, memoryIds: remaining });
        }
      }
    } else {
      state.memories.set(id, { ...existing, status: 'deleted', updatedAt: new Date().toISOString() });
    }
    return true;
  }

  async deleteMemories(namespace: string, filter: MemoryFilter, hard = false): Promise<number> {
    const state = this.namespaces.get(namespace);
    if (!state) return 0;
    const targets = Array.from(state.memories.values()).filter((memory) => matchesFilter(memory, filter));
    for (const memory of targets) await this.deleteMemory(namespace, memory.id, hard);
    return targets.length;
  }

  async listMemories(namespace: string, input: ResolvedListInput): Promise<Page<Memory>> {
    const state = this.namespaces.get(namespace);
    if (!state) return { items: [], total: 0, limit: input.limit, offset: input.offset, hasMore: false };

    const matched = Array.from(state.memories.values()).filter((memory) =>
      matchesFilter(memory, input.filter),
    );

    const direction = input.sortDir === 'asc' ? 1 : -1;
    matched.sort((a, b) => direction * compareBy(a, b, input.sortBy));

    const items = matched.slice(input.offset, input.offset + input.limit).map((memory) => ({ ...memory }));
    return {
      items,
      total: matched.length,
      limit: input.limit,
      offset: input.offset,
      hasMore: input.offset + items.length < matched.length,
    };
  }

  async countMemories(namespace: string, filter?: MemoryFilter): Promise<number> {
    const state = this.namespaces.get(namespace);
    if (!state) return 0;
    let count = 0;
    for (const memory of state.memories.values()) if (matchesFilter(memory, filter)) count++;
    return count;
  }

  async findByContentHash(namespace: string, contentHash: string): Promise<Memory | null> {
    const state = this.namespaces.get(namespace);
    if (!state) return null;
    const id = state.byContentHash.get(contentHash);
    if (!id) return null;
    const memory = state.memories.get(id);
    // A soft-deleted twin must not block a fresh write.
    if (!memory || memory.status === 'deleted') return null;
    return { ...memory };
  }

  async *iterateMemories(
    namespace: string,
    filter: MemoryFilter | undefined,
    batchSize: number,
  ): AsyncIterable<Memory[]> {
    const state = this.namespaces.get(namespace);
    if (!state) return;
    let batch: Memory[] = [];
    for (const memory of state.memories.values()) {
      if (!matchesFilter(memory, filter)) continue;
      batch.push({ ...memory });
      if (batch.length >= batchSize) {
        yield batch;
        batch = [];
      }
    }
    if (batch.length > 0) yield batch;
  }

  /* ----------------------------- retrieval ------------------------------ */

  async vectorSearch(namespace: string, options: VectorSearchOptions): Promise<ScoredId[]> {
    const state = this.namespaces.get(namespace);
    if (!state) return [];

    const minSimilarity = options.minSimilarity ?? -1;
    const candidates: Array<{ id: string; score: number }> = [];

    for (const memory of state.memories.values()) {
      if (!memory.embedding || memory.embedding.length === 0) continue;
      if (!matchesFilter(memory, options.filter)) continue;
      // Vectors are stored L2-normalised, but a mismatched dimension (e.g. after
      // a model switch) would silently score garbage — guard explicitly.
      if (memory.embedding.length !== options.embedding.length) continue;

      const similarity = cosineSimilarity(options.embedding, memory.embedding);
      if (similarity < minSimilarity) continue;
      candidates.push({ id: memory.id, score: similarity });
    }

    return topK(candidates, options.limit, (candidate) => candidate.score);
  }

  async keywordSearch(namespace: string, options: KeywordSearchOptions): Promise<ScoredId[]> {
    const state = this.namespaces.get(namespace);
    if (!state) return [];

    // Restrict BM25 to the filtered subset. Skipped when no filter is supplied,
    // since building the allow-set would cost a full scan for nothing.
    let allowed: Set<string> | undefined;
    if (options.filter) {
      allowed = new Set();
      for (const memory of state.memories.values()) {
        if (matchesFilter(memory, options.filter)) allowed.add(memory.id);
      }
    }

    return state.index.search(options.query, options.limit, allowed);
  }

  async recordAccess(namespace: string, ids: string[]): Promise<void> {
    const state = this.namespaces.get(namespace);
    if (!state) return;
    const now = new Date().toISOString();
    for (const id of ids) {
      const memory = state.memories.get(id);
      if (memory) {
        state.memories.set(id, { ...memory, accessCount: memory.accessCount + 1, lastAccessedAt: now });
      }
    }
  }

  /* ------------------------------- graph -------------------------------- */

  async upsertEntities(entities: Entity[]): Promise<Entity[]> {
    const out: Entity[] = [];
    for (const entity of entities) {
      const state = this.state(entity.namespace);
      const existingId = state.entityByName.get(entity.normalizedName);
      const existing = existingId ? state.entities.get(existingId) : undefined;

      if (existing) {
        const merged: Entity = {
          ...existing,
          // Preserve accumulated counts; the incoming record carries a delta.
          mentionCount: existing.mentionCount + entity.mentionCount,
          salience: Math.max(existing.salience, entity.salience),
          aliases: Array.from(new Set([...existing.aliases, ...entity.aliases])),
          description: entity.description ?? existing.description,
          metadata: { ...existing.metadata, ...entity.metadata },
          lastSeenAt: entity.lastSeenAt > existing.lastSeenAt ? entity.lastSeenAt : existing.lastSeenAt,
        };
        state.entities.set(existing.id, merged);
        out.push({ ...merged });
      } else {
        const stored: Entity = { ...entity, aliases: [...entity.aliases] };
        state.entities.set(stored.id, stored);
        state.entityByName.set(stored.normalizedName, stored.id);
        out.push({ ...stored });
      }
    }
    return out;
  }

  async getEntity(namespace: string, id: string): Promise<Entity | null> {
    const entity = this.namespaces.get(namespace)?.entities.get(id);
    return entity ? { ...entity } : null;
  }

  async findEntityByNormalizedName(namespace: string, normalizedName: string): Promise<Entity | null> {
    const state = this.namespaces.get(namespace);
    if (!state) return null;
    const id = state.entityByName.get(normalizedName);
    if (!id) return null;
    const entity = state.entities.get(id);
    return entity ? { ...entity } : null;
  }

  async listEntities(namespace: string, options: EntityListOptions): Promise<Page<Entity>> {
    const state = this.namespaces.get(namespace);
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    if (!state) return { items: [], total: 0, limit, offset, hasMore: false };

    const types = options.type ? (Array.isArray(options.type) ? options.type : [options.type]) : undefined;
    const search = options.search?.toLowerCase();

    let matched = Array.from(state.entities.values()).filter((entity) => {
      if (types && !types.includes(entity.type)) return false;
      if (options.minMentions !== undefined && entity.mentionCount < options.minMentions) return false;
      if (search) {
        const haystack = [entity.name, ...entity.aliases].join(' ').toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });

    const sortBy = options.sortBy ?? 'mentionCount';
    matched = matched.sort((a, b) => {
      switch (sortBy) {
        case 'name':
          return a.name.localeCompare(b.name);
        case 'salience':
          return b.salience - a.salience;
        case 'lastSeenAt':
          return b.lastSeenAt.localeCompare(a.lastSeenAt);
        case 'mentionCount':
        default:
          return b.mentionCount - a.mentionCount;
      }
    });

    const items = matched.slice(offset, offset + limit).map((entity) => ({ ...entity }));
    return { items, total: matched.length, limit, offset, hasMore: offset + items.length < matched.length };
  }

  async deleteEntity(namespace: string, id: string): Promise<boolean> {
    const state = this.namespaces.get(namespace);
    const entity = state?.entities.get(id);
    if (!state || !entity) return false;
    state.entities.delete(id);
    state.entityByName.delete(entity.normalizedName);
    // Drop dangling edges so the graph never references a missing node.
    for (const [relationId, relation] of state.relations) {
      if (relation.sourceId === id || relation.targetId === id) state.relations.delete(relationId);
    }
    return true;
  }

  async upsertRelations(relations: Relation[]): Promise<Relation[]> {
    const out: Relation[] = [];
    for (const relation of relations) {
      const state = this.state(relation.namespace);
      // Identity is (source, target, type) — not the generated id — so repeated
      // observations reinforce one edge instead of creating parallel ones.
      const key = `${relation.sourceId}|${relation.targetId}|${relation.type}`;
      let existing: Relation | undefined;
      for (const candidate of state.relations.values()) {
        if (`${candidate.sourceId}|${candidate.targetId}|${candidate.type}` === key) {
          existing = candidate;
          break;
        }
      }

      if (existing) {
        const merged: Relation = {
          ...existing,
          // Repeated co-occurrence increases confidence with diminishing returns.
          weight: Math.min(1, existing.weight + relation.weight * 0.25),
          confidence: Math.max(existing.confidence, relation.confidence),
          memoryIds: Array.from(new Set([...existing.memoryIds, ...relation.memoryIds])).slice(0, 100),
          metadata: { ...existing.metadata, ...relation.metadata },
          updatedAt: relation.updatedAt,
        };
        state.relations.set(existing.id, merged);
        out.push({ ...merged });
      } else {
        const stored: Relation = { ...relation, memoryIds: [...relation.memoryIds] };
        state.relations.set(stored.id, stored);
        out.push({ ...stored });
      }
    }
    return out;
  }

  async listRelations(namespace: string, options: RelationListOptions): Promise<Relation[]> {
    const state = this.namespaces.get(namespace);
    if (!state) return [];
    const entityIds = options.entityIds ? new Set(options.entityIds) : undefined;
    const types = options.types ? new Set(options.types) : undefined;

    const matched = Array.from(state.relations.values()).filter((relation) => {
      if (entityIds && !entityIds.has(relation.sourceId) && !entityIds.has(relation.targetId)) return false;
      if (types && !types.has(relation.type)) return false;
      if (options.minWeight !== undefined && relation.weight < options.minWeight) return false;
      return true;
    });

    matched.sort((a, b) => b.weight - a.weight);
    return (options.limit ? matched.slice(0, options.limit) : matched).map((relation) => ({ ...relation }));
  }

  async deleteRelation(namespace: string, id: string): Promise<boolean> {
    return this.namespaces.get(namespace)?.relations.delete(id) ?? false;
  }

  /* ------------------------------- admin -------------------------------- */

  async stats(namespace: string, options: StatsOptions = {}): Promise<MemoryStats> {
    const state = this.namespaces.get(namespace);
    const growthDays = options.growthDays ?? 30;
    const topTagsLimit = options.topTagsLimit ?? 20;

    const byType = Object.fromEntries(MEMORY_TYPES.map((type) => [type, 0])) as Record<MemoryType, number>;
    const byKind = Object.fromEntries(MEMORY_KINDS.map((kind) => [kind, 0])) as Record<MemoryKind, number>;

    if (!state) {
      return {
        total: 0, active: 0, archived: 0, superseded: 0,
        byType, byKind, totalTokens: 0, avgImportance: 0,
        growth: buildGrowthSeries(new Map(), growthDays, 0),
        topTags: [], entityCount: 0, relationCount: 0, storageBytes: 0,
        oldestMemoryAt: null, newestMemoryAt: null,
      };
    }

    let active = 0;
    let archived = 0;
    let superseded = 0;
    let totalTokens = 0;
    let importanceSum = 0;
    let storageBytes = 0;
    let oldest: string | null = null;
    let newest: string | null = null;

    const tagCounts = new Map<string, number>();
    const dailyCounts = new Map<string, number>();
    let counted = 0;

    for (const memory of state.memories.values()) {
      if (memory.status === 'deleted') continue;
      counted++;
      if (memory.status === 'active') active++;
      else if (memory.status === 'archived') archived++;
      else if (memory.status === 'superseded') superseded++;

      byType[memory.type]++;
      byKind[memory.kind]++;
      totalTokens += memory.tokens;
      importanceSum += memory.importance;

      // Content bytes + embedding (float32) + a fixed allowance for metadata.
      storageBytes += memory.content.length * 2 + (memory.embedding?.length ?? 0) * 4 + 512;

      for (const tag of memory.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);

      const day = memory.createdAt.slice(0, 10);
      dailyCounts.set(day, (dailyCounts.get(day) ?? 0) + 1);

      if (!oldest || memory.createdAt < oldest) oldest = memory.createdAt;
      if (!newest || memory.createdAt > newest) newest = memory.createdAt;
    }

    // Cumulative growth must account for memories created before the window.
    let priorToWindow = 0;
    const windowStart = new Date(Date.now() - (growthDays - 1) * 86_400_000).toISOString().slice(0, 10);
    for (const [day, count] of dailyCounts) if (day < windowStart) priorToWindow += count;

    const topTags = Array.from(tagCounts, ([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, topTagsLimit);

    return {
      total: counted,
      active,
      archived,
      superseded,
      byType,
      byKind,
      totalTokens,
      avgImportance: counted === 0 ? 0 : importanceSum / counted,
      growth: buildGrowthSeries(dailyCounts, growthDays, priorToWindow),
      topTags,
      entityCount: state.entities.size,
      relationCount: state.relations.size,
      storageBytes,
      oldestMemoryAt: oldest,
      newestMemoryAt: newest,
    };
  }

  async purgeExpired(namespace: string, now: Date = new Date()): Promise<number> {
    const state = this.namespaces.get(namespace);
    if (!state) return 0;
    const timestamp = now.getTime();
    const expired = Array.from(state.memories.values()).filter((memory) => isExpired(memory, timestamp));
    for (const memory of expired) await this.deleteMemory(namespace, memory.id, true);
    return expired.length;
  }

  async clearNamespace(namespace: string): Promise<number> {
    const state = this.namespaces.get(namespace);
    if (!state) return 0;
    const count = state.memories.size;
    this.namespaces.delete(namespace);
    return count;
  }
}

function compareBy(a: Memory, b: Memory, field: ResolvedListInput['sortBy']): number {
  switch (field) {
    case 'importance':
      return a.importance - b.importance;
    case 'accessCount':
      return a.accessCount - b.accessCount;
    case 'lastAccessedAt':
      return (a.lastAccessedAt ?? '').localeCompare(b.lastAccessedAt ?? '');
    case 'updatedAt':
      return a.updatedAt.localeCompare(b.updatedAt);
    case 'createdAt':
    default:
      return a.createdAt.localeCompare(b.createdAt);
  }
}

/** Dense daily series with zero-filled gaps, so charts never show holes. */
function buildGrowthSeries(
  dailyCounts: Map<string, number>,
  days: number,
  startingCumulative: number,
): Array<{ date: string; count: number; cumulative: number }> {
  const series: Array<{ date: string; count: number; cumulative: number }> = [];
  let cumulative = startingCumulative;
  const today = new Date();

  for (let offset = days - 1; offset >= 0; offset--) {
    const date = new Date(today.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
    const count = dailyCounts.get(date) ?? 0;
    cumulative += count;
    series.push({ date, count, cumulative });
  }
  return series;
}
