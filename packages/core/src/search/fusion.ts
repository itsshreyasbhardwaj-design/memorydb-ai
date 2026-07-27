/**
 * Result fusion for hybrid retrieval.
 *
 * Combining a dense vector leg with a lexical BM25 leg is not as simple as
 * adding their scores: cosine similarity lives in [-1,1] while BM25 is an
 * unbounded, corpus-dependent quantity. Two strategies are provided.
 *
 * **Reciprocal Rank Fusion (RRF)** ignores scores entirely and fuses on rank
 * position. It is scale-free, needs no tuning, and is remarkably hard to beat —
 * Cormack et al. (2009) showed it outperforms tuned score-based combinations
 * across TREC collections. This is the default.
 *
 * **Weighted score fusion** min-max normalises each leg into [0,1] and blends.
 * It preserves score *margins* (the gap between a great and a mediocre hit),
 * which RRF discards. Better when an absolute `minScore` threshold matters.
 *
 * The engine runs both and blends them, taking RRF's robustness plus enough
 * score-margin signal for thresholding to behave sensibly.
 */
import type { ScoredId } from '../storage/types.js';

export interface FusionLeg {
  name: 'vector' | 'keyword';
  results: ScoredId[];
  weight: number;
}

export interface FusedResult {
  id: string;
  /** Blended relevance in [0,1]. */
  score: number;
  rrfScore: number;
  normalizedScore: number;
  /** Per-leg raw scores; absent keys mean the leg did not return this document. */
  legScores: Partial<Record<'vector' | 'keyword', number>>;
  /** Per-leg 1-based rank. */
  legRanks: Partial<Record<'vector' | 'keyword', number>>;
}

/**
 * RRF smoothing constant. 60 is the value from the original paper and the
 * default in Elasticsearch and Weaviate. It controls how quickly rank
 * contribution decays: larger k flattens the curve and weights deep results more.
 */
export const RRF_K = 60;

/** Min-max normalise a leg's scores into [0,1]. Constant legs collapse to 1. */
function minMaxNormalize(results: ScoredId[]): Map<string, number> {
  const out = new Map<string, number>();
  if (results.length === 0) return out;

  let min = Infinity;
  let max = -Infinity;
  for (const result of results) {
    if (result.score < min) min = result.score;
    if (result.score > max) max = result.score;
  }

  const range = max - min;
  for (const result of results) {
    // A single result, or an all-equal leg, is maximally relevant by definition.
    out.set(result.id, range === 0 ? 1 : (result.score - min) / range);
  }
  return out;
}

export interface FuseOptions {
  /** Blend between RRF (0) and normalised score fusion (1). */
  scoreBlend?: number;
  rrfK?: number;
  limit?: number;
}

export function fuse(legs: FusionLeg[], options: FuseOptions = {}): FusedResult[] {
  const rrfK = options.rrfK ?? RRF_K;
  const scoreBlend = options.scoreBlend ?? 0.35;
  const active = legs.filter((leg) => leg.weight > 0 && leg.results.length > 0);
  if (active.length === 0) return [];

  const totalWeight = active.reduce((sum, leg) => sum + leg.weight, 0) || 1;
  const accumulator = new Map<string, FusedResult>();
  const normalizedByLeg = new Map<string, Map<string, number>>();

  for (const leg of active) normalizedByLeg.set(leg.name, minMaxNormalize(leg.results));

  for (const leg of active) {
    const normalizedWeight = leg.weight / totalWeight;
    const normalized = normalizedByLeg.get(leg.name);

    leg.results.forEach((result, index) => {
      const rank = index + 1;
      let entry = accumulator.get(result.id);
      if (!entry) {
        entry = { id: result.id, score: 0, rrfScore: 0, normalizedScore: 0, legScores: {}, legRanks: {} };
        accumulator.set(result.id, entry);
      }
      entry.rrfScore += normalizedWeight * (1 / (rrfK + rank));
      entry.normalizedScore += normalizedWeight * (normalized?.get(result.id) ?? 0);
      entry.legScores[leg.name] = result.score;
      entry.legRanks[leg.name] = rank;
    });
  }

  // The theoretical RRF maximum is achieved by ranking first in every leg.
  const maxRrf = 1 / (rrfK + 1);

  const fused = Array.from(accumulator.values());
  for (const entry of fused) {
    const rrfNormalized = maxRrf === 0 ? 0 : entry.rrfScore / maxRrf;
    entry.score = (1 - scoreBlend) * rrfNormalized + scoreBlend * entry.normalizedScore;
  }

  fused.sort((a, b) => b.score - a.score);
  return options.limit ? fused.slice(0, options.limit) : fused;
}
