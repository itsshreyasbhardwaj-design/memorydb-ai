/**
 * Retention strategy per memory type.
 *
 * Human memory doesn't keep everything forever, and neither should an agent.
 * Each cognitive type gets a distinct lifecycle: what its default TTL is,
 * whether it should be summarised before archival, and how aggressively it
 * decays. Callers can override any of it per namespace or per write.
 */
import type { MemoryType } from './types.js';

export type RetentionAction = 'expire' | 'archive' | 'summarize' | 'keep';

export interface RetentionPolicy {
  /** Lifetime in seconds. `null` means "never expires". */
  ttlSeconds: number | null;
  /** What happens when the TTL elapses. */
  onExpiry: RetentionAction;
  /**
   * Memories untouched for this long become archival candidates, even if their
   * TTL hasn't elapsed. `null` disables staleness-based archival.
   */
  staleAfterSeconds: number | null;
  /** Consolidation may merge near-duplicates of this type. */
  consolidate: boolean;
  /** Summarise before archiving rather than discarding the content. */
  summarizeBeforeArchive: boolean;
  /**
   * Per-access importance boost. Frequently recalled memories earn their place;
   * this is a cheap approximation of the testing effect in human memory.
   */
  importanceBoostPerAccess: number;
  /** Importance is never decayed below this floor. */
  minImportance: number;
}

const HOUR = 3600;
const DAY = 86_400;
const MONTH = 30 * DAY;

/**
 * Defaults chosen so that an agent left running indefinitely converges on a
 * compact, high-signal store rather than growing without bound.
 */
export const DEFAULT_RETENTION_POLICIES: Record<MemoryType, RetentionPolicy> = {
  /** Scratch space for the current turn — gone within the hour. */
  short_term: {
    ttlSeconds: HOUR,
    onExpiry: 'expire',
    staleAfterSeconds: null,
    consolidate: false,
    summarizeBeforeArchive: false,
    importanceBoostPerAccess: 0,
    minImportance: 0,
  },

  /** Task context for an in-flight run. Survives a long session, not a week. */
  working: {
    ttlSeconds: DAY,
    onExpiry: 'summarize',
    staleAfterSeconds: 6 * HOUR,
    consolidate: true,
    summarizeBeforeArchive: true,
    importanceBoostPerAccess: 0.01,
    minImportance: 0.1,
  },

  /** The durable tier. Never expires; consolidation keeps it tidy. */
  long_term: {
    ttlSeconds: null,
    onExpiry: 'keep',
    staleAfterSeconds: 6 * MONTH,
    consolidate: true,
    summarizeBeforeArchive: true,
    importanceBoostPerAccess: 0.02,
    minImportance: 0.2,
  },

  /** Facts and preferences. Permanent, and aggressively deduplicated. */
  semantic: {
    ttlSeconds: null,
    onExpiry: 'keep',
    staleAfterSeconds: null,
    consolidate: true,
    summarizeBeforeArchive: false,
    importanceBoostPerAccess: 0.02,
    minImportance: 0.3,
  },

  /**
   * Time-anchored events. Individually they age out, but they are summarised
   * into a narrative first — mirroring how episodic detail fades into gist.
   */
  episodic: {
    ttlSeconds: 90 * DAY,
    onExpiry: 'summarize',
    staleAfterSeconds: MONTH,
    consolidate: true,
    summarizeBeforeArchive: true,
    importanceBoostPerAccess: 0.015,
    minImportance: 0.15,
  },

  /** Learned procedures. Permanent, and never merged — a mangled how-to is worse than none. */
  procedural: {
    ttlSeconds: null,
    onExpiry: 'keep',
    staleAfterSeconds: null,
    consolidate: false,
    summarizeBeforeArchive: false,
    importanceBoostPerAccess: 0.03,
    minImportance: 0.4,
  },

  /** Graph-backing memory. Permanent; the graph itself handles deduplication. */
  graph: {
    ttlSeconds: null,
    onExpiry: 'keep',
    staleAfterSeconds: null,
    consolidate: false,
    summarizeBeforeArchive: false,
    importanceBoostPerAccess: 0.01,
    minImportance: 0.25,
  },
};

export type RetentionOverrides = Partial<Record<MemoryType, Partial<RetentionPolicy>>>;

export function resolveRetentionPolicies(overrides?: RetentionOverrides): Record<MemoryType, RetentionPolicy> {
  if (!overrides) return DEFAULT_RETENTION_POLICIES;
  const resolved = {} as Record<MemoryType, RetentionPolicy>;
  for (const [type, policy] of Object.entries(DEFAULT_RETENTION_POLICIES) as Array<
    [MemoryType, RetentionPolicy]
  >) {
    resolved[type] = { ...policy, ...overrides[type] };
  }
  return resolved;
}

/**
 * Compute the concrete expiry timestamp for a new memory.
 *
 * Precedence: explicit `expiresAt` > explicit `ttlSeconds` > policy default.
 */
export function computeExpiry(
  type: MemoryType,
  policies: Record<MemoryType, RetentionPolicy>,
  options: { ttlSeconds?: number | null; expiresAt?: string | null; now?: Date } = {},
): string | null {
  if (options.expiresAt) return options.expiresAt;
  const now = options.now ?? new Date();

  if (options.ttlSeconds !== undefined && options.ttlSeconds !== null) {
    return new Date(now.getTime() + options.ttlSeconds * 1000).toISOString();
  }

  const policy = policies[type];
  if (!policy.ttlSeconds) return null;
  return new Date(now.getTime() + policy.ttlSeconds * 1000).toISOString();
}

/** Importance after a recall, clamped to the policy floor and 1. */
export function boostImportance(
  current: number,
  type: MemoryType,
  policies: Record<MemoryType, RetentionPolicy>,
): number {
  const policy = policies[type];
  return Math.max(policy.minImportance, Math.min(1, current + policy.importanceBoostPerAccess));
}

/** True when a memory has gone untouched past its policy's staleness horizon. */
export function isStale(
  lastTouchedAt: string,
  type: MemoryType,
  policies: Record<MemoryType, RetentionPolicy>,
  now: number = Date.now(),
): boolean {
  const policy = policies[type];
  if (policy.staleAfterSeconds === null) return false;
  const touched = Date.parse(lastTouchedAt);
  if (Number.isNaN(touched)) return false;
  return now - touched > policy.staleAfterSeconds * 1000;
}
