/**
 * Structured logging with zero dependencies.
 *
 * Emits newline-delimited JSON so output is directly ingestible by Vercel Log
 * Drains, Datadog, or `jq`. Sensitive keys are redacted at serialisation time
 * rather than at each call site, so a careless `logger.info({ apiKey })` can't
 * leak a secret.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/** Keys whose values are replaced with `[redacted]` anywhere in a log payload. */
const REDACTED_KEYS = new Set([
  'apikey',
  'api_key',
  'authorization',
  'password',
  'secret',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'clerksecretkey',
  'clerk_secret_key',
  'databaseurl',
  'database_url',
  'openrouterapikey',
  'openrouter_api_key',
  'cookie',
  'setcookie',
  'set_cookie',
  'keyhash',
  'key_hash',
  'encryptionkey',
  'encryption_key',
]);

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Derive a logger that stamps every record with additional fields. */
  child(fields: LogFields): Logger;
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[max-depth]';
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) {
    // Long numeric arrays are almost always embeddings; summarise instead of dumping.
    if (value.length > 32 && value.every((v) => typeof v === 'number')) {
      return `[vector(${value.length})]`;
    }
    return value.slice(0, 100).map((v) => redact(v, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACTED_KEYS.has(key.toLowerCase()) ? '[redacted]' : redact(val, depth + 1);
  }
  return out;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Static fields merged into every record (service name, region, version…). */
  base?: LogFields;
  /** Sink override — defaults to console. Useful for tests and custom transports. */
  write?: (level: LogLevel, record: Record<string, unknown>) => void;
  /** Human-readable single-line output instead of JSON. Handy in local dev. */
  pretty?: boolean;
}

const CONSOLE_METHOD: Record<Exclude<LogLevel, 'silent'>, 'debug' | 'info' | 'warn' | 'error'> = {
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
};

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const base = options.base ?? {};
  const threshold = LEVEL_RANK[level];

  const emit = (lvl: Exclude<LogLevel, 'silent'>, msg: string, fields?: LogFields): void => {
    if (LEVEL_RANK[lvl] < threshold) return;
    const record: Record<string, unknown> = {
      level: lvl,
      time: new Date().toISOString(),
      msg,
      ...(redact(base) as LogFields),
      ...(fields ? (redact(fields) as LogFields) : {}),
    };
    if (options.write) {
      options.write(lvl, record);
      return;
    }
    if (options.pretty) {
      const { level: _l, time, msg: m, ...rest } = record;
      const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
      // eslint-disable-next-line no-console
      console[CONSOLE_METHOD[lvl]](`${String(time)} ${lvl.toUpperCase()} ${String(m)}${extra}`);
      return;
    }
    // eslint-disable-next-line no-console
    console[CONSOLE_METHOD[lvl]](JSON.stringify(record));
  };

  const logger: Logger = {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
  };
  return logger;
}

/** A logger that discards everything. Default inside the engine so libraries stay quiet. */
export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};
