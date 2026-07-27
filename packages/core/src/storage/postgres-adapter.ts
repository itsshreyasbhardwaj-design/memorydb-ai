/**
 * PostgreSQL + pgvector storage adapter.
 *
 * Designed for millions of memories: filters compile to parameterised SQL and
 * are pushed all the way down, vector search rides an HNSW index, lexical
 * search uses a generated `tsvector`, and statistics are computed with a single
 * aggregate query rather than by fetching rows.
 *
 * The driver is injected rather than imported. `pg`, `postgres.js`,
 * `@neondatabase/serverless`, and Supabase's client all expose a
 * `query(sql, params)` shape, so this adapter works with any of them and
 * `@memorydb/core` keeps zero runtime dependencies.
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
import { StorageError } from '../errors.js';
import { fromPgVector, toPgVector } from '../util/vector.js';

/** Minimal driver contract. Satisfied by `pg.Pool` as-is. */
export interface SqlDriver {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
  end?(): Promise<void>;
}

export interface PostgresAdapterOptions {
  driver: SqlDriver;
  /** Vector width; must match the `vector(n)` column type. */
  dimensions?: number;
  /** Auto-create the namespace row on first write. */
  autoCreateNamespace?: boolean;
  /** Raise for higher recall at the cost of latency. pgvector default is 40. */
  hnswEfSearch?: number;
}

/**
 * Incrementally builds a parameterised statement.
 *
 * Values are *always* bound as `$n` placeholders — no user input ever reaches
 * the SQL string, which is what makes injection structurally impossible here
 * rather than merely unlikely.
 */
class QueryBuilder {
  private readonly params: unknown[] = [];

  bind(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  values(): unknown[] {
    return this.params;
  }
}

interface MemoryRow {
  id: string;
  namespace: string;
  user_id: string | null;
  agent_id: string | null;
  session_id: string | null;
  type: MemoryType;
  kind: MemoryKind;
  status: Memory['status'];
  content: string;
  summary: string | null;
  title: string | null;
  metadata: Record<string, unknown> | string;
  tags: string[];
  importance: number;
  confidence: number;
  embedding: string | number[] | null;
  embedding_model: string | null;
  tokens: number;
  access_count: number;
  last_accessed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  expires_at: Date | string | null;
  archived_at: Date | string | null;
  superseded_by: string | null;
  source_id: string | null;
  content_hash: string;
  version: number;
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function requireIso(value: Date | string): string {
  return toIso(value) as string;
}

function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    namespace: row.namespace,
    userId: row.user_id,
    agentId: row.agent_id,
    sessionId: row.session_id,
    type: row.type,
    kind: row.kind,
    status: row.status,
    content: row.content,
    summary: row.summary,
    title: row.title,
    // Drivers differ: some parse jsonb, others hand back a string.
    metadata: (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) as Memory['metadata'],
    tags: row.tags ?? [],
    importance: row.importance,
    confidence: row.confidence,
    embedding: fromPgVector(row.embedding as string | number[] | null),
    embeddingModel: row.embedding_model,
    tokens: row.tokens,
    accessCount: row.access_count,
    lastAccessedAt: toIso(row.last_accessed_at),
    createdAt: requireIso(row.created_at),
    updatedAt: requireIso(row.updated_at),
    expiresAt: toIso(row.expires_at),
    archivedAt: toIso(row.archived_at),
    supersededBy: row.superseded_by,
    sourceId: row.source_id,
    contentHash: row.content_hash,
    version: row.version,
  };
}

const MEMORY_COLUMNS = `
  id, namespace, user_id, agent_id, session_id, type, kind, status,
  content, summary, title, metadata, tags, importance, confidence,
  embedding, embedding_model, tokens, access_count, last_accessed_at,
  created_at, updated_at, expires_at, archived_at, superseded_by,
  source_id, content_hash, version
`;

/** Column names that may be sorted on. Whitelisted to keep ORDER BY injection-free. */
const SORT_COLUMNS: Record<ResolvedListInput['sortBy'], string> = {
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  importance: 'importance',
  accessCount: 'access_count',
  lastAccessedAt: 'last_accessed_at',
};

export class PostgresStorageAdapter implements StorageAdapter {
  readonly name = 'postgres';

  private readonly driver: SqlDriver;
  private readonly dimensions: number;
  private readonly autoCreateNamespace: boolean;
  private readonly hnswEfSearch: number;
  private readonly ensuredNamespaces = new Set<string>();

  constructor(options: PostgresAdapterOptions) {
    this.driver = options.driver;
    this.dimensions = options.dimensions ?? 384;
    this.autoCreateNamespace = options.autoCreateNamespace ?? true;
    this.hnswEfSearch = options.hnswEfSearch ?? 100;
  }

  async init(): Promise<void> {
    try {
      const { rows } = await this.driver.query<{ exists: boolean }>(
        `select exists (
           select 1 from information_schema.tables
           where table_schema = 'public' and table_name = 'memories'
         ) as exists`,
      );
      if (!rows[0]?.exists) {
        throw new StorageError(
          'the "memories" table was not found — apply supabase/migrations/0001_initial_schema.sql before starting',
        );
      }
    } catch (err) {
      if (err instanceof StorageError) throw err;
      throw new StorageError('failed to verify the database schema', err);
    }
  }

  async close(): Promise<void> {
    await this.driver.end?.();
  }

  async healthCheck(): Promise<HealthStatus> {
    const startedAt = performance.now();
    try {
      const { rows } = await this.driver.query<{ version: string; vector: string | null }>(
        `select version() as version,
                (select extversion from pg_extension where extname = 'vector') as vector`,
      );
      return {
        ok: true,
        latencyMs: performance.now() - startedAt,
        adapter: this.name,
        details: {
          server: rows[0]?.version?.split(' ').slice(0, 2).join(' '),
          pgvector: rows[0]?.vector ?? 'not installed',
        },
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: performance.now() - startedAt,
        adapter: this.name,
        details: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  /** Create the namespace row on demand so callers never have to pre-provision. */
  private async ensureNamespace(namespace: string): Promise<void> {
    if (!this.autoCreateNamespace || this.ensuredNamespaces.has(namespace)) return;
    await this.driver.query(
      `insert into namespaces (id, name, embedding_dimensions)
       values ($1, $1, $2)
       on conflict (id) do nothing`,
      [namespace, this.dimensions],
    );
    this.ensuredNamespaces.add(namespace);
  }

  /* ----------------------------------------------------------------------- */
  /*                            Filter compilation                            */
  /* ----------------------------------------------------------------------- */

  /**
   * Compile a `MemoryFilter` into SQL predicates.
   *
   * Mirrors `matchesFilter` in `filter.ts` exactly; the shared conformance test
   * suite runs both against the same inputs to guarantee they stay in step.
   */
  private compileFilter(
    namespace: string,
    filter: MemoryFilter | undefined,
    builder: QueryBuilder,
    alias = 'm',
  ): string {
    const clauses: string[] = [`${alias}.namespace = ${builder.bind(namespace)}`];

    const statuses = filter?.status
      ? Array.isArray(filter.status)
        ? filter.status
        : [filter.status]
      : undefined;

    if (statuses) {
      clauses.push(`${alias}.status = any(${builder.bind(statuses)}::memory_status[])`);
    } else {
      clauses.push(`${alias}.status <> 'deleted'`);
      clauses.push(`${alias}.status <> 'superseded'`);
      if (!filter?.includeArchived) clauses.push(`${alias}.status <> 'archived'`);
    }

    if (!filter?.includeExpired) {
      clauses.push(`(${alias}.expires_at is null or ${alias}.expires_at > now())`);
    }

    if (filter?.type) {
      const types = Array.isArray(filter.type) ? filter.type : [filter.type];
      clauses.push(`${alias}.type = any(${builder.bind(types)}::memory_type[])`);
    }
    if (filter?.kind) {
      const kinds = Array.isArray(filter.kind) ? filter.kind : [filter.kind];
      clauses.push(`${alias}.kind = any(${builder.bind(kinds)}::memory_kind[])`);
    }

    if (filter?.userId !== undefined) clauses.push(`${alias}.user_id = ${builder.bind(filter.userId)}`);
    if (filter?.agentId !== undefined) clauses.push(`${alias}.agent_id = ${builder.bind(filter.agentId)}`);
    if (filter?.sessionId !== undefined) clauses.push(`${alias}.session_id = ${builder.bind(filter.sessionId)}`);
    if (filter?.sourceId !== undefined) clauses.push(`${alias}.source_id = ${builder.bind(filter.sourceId)}`);
    if (filter?.ids?.length) clauses.push(`${alias}.id = any(${builder.bind(filter.ids)}::text[])`);

    // `@>` (contains) and `&&` (overlaps) both use the GIN index on tags.
    if (filter?.tags?.length) clauses.push(`${alias}.tags @> ${builder.bind(filter.tags)}::text[]`);
    if (filter?.anyTags?.length) clauses.push(`${alias}.tags && ${builder.bind(filter.anyTags)}::text[]`);

    if (filter?.createdAfter) clauses.push(`${alias}.created_at > ${builder.bind(filter.createdAfter)}::timestamptz`);
    if (filter?.createdBefore) clauses.push(`${alias}.created_at < ${builder.bind(filter.createdBefore)}::timestamptz`);
    if (filter?.updatedAfter) clauses.push(`${alias}.updated_at > ${builder.bind(filter.updatedAfter)}::timestamptz`);
    if (filter?.updatedBefore) clauses.push(`${alias}.updated_at < ${builder.bind(filter.updatedBefore)}::timestamptz`);

    if (filter?.minImportance !== undefined) {
      clauses.push(`${alias}.importance >= ${builder.bind(filter.minImportance)}`);
    }
    if (filter?.minConfidence !== undefined) {
      clauses.push(`${alias}.confidence >= ${builder.bind(filter.minConfidence)}`);
    }

    if (filter?.metadata) {
      clauses.push(...this.compileMetadataFilter(filter.metadata, builder, alias));
    }

    return clauses.join(' and ');
  }

  private compileMetadataFilter(
    metadata: NonNullable<MemoryFilter['metadata']>,
    builder: QueryBuilder,
    alias: string,
  ): string[] {
    const clauses: string[] = [];

    for (const [path, condition] of Object.entries(metadata)) {
      // Dotted paths become a jsonb path array: `metadata #> '{a,b}'`.
      const segments = path.split('.');
      const accessor = `${alias}.metadata #> ${builder.bind(segments)}::text[]`;

      if (condition === null || typeof condition !== 'object' || Array.isArray(condition)) {
        clauses.push(`${accessor} = ${builder.bind(JSON.stringify(condition))}::jsonb`);
        continue;
      }

      const ops = condition as Record<string, unknown>;

      if ('exists' in ops) {
        clauses.push(ops.exists === true ? `${accessor} is not null` : `${accessor} is null`);
        if (Object.keys(ops).length === 1) continue;
      }
      if ('eq' in ops) clauses.push(`${accessor} = ${builder.bind(JSON.stringify(ops.eq))}::jsonb`);
      if ('ne' in ops) clauses.push(`${accessor} is distinct from ${builder.bind(JSON.stringify(ops.ne))}::jsonb`);

      // Numeric comparisons need an explicit cast out of jsonb.
      const numeric = `(${accessor})::numeric`;
      if (typeof ops.gt === 'number') clauses.push(`${numeric} > ${builder.bind(ops.gt)}`);
      if (typeof ops.gte === 'number') clauses.push(`${numeric} >= ${builder.bind(ops.gte)}`);
      if (typeof ops.lt === 'number') clauses.push(`${numeric} < ${builder.bind(ops.lt)}`);
      if (typeof ops.lte === 'number') clauses.push(`${numeric} <= ${builder.bind(ops.lte)}`);

      if (Array.isArray(ops.in)) {
        clauses.push(`${accessor} = any(${builder.bind(ops.in.map((v) => JSON.stringify(v)))}::jsonb[])`);
      }
      if (Array.isArray(ops.nin)) {
        clauses.push(`not (${accessor} = any(${builder.bind(ops.nin.map((v) => JSON.stringify(v)))}::jsonb[]))`);
      }
      if (typeof ops.contains === 'string') {
        clauses.push(`(${accessor} #>> '{}') ilike ${builder.bind(`%${ops.contains}%`)}`);
      }
    }

    return clauses;
  }

  /* ----------------------------------------------------------------------- */
  /*                                memories                                  */
  /* ----------------------------------------------------------------------- */

  async insertMemories(memories: Memory[]): Promise<Memory[]> {
    if (memories.length === 0) return [];
    const namespace = memories[0]?.namespace;
    if (namespace) await this.ensureNamespace(namespace);

    const builder = new QueryBuilder();
    const tuples = memories.map((memory) => {
      const values = [
        builder.bind(memory.id),
        builder.bind(memory.namespace),
        builder.bind(memory.userId),
        builder.bind(memory.agentId),
        builder.bind(memory.sessionId),
        `${builder.bind(memory.type)}::memory_type`,
        `${builder.bind(memory.kind)}::memory_kind`,
        `${builder.bind(memory.status)}::memory_status`,
        builder.bind(memory.content),
        builder.bind(memory.summary),
        builder.bind(memory.title),
        `${builder.bind(JSON.stringify(memory.metadata))}::jsonb`,
        `${builder.bind(memory.tags)}::text[]`,
        builder.bind(memory.importance),
        builder.bind(memory.confidence),
        memory.embedding ? `${builder.bind(toPgVector(memory.embedding))}::vector` : 'null',
        builder.bind(memory.embeddingModel),
        builder.bind(memory.tokens),
        builder.bind(memory.accessCount),
        `${builder.bind(memory.lastAccessedAt)}::timestamptz`,
        `${builder.bind(memory.createdAt)}::timestamptz`,
        `${builder.bind(memory.updatedAt)}::timestamptz`,
        `${builder.bind(memory.expiresAt)}::timestamptz`,
        `${builder.bind(memory.archivedAt)}::timestamptz`,
        builder.bind(memory.supersededBy),
        builder.bind(memory.sourceId),
        builder.bind(memory.contentHash),
        builder.bind(memory.version),
      ];
      return `(${values.join(', ')})`;
    });

    try {
      const { rows } = await this.driver.query<MemoryRow>(
        `insert into memories (${MEMORY_COLUMNS})
         values ${tuples.join(', ')}
         on conflict (namespace, content_hash) where status <> 'deleted'
         do update set updated_at = now()
         returning ${MEMORY_COLUMNS}`,
        builder.values(),
      );
      return rows.map(rowToMemory);
    } catch (err) {
      throw new StorageError('failed to insert memories', err);
    }
  }

  async getMemory(namespace: string, id: string): Promise<Memory | null> {
    const { rows } = await this.driver.query<MemoryRow>(
      `select ${MEMORY_COLUMNS} from memories where namespace = $1 and id = $2`,
      [namespace, id],
    );
    return rows[0] ? rowToMemory(rows[0]) : null;
  }

  async getMemories(namespace: string, ids: string[]): Promise<Memory[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.driver.query<MemoryRow>(
      `select ${MEMORY_COLUMNS} from memories where namespace = $1 and id = any($2::text[])`,
      [namespace, ids],
    );
    // Restore the caller's ordering, which the fusion stage depends on.
    const byId = new Map(rows.map((row) => [row.id, rowToMemory(row)]));
    return ids.map((id) => byId.get(id)).filter((memory): memory is Memory => memory !== undefined);
  }

  async updateMemory(namespace: string, id: string, patch: MemoryPatch): Promise<Memory | null> {
    const builder = new QueryBuilder();
    const assignments: string[] = [];

    const set = (column: string, value: unknown, cast?: string): void => {
      assignments.push(`${column} = ${builder.bind(value)}${cast ?? ''}`);
    };

    if (patch.content !== undefined) set('content', patch.content);
    if (patch.title !== undefined) set('title', patch.title);
    if (patch.summary !== undefined) set('summary', patch.summary);
    if (patch.type !== undefined) set('type', patch.type, '::memory_type');
    if (patch.kind !== undefined) set('kind', patch.kind, '::memory_kind');
    if (patch.status !== undefined) set('status', patch.status, '::memory_status');
    if (patch.metadata !== undefined) set('metadata', JSON.stringify(patch.metadata), '::jsonb');
    if (patch.tags !== undefined) set('tags', patch.tags, '::text[]');
    if (patch.importance !== undefined) set('importance', patch.importance);
    if (patch.confidence !== undefined) set('confidence', patch.confidence);
    if (patch.embedding !== undefined) {
      assignments.push(
        patch.embedding === null
          ? 'embedding = null'
          : `embedding = ${builder.bind(toPgVector(patch.embedding))}::vector`,
      );
    }
    if (patch.embeddingModel !== undefined) set('embedding_model', patch.embeddingModel);
    if (patch.tokens !== undefined) set('tokens', patch.tokens);
    if (patch.accessCount !== undefined) set('access_count', patch.accessCount);
    if (patch.lastAccessedAt !== undefined) set('last_accessed_at', patch.lastAccessedAt, '::timestamptz');
    if (patch.expiresAt !== undefined) set('expires_at', patch.expiresAt, '::timestamptz');
    if (patch.archivedAt !== undefined) set('archived_at', patch.archivedAt, '::timestamptz');
    if (patch.supersededBy !== undefined) set('superseded_by', patch.supersededBy);
    if (patch.contentHash !== undefined) set('content_hash', patch.contentHash);
    if (patch.version !== undefined) set('version', patch.version);

    // The trigger maintains updated_at, but an explicit patch value wins.
    if (patch.updatedAt !== undefined) set('updated_at', patch.updatedAt, '::timestamptz');
    if (assignments.length === 0) return this.getMemory(namespace, id);

    const namespaceParam = builder.bind(namespace);
    const idParam = builder.bind(id);

    try {
      const { rows } = await this.driver.query<MemoryRow>(
        `update memories set ${assignments.join(', ')}
         where namespace = ${namespaceParam} and id = ${idParam}
         returning ${MEMORY_COLUMNS}`,
        builder.values(),
      );
      return rows[0] ? rowToMemory(rows[0]) : null;
    } catch (err) {
      throw new StorageError(`failed to update memory ${id}`, err);
    }
  }

  async deleteMemory(namespace: string, id: string, hard = false): Promise<boolean> {
    const { rowCount } = hard
      ? await this.driver.query(`delete from memories where namespace = $1 and id = $2`, [namespace, id])
      : await this.driver.query(
          `update memories set status = 'deleted', updated_at = now()
           where namespace = $1 and id = $2 and status <> 'deleted'`,
          [namespace, id],
        );
    return (rowCount ?? 0) > 0;
  }

  async deleteMemories(namespace: string, filter: MemoryFilter, hard = false): Promise<number> {
    const builder = new QueryBuilder();
    const where = this.compileFilter(namespace, filter, builder);

    const { rowCount } = hard
      ? await this.driver.query(`delete from memories m where ${where}`, builder.values())
      : await this.driver.query(
          `update memories m set status = 'deleted', updated_at = now() where ${where}`,
          builder.values(),
        );
    return rowCount ?? 0;
  }

  async listMemories(namespace: string, input: ResolvedListInput): Promise<Page<Memory>> {
    const builder = new QueryBuilder();
    const where = this.compileFilter(namespace, input.filter, builder);
    const sortColumn = SORT_COLUMNS[input.sortBy];
    const direction = input.sortDir === 'asc' ? 'asc' : 'desc';

    const limitParam = builder.bind(input.limit);
    const offsetParam = builder.bind(input.offset);

    // A window function returns the total alongside the page, avoiding a second
    // round trip and keeping count and rows consistent under concurrent writes.
    const { rows } = await this.driver.query<MemoryRow & { total_count: string }>(
      `select ${MEMORY_COLUMNS}, count(*) over () as total_count
       from memories m
       where ${where}
       order by m.${sortColumn} ${direction} nulls last, m.id ${direction}
       limit ${limitParam} offset ${offsetParam}`,
      builder.values(),
    );

    const total = rows[0] ? Number(rows[0].total_count) : 0;
    const items = rows.map(rowToMemory);
    return {
      items,
      total,
      limit: input.limit,
      offset: input.offset,
      hasMore: input.offset + items.length < total,
    };
  }

  async countMemories(namespace: string, filter?: MemoryFilter): Promise<number> {
    const builder = new QueryBuilder();
    const where = this.compileFilter(namespace, filter, builder);
    const { rows } = await this.driver.query<{ count: string }>(
      `select count(*) as count from memories m where ${where}`,
      builder.values(),
    );
    return Number(rows[0]?.count ?? 0);
  }

  async findByContentHash(namespace: string, contentHash: string): Promise<Memory | null> {
    const { rows } = await this.driver.query<MemoryRow>(
      `select ${MEMORY_COLUMNS} from memories
       where namespace = $1 and content_hash = $2 and status <> 'deleted'
       limit 1`,
      [namespace, contentHash],
    );
    return rows[0] ? rowToMemory(rows[0]) : null;
  }

  async *iterateMemories(
    namespace: string,
    filter: MemoryFilter | undefined,
    batchSize: number,
  ): AsyncIterable<Memory[]> {
    // Keyset pagination on the primary key: unlike OFFSET, cost stays constant
    // as the scan advances, and concurrent inserts cannot cause skips.
    let cursor: string | null = null;

    for (;;) {
      const builder = new QueryBuilder();
      const where = this.compileFilter(namespace, filter, builder);
      const cursorClause: string = cursor ? ` and m.id > ${builder.bind(cursor)}` : '';
      const limitParam = builder.bind(batchSize);

      const { rows }: { rows: MemoryRow[] } = await this.driver.query<MemoryRow>(
        `select ${MEMORY_COLUMNS} from memories m
         where ${where}${cursorClause}
         order by m.id asc
         limit ${limitParam}`,
        builder.values(),
      );

      if (rows.length === 0) return;
      yield rows.map(rowToMemory);
      if (rows.length < batchSize) return;
      cursor = rows[rows.length - 1]?.id ?? null;
      if (!cursor) return;
    }
  }

  /* ----------------------------------------------------------------------- */
  /*                                retrieval                                 */
  /* ----------------------------------------------------------------------- */

  async vectorSearch(namespace: string, options: VectorSearchOptions): Promise<ScoredId[]> {
    if (options.embedding.length !== this.dimensions) {
      throw new StorageError(
        `embedding has ${options.embedding.length} dimensions but the column is vector(${this.dimensions})`,
      );
    }

    const builder = new QueryBuilder();
    const where = this.compileFilter(namespace, options.filter, builder);
    const vectorParam = builder.bind(toPgVector(options.embedding));
    const limitParam = builder.bind(options.limit);

    // `<=>` is cosine distance in [0,2]; similarity is 1 - distance.
    const clauses = [where, 'm.embedding is not null'];
    if (options.minSimilarity !== undefined && options.minSimilarity > 0) {
      clauses.push(`1 - (m.embedding <=> ${vectorParam}::vector) >= ${builder.bind(options.minSimilarity)}`);
    }

    try {
      // Session-scoped: raises recall for this query without touching the index.
      await this.driver.query(`set local hnsw.ef_search = ${Math.floor(this.hnswEfSearch)}`);
    } catch {
      // Outside a transaction `set local` is a no-op warning; the default ef_search still applies.
    }

    const { rows } = await this.driver.query<{ id: string; similarity: number }>(
      `select m.id, 1 - (m.embedding <=> ${vectorParam}::vector) as similarity
       from memories m
       where ${clauses.join(' and ')}
       order by m.embedding <=> ${vectorParam}::vector
       limit ${limitParam}`,
      builder.values(),
    );

    return rows.map((row) => ({ id: row.id, score: Number(row.similarity) }));
  }

  async keywordSearch(namespace: string, options: KeywordSearchOptions): Promise<ScoredId[]> {
    const builder = new QueryBuilder();
    const where = this.compileFilter(namespace, options.filter, builder);
    // `websearch_to_tsquery` accepts human syntax ("quoted phrases", -negation)
    // and, unlike `to_tsquery`, never throws on malformed input.
    const queryParam = builder.bind(options.query);
    const limitParam = builder.bind(options.limit);

    const { rows } = await this.driver.query<{ id: string; rank: number }>(
      `select m.id, ts_rank_cd(m.search_vector, websearch_to_tsquery('english', ${queryParam})) as rank
       from memories m
       where ${where}
         and m.search_vector @@ websearch_to_tsquery('english', ${queryParam})
       order by rank desc
       limit ${limitParam}`,
      builder.values(),
    );

    return rows.map((row) => ({ id: row.id, score: Number(row.rank) }));
  }

  async recordAccess(namespace: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.driver.query(
      `update memories
       set access_count = access_count + 1, last_accessed_at = now()
       where namespace = $1 and id = any($2::text[])`,
      [namespace, ids],
    );
  }

  /* ----------------------------------------------------------------------- */
  /*                                  graph                                   */
  /* ----------------------------------------------------------------------- */

  async upsertEntities(entities: Entity[]): Promise<Entity[]> {
    if (entities.length === 0) return [];
    const namespace = entities[0]?.namespace;
    if (namespace) await this.ensureNamespace(namespace);

    const builder = new QueryBuilder();
    const tuples = entities.map((entity) =>
      `(${[
        builder.bind(entity.id),
        builder.bind(entity.namespace),
        `${builder.bind(entity.type)}::entity_type`,
        builder.bind(entity.name),
        builder.bind(entity.normalizedName),
        `${builder.bind(entity.aliases)}::text[]`,
        builder.bind(entity.description),
        `${builder.bind(JSON.stringify(entity.metadata))}::jsonb`,
        builder.bind(entity.mentionCount),
        builder.bind(entity.salience),
        `${builder.bind(entity.firstSeenAt)}::timestamptz`,
        `${builder.bind(entity.lastSeenAt)}::timestamptz`,
      ].join(', ')})`,
    );

    const { rows } = await this.driver.query<EntityRow>(
      `insert into entities (
         id, namespace, type, name, normalized_name, aliases, description,
         metadata, mention_count, salience, first_seen_at, last_seen_at
       ) values ${tuples.join(', ')}
       on conflict (namespace, normalized_name) do update set
         -- Accumulate rather than overwrite: each write carries a delta.
         mention_count = entities.mention_count + excluded.mention_count,
         salience      = greatest(entities.salience, excluded.salience),
         aliases       = (
           select array_agg(distinct alias)
           from unnest(entities.aliases || excluded.aliases) as alias
         ),
         description   = coalesce(excluded.description, entities.description),
         metadata      = entities.metadata || excluded.metadata,
         last_seen_at  = greatest(entities.last_seen_at, excluded.last_seen_at)
       returning id, namespace, type, name, normalized_name, aliases, description,
                 metadata, mention_count, salience, first_seen_at, last_seen_at`,
      builder.values(),
    );

    return rows.map(rowToEntity);
  }

  async getEntity(namespace: string, id: string): Promise<Entity | null> {
    const { rows } = await this.driver.query<EntityRow>(
      `select id, namespace, type, name, normalized_name, aliases, description,
              metadata, mention_count, salience, first_seen_at, last_seen_at
       from entities where namespace = $1 and id = $2`,
      [namespace, id],
    );
    return rows[0] ? rowToEntity(rows[0]) : null;
  }

  async findEntityByNormalizedName(namespace: string, normalizedName: string): Promise<Entity | null> {
    const { rows } = await this.driver.query<EntityRow>(
      `select id, namespace, type, name, normalized_name, aliases, description,
              metadata, mention_count, salience, first_seen_at, last_seen_at
       from entities where namespace = $1 and normalized_name = $2`,
      [namespace, normalizedName],
    );
    return rows[0] ? rowToEntity(rows[0]) : null;
  }

  async listEntities(namespace: string, options: EntityListOptions): Promise<Page<Entity>> {
    const builder = new QueryBuilder();
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const clauses = [`namespace = ${builder.bind(namespace)}`];

    if (options.type) {
      const types = Array.isArray(options.type) ? options.type : [options.type];
      clauses.push(`type = any(${builder.bind(types)}::entity_type[])`);
    }
    if (options.minMentions !== undefined) clauses.push(`mention_count >= ${builder.bind(options.minMentions)}`);
    if (options.search) {
      const term = builder.bind(`%${options.search}%`);
      clauses.push(`(name ilike ${term} or exists (select 1 from unnest(aliases) a where a ilike ${term}))`);
    }

    const sortColumn =
      options.sortBy === 'name' ? 'name asc'
      : options.sortBy === 'salience' ? 'salience desc'
      : options.sortBy === 'lastSeenAt' ? 'last_seen_at desc'
      : 'mention_count desc';

    const limitParam = builder.bind(limit);
    const offsetParam = builder.bind(offset);

    const { rows } = await this.driver.query<EntityRow & { total_count: string }>(
      `select id, namespace, type, name, normalized_name, aliases, description,
              metadata, mention_count, salience, first_seen_at, last_seen_at,
              count(*) over () as total_count
       from entities
       where ${clauses.join(' and ')}
       order by ${sortColumn}, id
       limit ${limitParam} offset ${offsetParam}`,
      builder.values(),
    );

    const total = rows[0] ? Number(rows[0].total_count) : 0;
    const items = rows.map(rowToEntity);
    return { items, total, limit, offset, hasMore: offset + items.length < total };
  }

  async deleteEntity(namespace: string, id: string): Promise<boolean> {
    // Relations cascade via the FK, so no manual cleanup is needed.
    const { rowCount } = await this.driver.query(
      `delete from entities where namespace = $1 and id = $2`,
      [namespace, id],
    );
    return (rowCount ?? 0) > 0;
  }

  async upsertRelations(relations: Relation[]): Promise<Relation[]> {
    if (relations.length === 0) return [];

    const builder = new QueryBuilder();
    const tuples = relations.map((relation) =>
      `(${[
        builder.bind(relation.id),
        builder.bind(relation.namespace),
        builder.bind(relation.sourceId),
        builder.bind(relation.targetId),
        `${builder.bind(relation.type)}::relation_type`,
        builder.bind(relation.weight),
        builder.bind(relation.confidence),
        `${builder.bind(relation.memoryIds)}::text[]`,
        `${builder.bind(JSON.stringify(relation.metadata))}::jsonb`,
        `${builder.bind(relation.createdAt)}::timestamptz`,
        `${builder.bind(relation.updatedAt)}::timestamptz`,
      ].join(', ')})`,
    );

    const { rows } = await this.driver.query<RelationRow>(
      `insert into relations (
         id, namespace, source_id, target_id, type, weight, confidence,
         memory_ids, metadata, created_at, updated_at
       ) values ${tuples.join(', ')}
       on conflict (namespace, source_id, target_id, type) do update set
         -- Repeated observation reinforces the edge with diminishing returns.
         weight     = least(1.0, relations.weight + excluded.weight * 0.25),
         confidence = greatest(relations.confidence, excluded.confidence),
         memory_ids = (
           select array_agg(distinct mid)
           from unnest(relations.memory_ids || excluded.memory_ids) as mid
         ),
         metadata   = relations.metadata || excluded.metadata,
         updated_at = excluded.updated_at
       returning id, namespace, source_id, target_id, type, weight, confidence,
                 memory_ids, metadata, created_at, updated_at`,
      builder.values(),
    );

    return rows.map(rowToRelation);
  }

  async listRelations(namespace: string, options: RelationListOptions): Promise<Relation[]> {
    const builder = new QueryBuilder();
    const clauses = [`namespace = ${builder.bind(namespace)}`];

    if (options.entityIds?.length) {
      const param = builder.bind(options.entityIds);
      clauses.push(`(source_id = any(${param}::text[]) or target_id = any(${param}::text[]))`);
    }
    if (options.types?.length) clauses.push(`type = any(${builder.bind(options.types)}::relation_type[])`);
    if (options.minWeight !== undefined) clauses.push(`weight >= ${builder.bind(options.minWeight)}`);

    const limitParam = builder.bind(options.limit ?? 1000);

    const { rows } = await this.driver.query<RelationRow>(
      `select id, namespace, source_id, target_id, type, weight, confidence,
              memory_ids, metadata, created_at, updated_at
       from relations
       where ${clauses.join(' and ')}
       order by weight desc
       limit ${limitParam}`,
      builder.values(),
    );

    return rows.map(rowToRelation);
  }

  async deleteRelation(namespace: string, id: string): Promise<boolean> {
    const { rowCount } = await this.driver.query(
      `delete from relations where namespace = $1 and id = $2`,
      [namespace, id],
    );
    return (rowCount ?? 0) > 0;
  }

  /* ----------------------------------------------------------------------- */
  /*                                  admin                                   */
  /* ----------------------------------------------------------------------- */

  async stats(namespace: string, options: StatsOptions = {}): Promise<MemoryStats> {
    const growthDays = options.growthDays ?? 30;
    const topTagsLimit = options.topTagsLimit ?? 20;

    // One round trip for every aggregate. Each CTE scans the same index range,
    // so Postgres can share the work.
    const { rows } = await this.driver.query<{
      totals: {
        total: number; active: number; archived: number; superseded: number;
        total_tokens: number; avg_importance: number; storage_bytes: number;
        oldest: string | null; newest: string | null;
      } | null;
      by_type: Record<string, number> | null;
      by_kind: Record<string, number> | null;
      growth: Array<{ date: string; count: number }> | null;
      top_tags: Array<{ tag: string; count: number }> | null;
      entity_count: number;
      relation_count: number;
    }>(
      `with scoped as (
         select * from memories where namespace = $1 and status <> 'deleted'
       ),
       totals as (
         select json_build_object(
           'total', count(*),
           'active', count(*) filter (where status = 'active'),
           'archived', count(*) filter (where status = 'archived'),
           'superseded', count(*) filter (where status = 'superseded'),
           'total_tokens', coalesce(sum(tokens), 0),
           'avg_importance', coalesce(avg(importance), 0),
           'storage_bytes', coalesce(sum(pg_column_size(content) + pg_column_size(embedding) + pg_column_size(metadata)), 0),
           'oldest', min(created_at),
           'newest', max(created_at)
         ) as data from scoped
       ),
       by_type as (
         select coalesce(json_object_agg(type, n), '{}'::json) as data
         from (select type, count(*) as n from scoped group by type) t
       ),
       by_kind as (
         select coalesce(json_object_agg(kind, n), '{}'::json) as data
         from (select kind, count(*) as n from scoped group by kind) t
       ),
       growth as (
         select coalesce(json_agg(json_build_object('date', d, 'count', n) order by d), '[]'::json) as data
         from (
           select date_trunc('day', created_at)::date as d, count(*) as n
           from scoped
           where created_at >= now() - ($2::int || ' days')::interval
           group by 1
         ) g
       ),
       top_tags as (
         select coalesce(json_agg(json_build_object('tag', tag, 'count', n) order by n desc), '[]'::json) as data
         from (
           select unnest(tags) as tag, count(*) as n
           from scoped group by 1 order by n desc limit $3
         ) t
       )
       select totals.data as totals, by_type.data as by_type, by_kind.data as by_kind,
              growth.data as growth, top_tags.data as top_tags,
              (select count(*) from entities where namespace = $1) as entity_count,
              (select count(*) from relations where namespace = $1) as relation_count
       from totals, by_type, by_kind, growth, top_tags`,
      [namespace, growthDays, topTagsLimit],
    );

    const row = rows[0];
    const totals = row?.totals;

    const byType = Object.fromEntries(MEMORY_TYPES.map((type) => [type, 0])) as Record<MemoryType, number>;
    for (const [type, count] of Object.entries(row?.by_type ?? {})) {
      if (type in byType) byType[type as MemoryType] = Number(count);
    }

    const byKind = Object.fromEntries(MEMORY_KINDS.map((kind) => [kind, 0])) as Record<MemoryKind, number>;
    for (const [kind, count] of Object.entries(row?.by_kind ?? {})) {
      if (kind in byKind) byKind[kind as MemoryKind] = Number(count);
    }

    const dailyCounts = new Map((row?.growth ?? []).map((g) => [String(g.date).slice(0, 10), Number(g.count)]));
    const growth: MemoryStats['growth'] = [];
    let cumulative = Math.max(0, Number(totals?.total ?? 0) - Array.from(dailyCounts.values()).reduce((a, b) => a + b, 0));
    const today = new Date();
    for (let offset = growthDays - 1; offset >= 0; offset--) {
      const date = new Date(today.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
      const count = dailyCounts.get(date) ?? 0;
      cumulative += count;
      growth.push({ date, count, cumulative });
    }

    return {
      total: Number(totals?.total ?? 0),
      active: Number(totals?.active ?? 0),
      archived: Number(totals?.archived ?? 0),
      superseded: Number(totals?.superseded ?? 0),
      byType,
      byKind,
      totalTokens: Number(totals?.total_tokens ?? 0),
      avgImportance: Number(totals?.avg_importance ?? 0),
      growth,
      topTags: (row?.top_tags ?? []).map((t) => ({ tag: t.tag, count: Number(t.count) })),
      entityCount: Number(row?.entity_count ?? 0),
      relationCount: Number(row?.relation_count ?? 0),
      storageBytes: Number(totals?.storage_bytes ?? 0),
      oldestMemoryAt: totals?.oldest ? new Date(totals.oldest).toISOString() : null,
      newestMemoryAt: totals?.newest ? new Date(totals.newest).toISOString() : null,
    };
  }

  async purgeExpired(namespace: string, now: Date = new Date()): Promise<number> {
    const { rowCount } = await this.driver.query(
      `delete from memories where namespace = $1 and expires_at is not null and expires_at <= $2`,
      [namespace, now.toISOString()],
    );
    return rowCount ?? 0;
  }

  async clearNamespace(namespace: string): Promise<number> {
    const { rows } = await this.driver.query<{ count: string }>(
      `with deleted as (delete from memories where namespace = $1 returning 1)
       select count(*) as count from deleted`,
      [namespace],
    );
    // Entities and relations cascade from the namespace row; drop them explicitly
    // since the namespace itself is retained.
    await this.driver.query(`delete from relations where namespace = $1`, [namespace]);
    await this.driver.query(`delete from entities where namespace = $1`, [namespace]);
    this.ensuredNamespaces.delete(namespace);
    return Number(rows[0]?.count ?? 0);
  }

  /** Append a retrieval event for the analytics dashboard. Never throws. */
  async logRetrieval(event: {
    namespace: string;
    query: string;
    mode: string;
    resultCount: number;
    topScore?: number;
    tookMs: number;
    tokenBudget?: number;
    tokensUsed?: number;
    userId?: string;
    agentId?: string;
  }): Promise<void> {
    try {
      await this.driver.query(
        `insert into retrieval_events
           (namespace, query, mode, result_count, top_score, took_ms, token_budget, tokens_used, user_id, agent_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          event.namespace, event.query, event.mode, event.resultCount,
          event.topScore ?? null, event.tookMs, event.tokenBudget ?? null,
          event.tokensUsed ?? null, event.userId ?? null, event.agentId ?? null,
        ],
      );
    } catch {
      // Analytics must never break a user-facing request.
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                                 Row mappers                                 */
/* -------------------------------------------------------------------------- */

interface EntityRow {
  id: string;
  namespace: string;
  type: Entity['type'];
  name: string;
  normalized_name: string;
  aliases: string[] | null;
  description: string | null;
  metadata: Record<string, unknown> | string;
  mention_count: number;
  salience: number;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
}

function rowToEntity(row: EntityRow): Entity {
  return {
    id: row.id,
    namespace: row.namespace,
    type: row.type,
    name: row.name,
    normalizedName: row.normalized_name,
    aliases: row.aliases ?? [],
    description: row.description,
    metadata: (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) as Entity['metadata'],
    mentionCount: Number(row.mention_count),
    salience: Number(row.salience),
    firstSeenAt: requireIso(row.first_seen_at),
    lastSeenAt: requireIso(row.last_seen_at),
  };
}

interface RelationRow {
  id: string;
  namespace: string;
  source_id: string;
  target_id: string;
  type: Relation['type'];
  weight: number;
  confidence: number;
  memory_ids: string[] | null;
  metadata: Record<string, unknown> | string;
  created_at: Date | string;
  updated_at: Date | string;
}

function rowToRelation(row: RelationRow): Relation {
  return {
    id: row.id,
    namespace: row.namespace,
    sourceId: row.source_id,
    targetId: row.target_id,
    type: row.type,
    weight: Number(row.weight),
    confidence: Number(row.confidence),
    memoryIds: row.memory_ids ?? [],
    metadata: (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) as Relation['metadata'],
    createdAt: requireIso(row.created_at),
    updatedAt: requireIso(row.updated_at),
  };
}
