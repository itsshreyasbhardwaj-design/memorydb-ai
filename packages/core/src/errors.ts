/**
 * Typed error hierarchy. Every error carries a stable machine-readable `code`
 * and an HTTP `status`, so API routes can serialise any thrown engine error
 * without a translation layer.
 */

export type ErrorCode =
  | 'validation_error'
  | 'not_found'
  | 'conflict'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'payload_too_large'
  | 'storage_error'
  | 'embedding_error'
  | 'provider_error'
  | 'not_supported'
  | 'timeout'
  | 'internal_error';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  validation_error: 400,
  not_found: 404,
  conflict: 409,
  unauthorized: 401,
  forbidden: 403,
  rate_limited: 429,
  payload_too_large: 413,
  storage_error: 500,
  embedding_error: 502,
  provider_error: 502,
  not_supported: 501,
  timeout: 504,
  internal_error: 500,
};

export interface MemoryDBErrorOptions {
  details?: unknown;
  cause?: unknown;
  /** Hint to clients that retrying the same request may succeed. */
  retryable?: boolean;
}

export class MemoryDBError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options: MemoryDBErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'MemoryDBError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = options.details;
    this.retryable = options.retryable ?? (code === 'timeout' || code === 'rate_limited');
    Error.captureStackTrace?.(this, MemoryDBError);
  }

  toJSON(): { error: { code: ErrorCode; message: string; details?: unknown; retryable: boolean } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
        retryable: this.retryable,
      },
    };
  }
}

export class ValidationError extends MemoryDBError {
  constructor(message: string, details?: unknown) {
    super('validation_error', message, { details });
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends MemoryDBError {
  constructor(resource: string, id: string) {
    super('not_found', `${resource} '${id}' was not found`, { details: { resource, id } });
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends MemoryDBError {
  constructor(message: string, details?: unknown) {
    super('conflict', message, { details });
    this.name = 'ConflictError';
  }
}

export class UnauthorizedError extends MemoryDBError {
  constructor(message = 'Authentication required') {
    super('unauthorized', message);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends MemoryDBError {
  constructor(message = 'Insufficient permissions for this operation') {
    super('forbidden', message);
    this.name = 'ForbiddenError';
  }
}

export class RateLimitError extends MemoryDBError {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number, message = 'Rate limit exceeded') {
    super('rate_limited', message, { details: { retryAfterSeconds }, retryable: true });
    this.name = 'RateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class StorageError extends MemoryDBError {
  constructor(message: string, cause?: unknown) {
    super('storage_error', message, { cause });
    this.name = 'StorageError';
  }
}

export class EmbeddingError extends MemoryDBError {
  constructor(message: string, cause?: unknown) {
    super('embedding_error', message, { cause, retryable: true });
    this.name = 'EmbeddingError';
  }
}

export class NotSupportedError extends MemoryDBError {
  constructor(feature: string) {
    super('not_supported', `${feature} is not supported by this adapter`, { details: { feature } });
    this.name = 'NotSupportedError';
  }
}

/** Narrow an unknown catch binding into a MemoryDBError without losing context. */
export function toMemoryDBError(err: unknown): MemoryDBError {
  if (err instanceof MemoryDBError) return err;
  if (err instanceof Error) {
    return new MemoryDBError('internal_error', err.message, { cause: err });
  }
  return new MemoryDBError('internal_error', String(err));
}

export function isMemoryDBError(err: unknown): err is MemoryDBError {
  return err instanceof MemoryDBError;
}
