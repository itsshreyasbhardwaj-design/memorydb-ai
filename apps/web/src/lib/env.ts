/**
 * Environment validation.
 *
 * Parsed once at module load and fails loudly at boot rather than at the first
 * request. A misconfigured deployment should refuse to start, not serve errors
 * for an hour before anyone notices.
 *
 * Every value is optional with a working default, so `pnpm dev` runs with no
 * `.env` at all: in-memory storage, local embeddings, no external services.
 */
import { z } from 'zod';

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) => (typeof value === 'boolean' ? value : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /* ------------------------------- storage ------------------------------- */
  /** `memory` needs nothing; `postgres` requires DATABASE_URL. */
  STORAGE_DRIVER: z.enum(['memory', 'postgres']).default('memory'),
  DATABASE_URL: z.string().url().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),
  DATABASE_SSL: booleanish.default(true),

  /* ------------------------------ embeddings ----------------------------- */
  /** Defaults to the free, offline provider — no key, no spend, no network. */
  EMBEDDING_PROVIDER: z.enum(['local', 'openrouter', 'openai', 'ollama', 'custom']).default('local'),
  EMBEDDING_MODEL: z.string().optional(),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().min(32).max(8192).default(384),
  EMBEDDING_API_KEY: z.string().optional(),
  EMBEDDING_BASE_URL: z.string().url().optional(),

  /* -------------------------------- cache -------------------------------- */
  REDIS_URL: z.string().optional(),
  CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  /* --------------------------------- auth -------------------------------- */
  /**
   * Bootstrap key for the default namespace. When unset in development a
   * predictable dev key is used; in production a missing key means API-key auth
   * is disabled entirely rather than silently accepting a guessable default.
   */
  MEMORYDB_API_KEY: z.string().min(16).optional(),
  CLERK_SECRET_KEY: z.string().optional(),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().optional(),
  /** Disable auth for local exploration. Refused in production. */
  AUTH_DISABLED: booleanish.default(false),

  /* ------------------------------ rate limits ---------------------------- */
  RATE_LIMIT_ENABLED: booleanish.default(true),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_WRITE_MAX: z.coerce.number().int().positive().default(60),

  /* -------------------------------- limits ------------------------------- */
  MAX_CONTENT_LENGTH: z.coerce.number().int().positive().default(1_000_000),
  MAX_BATCH_SIZE: z.coerce.number().int().positive().max(1000).default(200),
  MAX_IMPORT_BYTES: z.coerce.number().int().positive().default(50 * 1024 * 1024),

  /* ------------------------------ observability -------------------------- */
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  LOG_PRETTY: booleanish.default(false),
  METRICS_ENABLED: booleanish.default(true),

  /* --------------------------------- app --------------------------------- */
  NEXT_PUBLIC_APP_URL: z.string().url().default('http://localhost:3000'),
  DEFAULT_NAMESPACE: z.string().min(1).default('default'),
});

export type Env = z.infer<typeof envSchema>;

function parseEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}\n\nSee .env.example for the full reference.`);
  }

  const env = parsed.data;

  // Cross-field rules that a per-field schema cannot express.
  if (env.STORAGE_DRIVER === 'postgres' && !env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when STORAGE_DRIVER is "postgres"');
  }

  if ((env.EMBEDDING_PROVIDER === 'openrouter' || env.EMBEDDING_PROVIDER === 'openai') && !env.EMBEDDING_API_KEY) {
    throw new Error(`EMBEDDING_API_KEY is required when EMBEDDING_PROVIDER is "${env.EMBEDDING_PROVIDER}"`);
  }

  if (env.EMBEDDING_PROVIDER === 'custom' && (!env.EMBEDDING_BASE_URL || !env.EMBEDDING_MODEL)) {
    throw new Error('EMBEDDING_BASE_URL and EMBEDDING_MODEL are required when EMBEDDING_PROVIDER is "custom"');
  }

  if (env.NODE_ENV === 'production') {
    // Refusing to boot beats silently serving an open API.
    if (env.AUTH_DISABLED) {
      throw new Error('AUTH_DISABLED cannot be enabled in production');
    }
    if (env.STORAGE_DRIVER === 'memory') {
      // A warning rather than a hard failure: ephemeral deployments (demos,
      // preview environments) are a legitimate production-mode use.
      console.warn(
        '[memorydb] STORAGE_DRIVER=memory in production — all memories are lost on restart. Set STORAGE_DRIVER=postgres to persist.',
      );
    }
  }

  return env;
}

export const env: Env = parseEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';
export const isTest = env.NODE_ENV === 'test';

/**
 * Effective API key. In development a stable fallback keeps the quickstart
 * copy-pasteable; in production only an explicitly configured key is accepted.
 */
export const apiKey: string | null =
  env.MEMORYDB_API_KEY ?? (isProduction ? null : 'mdb_test_DEVELOPMENTKEYDONOTUSEINPRODUCTION');

/** True when Clerk is fully configured; the dashboard falls back to local auth otherwise. */
export const clerkEnabled = Boolean(env.CLERK_SECRET_KEY && env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
