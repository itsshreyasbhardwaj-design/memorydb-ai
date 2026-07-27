/**
 * Official TypeScript SDK for MemoryDB AI.
 *
 * Zero dependencies, works in Node 18+, Bun, Deno, Edge runtimes, and browsers.
 * Every method is fully typed, retries transient failures with exponential
 * backoff, and surfaces errors as a single `MemoryDBApiError` carrying the
 * server's machine-readable code.
 *
 * ```ts
 * import { MemoryDB } from '@memorydb/sdk';
 *
 * const memory = new MemoryDB({ apiKey: process.env.MEMORYDB_API_KEY! });
 *
 * await memory.store({ content: 'Ada prefers dark mode.', type: 'semantic' });
 * const { context } = await memory.retrieve({ query: 'Ada preferences?' });
 * ```
 */

/* -------------------------------------------------------------------------- */
/*                                   Types                                     */
/* -------------------------------------------------------------------------- */

export type MemoryType =
  | 'short_term' | 'long_term' | 'working'
  | 'semantic' | 'episodic' | 'procedural' | 'graph';

export type MemoryKind =
  | 'conversation' | 'document' | 'note' | 'preference' | 'profile'
  | 'task' | 'event' | 'knowledge' | 'code' | 'other';

export type MemoryStatus = 'active' | 'archived' | 'superseded' | 'deleted';
export type SearchMode = 'hybrid' | 'semantic' | 'keyword';

export type EntityType =
  | 'person' | 'project' | 'concept' | 'file' | 'organization'
  | 'event' | 'location' | 'product' | 'technology' | 'other';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type Metadata = Record<string, JsonValue>;

export interface Memory {
  id: string;
  namespace: string;
  userId: string | null;
  agentId: string | null;
  sessionId: string | null;
  type: MemoryType;
  kind: MemoryKind;
  status: MemoryStatus;
  content: string;
  summary: string | null;
  title: string | null;
  metadata: Metadata;
  tags: string[];
  importance: number;
  confidence: number;
  embedding: number[] | null;
  embeddingModel: string | null;
  tokens: number;
  accessCount: number;
  lastAccessedAt: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  archivedAt: string | null;
  supersededBy: string | null;
  sourceId: string | null;
  contentHash: string;
  version: number;
}

export interface MetadataCondition {
  eq?: JsonValue;
  ne?: JsonValue;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  in?: JsonValue[];
  nin?: JsonValue[];
  contains?: string;
  exists?: boolean;
}

export interface MemoryFilter {
  type?: MemoryType | MemoryType[];
  kind?: MemoryKind | MemoryKind[];
  status?: MemoryStatus | MemoryStatus[];
  userId?: string;
  agentId?: string;
  sessionId?: string;
  sourceId?: string;
  ids?: string[];
  /** Every tag must be present. */
  tags?: string[];
  /** At least one tag must be present. */
  anyTags?: string[];
  /** Dotted keys address nested paths, e.g. `'source.channel'`. */
  metadata?: Record<string, JsonValue | MetadataCondition>;
  createdAfter?: string;
  createdBefore?: string;
  updatedAfter?: string;
  updatedBefore?: string;
  minImportance?: number;
  minConfidence?: number;
  includeArchived?: boolean;
  includeExpired?: boolean;
}

export interface StoreInput {
  content: string;
  type?: MemoryType;
  kind?: MemoryKind;
  title?: string | null;
  summary?: string | null;
  userId?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
  metadata?: Metadata;
  tags?: string[];
  importance?: number;
  confidence?: number;
  sourceId?: string | null;
  ttlSeconds?: number | null;
  expiresAt?: string | null;
  /** Return an existing identical memory instead of inserting a duplicate. */
  deduplicate?: boolean;
  /** Split long content into overlapping chunks before storing. */
  chunk?: boolean;
}

export interface UpdateInput {
  content?: string;
  title?: string | null;
  summary?: string | null;
  type?: MemoryType;
  kind?: MemoryKind;
  status?: MemoryStatus;
  metadata?: Metadata;
  /** Replaces the whole tag set. */
  tags?: string[];
  addTags?: string[];
  removeTags?: string[];
  importance?: number;
  confidence?: number;
  expiresAt?: string | null;
}

export interface SearchInput {
  query: string;
  mode?: SearchMode;
  limit?: number;
  offset?: number;
  filter?: MemoryFilter;
  minScore?: number;
  vectorWeight?: number;
  keywordWeight?: number;
  recencyHalfLifeDays?: number;
  importanceWeight?: number;
  trackAccess?: boolean;
  explain?: boolean;
}

export interface RetrieveInput extends SearchInput {
  tokenBudget?: number;
  diversify?: boolean;
  diversityThreshold?: number;
  formatContext?: boolean;
}

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
  span: { start: number; end: number } | null;
  snippet: string;
}

export interface SearchHit {
  memory: Memory;
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
  tookMs: number;
}

export interface RetrieveResult extends SearchResult {
  /** Model-ready context block with inline `[n]` citation markers. */
  context: string;
  citations: Citation[];
  tokensUsed: number;
  confidence: number;
  dropped: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface Entity {
  id: string;
  namespace: string;
  type: EntityType;
  name: string;
  normalizedName: string;
  aliases: string[];
  description: string | null;
  metadata: Metadata;
  mentionCount: number;
  salience: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface GraphNode extends Entity {
  degree: number;
}

export interface GraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  sourceName: string;
  targetName: string;
  type: string;
  weight: number;
  confidence: number;
  memoryIds: string[];
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

export interface MemoryStats {
  total: number;
  active: number;
  archived: number;
  superseded: number;
  byType: Record<MemoryType, number>;
  byKind: Record<MemoryKind, number>;
  totalTokens: number;
  avgImportance: number;
  growth: Array<{ date: string; count: number; cumulative: number }>;
  topTags: Array<{ tag: string; count: number }>;
  entityCount: number;
  relationCount: number;
  storageBytes: number;
  oldestMemoryAt: string | null;
  newestMemoryAt: string | null;
  namespace: string;
  embeddings: { provider: string; model: string; dimensions: number; remote: boolean };
}

export interface ConsolidationReport {
  scanned: number;
  duplicatesMerged: number;
  memoriesSummarized: number;
  summariesCreated: number;
  archived: number;
  expired: number;
  clusters: Array<{
    id: string;
    label: string;
    memoryIds: string[];
    keywords: string[];
    coherence: number;
  }>;
  tokensReclaimed: number;
  tookMs: number;
  dryRun: boolean;
  warnings: string[];
}

export interface ImportResult {
  imported: number;
  deduplicated: number;
  failed: number;
  total: number;
  dryRun: boolean;
  errors: Array<{ index: number; message: string }>;
  tookMs: number;
}

export type ExportFormat = 'json' | 'jsonl' | 'csv' | 'markdown' | 'txt' | 'zip';

/* -------------------------------------------------------------------------- */
/*                                   Errors                                    */
/* -------------------------------------------------------------------------- */

export type ApiErrorCode =
  | 'validation_error' | 'not_found' | 'conflict' | 'unauthorized' | 'forbidden'
  | 'rate_limited' | 'payload_too_large' | 'storage_error' | 'embedding_error'
  | 'provider_error' | 'not_supported' | 'timeout' | 'internal_error'
  | 'network_error';

export class MemoryDBApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'MemoryDBApiError';
  }

  /** True when the failure is a rate limit; pair with `retryAfterSeconds`. */
  get isRateLimit(): boolean {
    return this.code === 'rate_limited';
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Client                                    */
/* -------------------------------------------------------------------------- */

export interface MemoryDBOptions {
  /** API key. Sent as `Authorization: Bearer`. */
  apiKey?: string;
  /** Base URL of the deployment. Defaults to `http://localhost:3000`. */
  baseUrl?: string;
  /** Tenant scope. Sent as `X-Namespace`. */
  namespace?: string;
  /** Per-request timeout in ms. Defaults to 30s. */
  timeoutMs?: number;
  /** Retry attempts for transient failures. Defaults to 2. */
  maxRetries?: number;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
  /** Injectable fetch, for tests or custom transports. */
  fetch?: typeof fetch;
}

interface Envelope<T> {
  data: T;
  error: null;
}

interface ErrorEnvelope {
  error: { code: ApiErrorCode; message: string; details?: unknown; retryable?: boolean };
  requestId?: string;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class MemoryDB {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly namespace: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly extraHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MemoryDBOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://localhost:3000').replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.namespace = options.namespace;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.extraHeaders = options.headers ?? {};

    const resolvedFetch = options.fetch ?? globalThis.fetch;
    if (!resolvedFetch) {
      throw new Error(
        'No fetch implementation found. Use Node 18+, or pass one via the `fetch` option.',
      );
    }
    // Bind so implementations that rely on `this` (e.g. undici) keep working.
    this.fetchImpl = resolvedFetch.bind(globalThis);
  }

  /** A client bound to a different namespace, reusing this configuration. */
  forNamespace(namespace: string): MemoryDB {
    return new MemoryDB({
      baseUrl: this.baseUrl,
      namespace,
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
      headers: this.extraHeaders,
      fetch: this.fetchImpl,
      ...(this.apiKey !== undefined ? { apiKey: this.apiKey } : {}),
    });
  }

  /* ------------------------------- Memories ------------------------------ */

  /** Store a memory. Identical content is de-duplicated by default. */
  async store(input: StoreInput): Promise<{
    memory: Memory;
    deduplicated: boolean;
    entitiesExtracted: number;
    chunks?: number;
  }> {
    return this.request('POST', '/memories', { body: input });
  }

  /** Store many memories in one request. Embeddings are computed in one batch. */
  async storeMany(memories: StoreInput[]): Promise<{
    memories: Memory[];
    count: number;
    deduplicated: number;
  }> {
    return this.request('POST', '/memories', { body: { memories } });
  }

  async get(id: string): Promise<Memory> {
    const result = await this.request<{ memory: Memory }>('GET', `/memories/${encodeURIComponent(id)}`);
    return result.memory;
  }

  async update(id: string, patch: UpdateInput): Promise<Memory> {
    const result = await this.request<{ memory: Memory }>(
      'PATCH',
      `/memories/${encodeURIComponent(id)}`,
      { body: patch },
    );
    return result.memory;
  }

  /** Soft-delete by default; `hard` removes the row permanently. */
  async delete(id: string, options: { hard?: boolean } = {}): Promise<boolean> {
    const result = await this.request<{ deleted: boolean }>(
      'DELETE',
      `/memories/${encodeURIComponent(id)}`,
      { query: { hard: options.hard } },
    );
    return result.deleted;
  }

  /** Bulk delete by filter. Requires the `admin` scope. */
  async deleteMany(filter: MemoryFilter, options: { hard?: boolean } = {}): Promise<number> {
    const result = await this.request<{ deleted: number }>('DELETE', '/memories', {
      body: { filter, hard: options.hard ?? false },
    });
    return result.deleted;
  }

  async list(
    options: {
      limit?: number;
      offset?: number;
      sortBy?: 'createdAt' | 'updatedAt' | 'importance' | 'accessCount' | 'lastAccessedAt';
      sortDir?: 'asc' | 'desc';
      type?: MemoryType[];
      tags?: string[];
      userId?: string;
      includeArchived?: boolean;
    } = {},
  ): Promise<Page<Memory>> {
    return this.request('GET', '/memories', { query: options as Record<string, unknown> });
  }

  /**
   * Iterate every matching memory, transparently paging.
   *
   * ```ts
   * for await (const memory of client.iterate({ tags: ['infra'] })) { … }
   * ```
   */
  async *iterate(
    options: { type?: MemoryType[]; tags?: string[]; userId?: string; batchSize?: number } = {},
  ): AsyncGenerator<Memory, void, undefined> {
    const batchSize = options.batchSize ?? 100;
    let offset = 0;

    for (;;) {
      const page = await this.list({ ...options, limit: batchSize, offset });
      for (const memory of page.items) yield memory;
      if (!page.hasMore) return;
      offset += page.items.length;
      // Defensive: a server that never advances would otherwise loop forever.
      if (page.items.length === 0) return;
    }
  }

  /* ------------------------------- Retrieval ----------------------------- */

  /** Hybrid semantic + keyword search with intelligent ranking. */
  async search(input: SearchInput): Promise<SearchResult> {
    return this.request('POST', '/search', { body: input });
  }

  /**
   * Retrieval shaped for direct use as model context: redundant hits removed,
   * a token budget enforced, and a formatted block with citation markers.
   */
  async retrieve(input: RetrieveInput): Promise<RetrieveResult> {
    return this.request('POST', '/retrieve', { body: input });
  }

  /** Shorthand returning just the context string. */
  async context(query: string, options: Omit<RetrieveInput, 'query'> = {}): Promise<string> {
    const result = await this.retrieve({ query, ...options });
    return result.context;
  }

  /* --------------------------------- Graph ------------------------------- */

  async graph(
    options: {
      types?: EntityType[];
      rootIds?: string[];
      depth?: number;
      minWeight?: number;
      maxNodes?: number;
      search?: string;
    } = {},
  ): Promise<KnowledgeGraph> {
    return this.request('GET', '/graph', { query: options as Record<string, unknown> });
  }

  async entities(
    options: {
      type?: EntityType[];
      search?: string;
      minMentions?: number;
      limit?: number;
      offset?: number;
      sortBy?: 'mentionCount' | 'salience' | 'lastSeenAt' | 'name';
    } = {},
  ): Promise<Page<Entity>> {
    return this.request('GET', '/graph/entities', { query: options as Record<string, unknown> });
  }

  /* ------------------------------ Embeddings ----------------------------- */

  async embed(
    input: string | string[],
    options: { similarity?: boolean } = {},
  ): Promise<{
    model: string;
    provider: string;
    dimensions: number;
    embeddings: Array<{ index: number; embedding: number[] }>;
    similarity?: number[][];
  }> {
    return this.request('POST', '/embeddings', {
      body: { input, similarity: options.similarity ?? false },
    });
  }

  /* -------------------------------- Admin -------------------------------- */

  async stats(options: { growthDays?: number; topTagsLimit?: number } = {}): Promise<MemoryStats> {
    return this.request('GET', '/stats', { query: options as Record<string, unknown> });
  }

  /** Run consolidation. Requires the `admin` scope. */
  async consolidate(
    options: {
      dryRun?: boolean;
      duplicateThreshold?: number;
      summarizeOlderThanDays?: number;
      types?: MemoryType[];
      deduplicate?: boolean;
      summarize?: boolean;
      archive?: boolean;
      expire?: boolean;
      cluster?: boolean;
    } = {},
  ): Promise<ConsolidationReport> {
    return this.request('POST', '/consolidate', { body: options });
  }

  async health(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    version: string;
    checks: Record<string, unknown>;
  }> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/v1/health`);
    return (await response.json()) as {
      status: 'healthy' | 'degraded' | 'unhealthy';
      version: string;
      checks: Record<string, unknown>;
    };
  }

  /* ------------------------------- Portability --------------------------- */

  /** Import memories from a serialised payload. */
  async import(
    data: string | Uint8Array,
    options: {
      format?: ExportFormat;
      filename?: string;
      deduplicate?: boolean;
      dryRun?: boolean;
      tags?: string[];
    } = {},
  ): Promise<ImportResult> {
    const contentType =
      options.format === 'zip' ? 'application/zip'
      : options.format === 'csv' ? 'text/csv'
      : options.format === 'markdown' ? 'text/markdown'
      : options.format === 'txt' ? 'text/plain'
      : 'application/json';

    return this.request('POST', '/batch/import', {
      query: options as Record<string, unknown>,
      rawBody: data,
      contentType,
    });
  }

  /** Export the namespace. Returns text for text formats and bytes for ZIP. */
  async export(
    options: {
      format?: ExportFormat;
      includeEmbeddings?: boolean;
      includeGraph?: boolean;
      limit?: number;
      filter?: Pick<MemoryFilter, 'type' | 'tags' | 'userId' | 'sessionId'>;
    } = {},
  ): Promise<{ data: string | Uint8Array; contentType: string; count: number }> {
    const format = options.format ?? 'json';
    const query: Record<string, unknown> = {
      format,
      includeEmbeddings: options.includeEmbeddings,
      includeGraph: options.includeGraph,
      limit: options.limit,
      ...(options.filter ?? {}),
    };

    const response = await this.raw('GET', '/batch/export', { query });
    const count = Number(response.headers.get('x-memorydb-count') ?? 0);
    const contentType = response.headers.get('content-type') ?? 'application/json';

    return {
      data: format === 'zip' ? new Uint8Array(await response.arrayBuffer()) : await response.text(),
      contentType,
      count,
    };
  }

  /* -------------------------------- Internals ---------------------------- */

  private buildUrl(path: string, query?: Record<string, unknown>): string {
    const url = new URL(`${this.baseUrl}/api/v1${path}`);
    if (!query) return url.toString();

    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }
    return url.toString();
  }

  private headers(contentType?: string): Record<string, string> {
    return {
      accept: 'application/json',
      ...(contentType ? { 'content-type': contentType } : {}),
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      ...(this.namespace ? { 'x-namespace': this.namespace } : {}),
      ...this.extraHeaders,
    };
  }

  /**
   * Issue a request with timeout and bounded retries.
   *
   * Only idempotent-safe failures are retried: transport errors, timeouts, and
   * the retryable status codes. A 4xx other than 429 is never retried, since
   * repeating it cannot change the outcome.
   */
  private async raw(
    method: string,
    path: string,
    options: {
      body?: unknown;
      query?: Record<string, unknown>;
      rawBody?: string | Uint8Array;
      contentType?: string;
    } = {},
  ): Promise<Response> {
    const url = this.buildUrl(path, options.query);
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        // Exponential backoff with full jitter.
        const backoff = Math.min(8000, 300 * 2 ** (attempt - 1));
        await new Promise((resolve) => setTimeout(resolve, Math.random() * backoff));
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const init: RequestInit = {
          method,
          headers: this.headers(
            options.rawBody !== undefined
              ? options.contentType
              : options.body !== undefined
                ? 'application/json'
                : undefined,
          ),
          signal: controller.signal,
        };

        if (options.rawBody !== undefined) {
          init.body =
            typeof options.rawBody === 'string'
              ? options.rawBody
              : (options.rawBody.slice().buffer as ArrayBuffer);
        } else if (options.body !== undefined) {
          init.body = JSON.stringify(options.body);
        }

        const response = await this.fetchImpl(url, init);

        if (RETRYABLE_STATUS.has(response.status) && attempt < this.maxRetries) {
          // Honour Retry-After when the server supplies it.
          const retryAfter = Number(response.headers.get('retry-after') ?? 0);
          if (retryAfter > 0) await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
          lastError = new MemoryDBApiError(response.status, 'internal_error', `HTTP ${response.status}`);
          continue;
        }

        return response;
      } catch (err) {
        lastError = err;
        const aborted = err instanceof Error && err.name === 'AbortError';
        if (attempt === this.maxRetries) {
          throw new MemoryDBApiError(
            0,
            aborted ? 'timeout' : 'network_error',
            aborted ? `request timed out after ${this.timeoutMs}ms` : `network request failed: ${String(err)}`,
            undefined,
            undefined,
            true,
          );
        }
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError instanceof MemoryDBApiError
      ? lastError
      : new MemoryDBApiError(0, 'network_error', 'request failed after retries');
  }

  private async request<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      query?: Record<string, unknown>;
      rawBody?: string | Uint8Array;
      contentType?: string;
    } = {},
  ): Promise<T> {
    const response = await this.raw(method, path, options);
    const text = await response.text();

    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new MemoryDBApiError(
        response.status,
        'internal_error',
        `expected JSON but received: ${text.slice(0, 200)}`,
      );
    }

    if (!response.ok) {
      const envelope = payload as ErrorEnvelope;
      const error = envelope.error;
      throw new MemoryDBApiError(
        response.status,
        error?.code ?? 'internal_error',
        error?.message ?? `HTTP ${response.status}`,
        error?.details,
        envelope.requestId,
        error?.retryable ?? false,
      );
    }

    return (payload as Envelope<T>).data;
  }
}

/** Convenience factory reading `MEMORYDB_API_KEY` and `MEMORYDB_URL` from the environment. */
export function createClient(options: MemoryDBOptions = {}): MemoryDB {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  return new MemoryDB({
    ...(env.MEMORYDB_API_KEY ? { apiKey: env.MEMORYDB_API_KEY } : {}),
    ...(env.MEMORYDB_URL ? { baseUrl: env.MEMORYDB_URL } : {}),
    ...(env.MEMORYDB_NAMESPACE ? { namespace: env.MEMORYDB_NAMESPACE } : {}),
    ...options,
  });
}

export const VERSION = '0.1.0';
export default MemoryDB;
