/**
 * Dense-vector primitives.
 *
 * All engine vectors are L2-normalised at creation time, which makes cosine
 * similarity equal to the dot product — the single hottest operation in the
 * search path. `cosineSimilarity` therefore avoids recomputing norms and runs
 * as a plain fused multiply-add loop.
 */

export type Vector = number[] | Float32Array;

export function dot(a: Vector, b: Vector): number {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  // Manual 4-way unroll: measurably faster than a naive loop on V8 for the
  // 256-1536 dimension range we operate in.
  const limit = len - (len % 4);
  let i = 0;
  for (; i < limit; i += 4) {
    sum +=
      (a[i] as number) * (b[i] as number) +
      (a[i + 1] as number) * (b[i + 1] as number) +
      (a[i + 2] as number) * (b[i + 2] as number) +
      (a[i + 3] as number) * (b[i + 3] as number);
  }
  for (; i < len; i++) sum += (a[i] as number) * (b[i] as number);
  return sum;
}

export function magnitude(v: Vector): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    const value = v[i] as number;
    sum += value * value;
  }
  return Math.sqrt(sum);
}

/** Cosine similarity in [-1, 1]. Returns 0 when either vector is degenerate. */
export function cosineSimilarity(a: Vector, b: Vector): number {
  const magA = magnitude(a);
  const magB = magnitude(b);
  if (magA === 0 || magB === 0) return 0;
  return dot(a, b) / (magA * magB);
}

/**
 * Cosine similarity for vectors already known to be unit length.
 * Skips both square roots — use this on the hot path.
 */
export function cosineSimilarityNormalized(a: Vector, b: Vector): number {
  return dot(a, b);
}

/** Return an L2-normalised copy. A zero vector is returned unchanged. */
export function normalize(v: number[]): number[] {
  const mag = magnitude(v);
  if (mag === 0) return v.slice();
  const out = new Array<number>(v.length);
  for (let i = 0; i < v.length; i++) out[i] = (v[i] as number) / mag;
  return out;
}

/** In-place L2 normalisation, avoiding an allocation in tight loops. */
export function normalizeInPlace(v: number[]): number[] {
  const mag = magnitude(v);
  if (mag === 0) return v;
  for (let i = 0; i < v.length; i++) v[i] = (v[i] as number) / mag;
  return v;
}

export function euclideanDistance(a: Vector, b: Vector): number {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i++) {
    const diff = (a[i] as number) - (b[i] as number);
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

/** Element-wise mean. Used to build cluster centroids during consolidation. */
export function centroid(vectors: number[][]): number[] {
  const first = vectors[0];
  if (!first) return [];
  const dims = first.length;
  const out = new Array<number>(dims).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < dims; i++) out[i] = (out[i] as number) + (vector[i] ?? 0);
  }
  for (let i = 0; i < dims; i++) out[i] = (out[i] as number) / vectors.length;
  return normalizeInPlace(out);
}

/**
 * Map a similarity in [-1, 1] onto [0, 1].
 *
 * Scores are surfaced to users and compared against `minScore` thresholds, so a
 * negative cosine must not silently read as "slightly relevant".
 */
export function similarityToScore(similarity: number): number {
  return Math.max(0, Math.min(1, (similarity + 1) / 2));
}

/**
 * Top-k selection via a bounded min-heap.
 *
 * O(n log k) instead of the O(n log n) of a full sort — the difference matters
 * when scanning hundreds of thousands of candidate vectors for k=10.
 */
export function topK<T>(items: T[], k: number, scoreOf: (item: T) => number): T[] {
  if (k >= items.length) {
    return items.slice().sort((a, b) => scoreOf(b) - scoreOf(a));
  }
  const heap: Array<{ item: T; score: number }> = [];

  const siftUp = (start: number): void => {
    let index = start;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      const node = heap[index];
      const parentNode = heap[parent];
      if (!node || !parentNode || parentNode.score <= node.score) break;
      heap[index] = parentNode;
      heap[parent] = node;
      index = parent;
    }
  };

  const siftDown = (start: number): void => {
    let index = start;
    const length = heap.length;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      const smallestNode = heap[smallest];
      const leftNode = heap[left];
      const rightNode = heap[right];
      if (left < length && leftNode && smallestNode && leftNode.score < smallestNode.score) {
        smallest = left;
      }
      const newSmallest = heap[smallest];
      if (right < length && rightNode && newSmallest && rightNode.score < newSmallest.score) {
        smallest = right;
      }
      if (smallest === index) break;
      const a = heap[index];
      const b = heap[smallest];
      if (!a || !b) break;
      heap[index] = b;
      heap[smallest] = a;
      index = smallest;
    }
  };

  for (const item of items) {
    const score = scoreOf(item);
    if (heap.length < k) {
      heap.push({ item, score });
      siftUp(heap.length - 1);
    } else {
      const root = heap[0];
      if (root && score > root.score) {
        heap[0] = { item, score };
        siftDown(0);
      }
    }
  }

  return heap.sort((a, b) => b.score - a.score).map((entry) => entry.item);
}

/** Serialise to the pgvector text literal format: `[0.1,0.2,0.3]`. */
export function toPgVector(v: number[]): string {
  return `[${v.join(',')}]`;
}

/** Parse a pgvector text literal back into a JS array. */
export function fromPgVector(value: string | number[] | null): number[] | null {
  if (value === null) return null;
  if (Array.isArray(value)) return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  const inner = trimmed.slice(1, -1);
  if (!inner) return [];
  return inner.split(',').map((part) => Number.parseFloat(part));
}
