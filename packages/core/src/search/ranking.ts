/**
 * Final-stage re-ranking.
 *
 * Fusion answers "which memories match the query?". Ranking answers the harder
 * question: "which memories should this agent actually see?". Relevance alone
 * is a poor proxy — a precisely matching but stale, low-confidence, never-used
 * memory is usually worse than a slightly less on-topic fact written yesterday
 * and read a hundred times since.
 *
 * Signals combined here:
 *  - **relevance** (fused vector + lexical) — the dominant term
 *  - **recency** — exponential decay with a configurable half-life
 *  - **importance** — caller-assigned or consolidation-derived priority
 *  - **confidence** — how much we trust the content
 *  - **usage** — log-scaled access count, a weak popularity prior
 *  - **type prior** — semantic/long-term facts outrank short-term scratch
 */
import type { Memory, MemoryType, ScoreBreakdown } from '../types.js';
import { cosineSimilarity } from '../util/vector.js';

/**
 * Retrieval priors per memory type. Short-term and working memory are
 * intentionally down-weighted: they exist to serve the current turn, and
 * surfacing them in a general recall dilutes durable knowledge.
 */
export const TYPE_PRIORS: Record<MemoryType, number> = {
  short_term: 0.75,
  working: 0.85,
  long_term: 1.0,
  semantic: 1.0,
  episodic: 0.95,
  procedural: 1.0,
  graph: 0.9,
};

export interface RankingWeights {
  recencyHalfLifeDays: number;
  importanceWeight: number;
  confidenceWeight?: number;
  usageWeight?: number;
  applyTypePrior?: boolean;
}

/**
 * Exponential decay: a memory `halfLifeDays` old scores 0.5, twice that 0.25.
 * A half-life of 0 disables decay entirely (returns 1).
 */
export function recencyScore(createdAt: string, halfLifeDays: number, now: number = Date.now()): number {
  if (halfLifeDays <= 0) return 1;
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return 0.5;
  const ageDays = Math.max(0, (now - created) / 86_400_000);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/**
 * Log-scaled usage prior in [0,1]. Saturates around 1000 accesses so a single
 * hot memory can't permanently crowd out everything else.
 */
export function usageScore(accessCount: number): number {
  if (accessCount <= 0) return 0;
  return Math.min(1, Math.log10(accessCount + 1) / 3);
}

export interface RankedItem {
  memory: Memory;
  score: number;
  breakdown: ScoreBreakdown;
}

/**
 * Blend relevance with the contextual priors.
 *
 * The priors apply *multiplicatively* within a bounded band rather than
 * additively. This matters: with an additive blend, a brand-new high-importance
 * memory accumulates a respectable score from recency and importance alone even
 * when it matches the query not at all — which makes an absolute `minScore`
 * threshold meaningless. Multiplying keeps relevance as a hard ceiling, so
 * irrelevant memories stay near zero no matter how fresh or important they are,
 * while the priors still reorder genuinely comparable matches.
 */
export function rankMemories(
  candidates: Array<{ memory: Memory; relevance: number; vector: number; keyword: number }>,
  weights: RankingWeights,
  now: number = Date.now(),
): RankedItem[] {
  const {
    recencyHalfLifeDays,
    importanceWeight,
    confidenceWeight = 0.1,
    usageWeight = 0.05,
    applyTypePrior = true,
  } = weights;

  const ranked = candidates.map(({ memory, relevance, vector, keyword }) => {
    const recency = recencyScore(memory.createdAt, recencyHalfLifeDays, now);
    const importance = memory.importance;
    const confidence = memory.confidence;
    const usage = usageScore(memory.accessCount);

    // Weighted average of the priors, normalised to [0,1].
    const recencyWeight = recencyHalfLifeDays > 0 ? 0.2 : 0;
    const totalPriorWeight = importanceWeight + confidenceWeight + usageWeight + recencyWeight;

    const priorScore =
      totalPriorWeight === 0
        ? 1
        : (importance * importanceWeight +
            confidence * confidenceWeight +
            usage * usageWeight +
            recency * recencyWeight) /
          totalPriorWeight;

    // `priorInfluence` bounds how far the priors may move a result: a memory
    // with perfect priors scores its full relevance, one with none keeps 60% of
    // it. Relevance therefore always dominates, and zero relevance stays zero.
    const priorInfluence = Math.min(0.4, totalPriorWeight);
    let score = relevance * (1 - priorInfluence + priorInfluence * priorScore);

    if (applyTypePrior) score *= TYPE_PRIORS[memory.type];

    const breakdown: ScoreBreakdown = {
      vector,
      keyword,
      fusion: relevance,
      recency,
      importance,
      confidence,
      final: Math.max(0, Math.min(1, score)),
    };

    return { memory, score: breakdown.final, breakdown };
  });

  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

/**
 * Greedy redundancy filter in the spirit of Maximal Marginal Relevance.
 *
 * Ten near-identical memories waste a context window. Each candidate is
 * admitted only if it is sufficiently dissimilar from everything already
 * selected. Falls back to a lexical Jaccard estimate when embeddings are absent,
 * so the filter still works before the embedding backfill runs.
 */
export function diversify<T extends { memory: Memory }>(
  items: T[],
  threshold: number,
  limit: number,
): { kept: T[]; dropped: number } {
  if (items.length === 0) return { kept: [], dropped: 0 };

  const kept: T[] = [];
  let dropped = 0;

  for (const item of items) {
    if (kept.length >= limit) {
      dropped += 1;
      continue;
    }

    const isRedundant = kept.some((existing) => similarity(existing.memory, item.memory) >= threshold);
    if (isRedundant) dropped += 1;
    else kept.push(item);
  }

  return { kept, dropped };
}

function similarity(a: Memory, b: Memory): number {
  if (a.contentHash === b.contentHash) return 1;
  if (a.embedding && b.embedding && a.embedding.length === b.embedding.length) {
    return cosineSimilarity(a.embedding, b.embedding);
  }
  return jaccard(a.content, b.content);
}

/** Token-set Jaccard: cheap, embedding-free redundancy estimate. */
function jaccard(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const setB = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}
