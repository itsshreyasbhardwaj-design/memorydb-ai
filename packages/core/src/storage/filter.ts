/**
 * In-process filter evaluation.
 *
 * This is the reference semantics for `MemoryFilter`. The Postgres adapter
 * compiles the same filter into SQL; both must agree, and the shared test suite
 * asserts that they do.
 */
import type { JsonValue, Memory, MemoryFilter, MetadataFilter } from '../types.js';

function toArray<T>(value: T | T[] | undefined): T[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

/** Deep structural equality for JSON values. */
function jsonEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => jsonEquals(item, b[index]));
  }
  const aKeys = Object.keys(a as object);
  const bKeys = Object.keys(b as object);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) =>
    jsonEquals((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/** Resolve a dotted path such as `source.channel` against a metadata object. */
export function getMetadataPath(metadata: Record<string, JsonValue>, path: string): JsonValue | undefined {
  if (!path.includes('.')) return metadata[path];
  let current: unknown = metadata;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
    if (current === undefined) return undefined;
  }
  return current as JsonValue;
}

export function matchesMetadataFilter(
  metadata: Record<string, JsonValue>,
  filter: MetadataFilter,
): boolean {
  for (const [path, condition] of Object.entries(filter)) {
    const value = getMetadataPath(metadata, path);

    // A bare value is shorthand for `{ eq: value }`.
    if (condition === null || typeof condition !== 'object' || Array.isArray(condition)) {
      if (!jsonEquals(value, condition)) return false;
      continue;
    }

    const ops = condition as Record<string, unknown>;

    if ('exists' in ops) {
      const shouldExist = ops.exists === true;
      if (shouldExist !== (value !== undefined)) return false;
      // `exists` alone is a complete condition.
      if (Object.keys(ops).length === 1) continue;
    }

    if ('eq' in ops && !jsonEquals(value, ops.eq)) return false;
    if ('ne' in ops && jsonEquals(value, ops.ne)) return false;

    if ('gt' in ops || 'gte' in ops || 'lt' in ops || 'lte' in ops) {
      if (typeof value !== 'number') return false;
      if (typeof ops.gt === 'number' && !(value > ops.gt)) return false;
      if (typeof ops.gte === 'number' && !(value >= ops.gte)) return false;
      if (typeof ops.lt === 'number' && !(value < ops.lt)) return false;
      if (typeof ops.lte === 'number' && !(value <= ops.lte)) return false;
    }

    if ('in' in ops) {
      const list = ops.in;
      if (!Array.isArray(list) || !list.some((candidate) => jsonEquals(value, candidate))) return false;
    }
    if ('nin' in ops) {
      const list = ops.nin;
      if (Array.isArray(list) && list.some((candidate) => jsonEquals(value, candidate))) return false;
    }
    if ('contains' in ops) {
      const needle = ops.contains;
      if (typeof needle !== 'string') return false;
      if (typeof value === 'string') {
        if (!value.toLowerCase().includes(needle.toLowerCase())) return false;
      } else if (Array.isArray(value)) {
        if (!value.some((item) => typeof item === 'string' && item.toLowerCase().includes(needle.toLowerCase()))) {
          return false;
        }
      } else {
        return false;
      }
    }
  }
  return true;
}

/**
 * Evaluate a full memory filter.
 *
 * Status defaults matter: unless the caller asks otherwise, deleted memories
 * are always hidden, archived ones are hidden, and expired ones are hidden even
 * if the sweeper hasn't removed them yet.
 */
export function matchesFilter(memory: Memory, filter?: MemoryFilter, now: number = Date.now()): boolean {
  if (!filter) return memory.status === 'active' && !isExpired(memory, now);

  const statuses = toArray(filter.status);
  if (statuses) {
    if (!statuses.includes(memory.status)) return false;
  } else {
    if (memory.status === 'deleted') return false;
    if (memory.status === 'archived' && !filter.includeArchived) return false;
    if (memory.status === 'superseded') return false;
  }

  if (!filter.includeExpired && isExpired(memory, now)) return false;

  const types = toArray(filter.type);
  if (types && !types.includes(memory.type)) return false;

  const kinds = toArray(filter.kind);
  if (kinds && !kinds.includes(memory.kind)) return false;

  if (filter.userId !== undefined && memory.userId !== filter.userId) return false;
  if (filter.agentId !== undefined && memory.agentId !== filter.agentId) return false;
  if (filter.sessionId !== undefined && memory.sessionId !== filter.sessionId) return false;
  if (filter.sourceId !== undefined && memory.sourceId !== filter.sourceId) return false;
  if (filter.ids && !filter.ids.includes(memory.id)) return false;

  if (filter.tags?.length) {
    const owned = new Set(memory.tags);
    if (!filter.tags.every((tag) => owned.has(tag))) return false;
  }
  if (filter.anyTags?.length) {
    const owned = new Set(memory.tags);
    if (!filter.anyTags.some((tag) => owned.has(tag))) return false;
  }

  if (filter.metadata && !matchesMetadataFilter(memory.metadata, filter.metadata)) return false;

  if (filter.createdAfter && memory.createdAt < filter.createdAfter) return false;
  if (filter.createdBefore && memory.createdAt > filter.createdBefore) return false;
  if (filter.updatedAfter && memory.updatedAt < filter.updatedAfter) return false;
  if (filter.updatedBefore && memory.updatedAt > filter.updatedBefore) return false;

  if (filter.minImportance !== undefined && memory.importance < filter.minImportance) return false;
  if (filter.minConfidence !== undefined && memory.confidence < filter.minConfidence) return false;

  return true;
}

export function isExpired(memory: Memory, now: number = Date.now()): boolean {
  if (!memory.expiresAt) return false;
  const expiry = Date.parse(memory.expiresAt);
  return !Number.isNaN(expiry) && expiry <= now;
}
