/**
 * Process-wide `MemoryClient` singleton.
 *
 * Next.js hot-reloads modules in development, which would otherwise create a
 * new client — and with the in-memory adapter, a new *database* — on every
 * edit. Stashing the instance on `globalThis` keeps it stable across reloads.
 */
import {
  MemoryClient,
  InMemoryStorageAdapter,
  PostgresStorageAdapter,
  createEmbeddingProvider,
  createLogger,
  Metrics,
  type StorageAdapter,
  type SqlDriver,
} from '@memorydb/core';
import { env, isDevelopment } from './env';

export const logger = createLogger({
  level: env.LOG_LEVEL,
  pretty: env.LOG_PRETTY || isDevelopment,
  base: { service: 'memorydb' },
});

export const metrics = new Metrics();

interface GlobalCache {
  client?: Promise<MemoryClient>;
  driver?: SqlDriver;
}

const globalCache = globalThis as unknown as { __memorydb?: GlobalCache };
globalCache.__memorydb ??= {};

/**
 * Build the Postgres driver lazily.
 *
 * `pg` is imported dynamically so it is never bundled into the Edge runtime and
 * so the app starts without it installed when using the in-memory adapter.
 */
async function createPostgresDriver(): Promise<SqlDriver> {
  if (globalCache.__memorydb?.driver) return globalCache.__memorydb.driver;

  let Pool: new (config: Record<string, unknown>) => SqlDriver;
  try {
    ({ Pool } = (await import('pg')) as unknown as {
      Pool: new (config: Record<string, unknown>) => SqlDriver;
    });
  } catch {
    throw new Error(
      'STORAGE_DRIVER=postgres requires the "pg" package. Install it with: pnpm add pg',
    );
  }

  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    // Supabase and most managed providers terminate plaintext connections.
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : false,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Bound how long a single statement may hold a connection.
    statement_timeout: 30_000,
  });

  globalCache.__memorydb!.driver = pool;
  return pool;
}

async function buildStorage(): Promise<StorageAdapter> {
  if (env.STORAGE_DRIVER === 'postgres') {
    return new PostgresStorageAdapter({
      driver: await createPostgresDriver(),
      dimensions: env.EMBEDDING_DIMENSIONS,
    });
  }
  return new InMemoryStorageAdapter();
}

async function buildClient(): Promise<MemoryClient> {
  const storage = await buildStorage();

  const embeddings = createEmbeddingProvider({
    provider: env.EMBEDDING_PROVIDER,
    dimensions: env.EMBEDDING_DIMENSIONS,
    ...(env.EMBEDDING_MODEL ? { model: env.EMBEDDING_MODEL } : {}),
    ...(env.EMBEDDING_API_KEY ? { apiKey: env.EMBEDDING_API_KEY } : {}),
    ...(env.EMBEDDING_BASE_URL ? { baseUrl: env.EMBEDDING_BASE_URL } : {}),
    cacheTtlSeconds: env.CACHE_TTL_SECONDS,
    appUrl: env.NEXT_PUBLIC_APP_URL,
    appName: 'MemoryDB AI',
  });

  const client = await MemoryClient.create({
    storage,
    embeddings,
    logger,
    metrics,
    namespace: env.DEFAULT_NAMESPACE,
  });

  logger.info('memory engine initialised', {
    storage: storage.name,
    embeddingProvider: embeddings.id,
    embeddingModel: embeddings.model,
    dimensions: embeddings.dimensions,
  });

  // Seed a small demo corpus so the dashboard is never an empty shell on first
  // run. Only for the ephemeral in-memory adapter — never touches a real database.
  if (env.STORAGE_DRIVER === 'memory') {
    await seedDemoData(client);
  }

  return client;
}

/** Resolve the shared client, initialising it exactly once. */
export function getMemoryClient(): Promise<MemoryClient> {
  globalCache.__memorydb!.client ??= buildClient().catch((err) => {
    // Clear the cache so a transient failure doesn't poison every later request.
    globalCache.__memorydb!.client = undefined as unknown as Promise<MemoryClient>;
    throw err;
  });
  return globalCache.__memorydb!.client;
}

/** A client scoped to a specific namespace, sharing the initialised storage. */
export async function getNamespacedClient(namespace: string): Promise<MemoryClient> {
  const client = await getMemoryClient();
  return namespace === client.namespace ? client : client.forNamespace(namespace);
}

const DEMO_MEMORIES = [
  {
    content:
      'The production database runs PostgreSQL 16 with the pgvector extension. Vector similarity uses an HNSW index with cosine distance, tuned to m=16 and ef_construction=64.',
    type: 'semantic' as const,
    kind: 'knowledge' as const,
    title: 'Production database configuration',
    tags: ['infrastructure', 'database', 'pgvector'],
    importance: 0.85,
  },
  {
    content:
      'Ada Lovelace leads the platform team. She prefers async written updates over synchronous standups, and asks that design documents circulate at least 24 hours before review.',
    type: 'semantic' as const,
    kind: 'profile' as const,
    title: 'Ada Lovelace — working preferences',
    tags: ['people', 'preferences'],
    importance: 0.9,
  },
  {
    content:
      'Deployments run through GitHub Actions to Vercel. The pipeline gates on lint, typecheck, unit tests, and a production build. Releases go out on Thursdays to leave Friday for rollback.',
    type: 'procedural' as const,
    kind: 'knowledge' as const,
    title: 'Deployment process',
    tags: ['ci', 'deployment', 'process'],
    importance: 0.8,
  },
  {
    content:
      'Incident 2026-03-14: the search endpoint returned stale results for 40 minutes after a Redis failover. Root cause was a cache key that omitted the embedding model id, so vectors from the previous model were served. Fixed by including the model in every cache key.',
    type: 'episodic' as const,
    kind: 'event' as const,
    title: 'Incident: stale search results after Redis failover',
    tags: ['incident', 'redis', 'caching'],
    importance: 0.75,
  },
  {
    content:
      'The team decided to keep the local feature-hashing embedder as the default provider so the project runs with no API key and no cost. Neural embeddings remain a one-line configuration change for users who want them.',
    type: 'long_term' as const,
    kind: 'note' as const,
    title: 'Decision: default embedding provider',
    tags: ['decision', 'embeddings', 'architecture'],
    importance: 0.7,
  },
  {
    content:
      'Rate limits: 120 requests per minute for reads and 60 per minute for writes, keyed by API key. Limits are enforced with a sliding window and return a Retry-After header on rejection.',
    type: 'semantic' as const,
    kind: 'knowledge' as const,
    title: 'API rate limits',
    tags: ['api', 'limits'],
    importance: 0.65,
  },
];

async function seedDemoData(client: MemoryClient): Promise<void> {
  try {
    if ((await client.count()) > 0) return;
    await client.storeMany(DEMO_MEMORIES);
    logger.info('seeded demo memories', { count: DEMO_MEMORIES.length });
  } catch (err) {
    logger.warn('failed to seed demo memories', { error: err });
  }
}
