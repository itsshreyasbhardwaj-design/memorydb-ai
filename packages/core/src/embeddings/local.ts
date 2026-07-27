/**
 * Local embedding provider — zero cost, zero network, fully deterministic.
 *
 * ## How it works
 *
 * This is a *feature-hashing* (a.k.a. "hashing trick") embedder, the same
 * technique behind `HashingVectorizer` in scikit-learn and Vowpal Wabbit's
 * input layer. Text is decomposed into overlapping feature families, each
 * feature is hashed to a bucket in a fixed-width vector, and its weight is
 * accumulated with a hash-derived sign.
 *
 * Three feature families are mixed so the signal degrades gracefully:
 *  - **word unigrams** carry topical meaning
 *  - **word bigrams** capture short phrases and word order
 *  - **character trigrams** survive typos, inflection, and unseen vocabulary
 *
 * A signed hash (a second independent hash decides +1/-1) makes collisions
 * cancel out in expectation rather than compound, which is what keeps the
 * approximation unbiased.
 *
 * ## What it is and is not
 *
 * This yields a genuine, well-behaved vector space where cosine similarity
 * tracks *lexical and distributional* overlap. It is excellent for exact and
 * near-duplicate detection, clustering, and as the dense leg of hybrid search.
 *
 * It is **not** a neural embedding: it cannot match "car" to "automobile"
 * without shared substrings. When true synonymy matters, configure a remote
 * provider — the interface is identical and no other code changes.
 *
 * The trade is deliberate: MemoryDB is fully functional, testable, and
 * benchmarkable with no API key and no spend, and upgrades to neural
 * embeddings with a one-line config change.
 */
import type { EmbeddingProvider } from './types.js';
import { fnv1a32, murmur3 } from '../util/hash.js';
import { analyze, charNgrams, ngrams, tokenize } from '../util/text.js';
import { normalizeInPlace } from '../util/vector.js';

export interface LocalEmbeddingOptions {
  /** Vector width. 384 mirrors MiniLM and balances fidelity against storage. */
  dimensions?: number;
  /** Relative contribution of each feature family. */
  weights?: {
    unigram?: number;
    bigram?: number;
    charTrigram?: number;
  };
  /** Include character n-grams. Disable for a ~2x speedup on large corpora. */
  useCharNgrams?: boolean;
}

const DEFAULT_WEIGHTS = {
  unigram: 1.0,
  // Phrases are informative but sparse; over-weighting them hurts short queries.
  bigram: 0.55,
  // Sub-word signal is noisy in isolation, valuable as a tie-breaker.
  charTrigram: 0.35,
} as const;

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'local';
  readonly model: string;
  readonly dimensions: number;
  readonly maxBatchSize = 10_000;
  readonly remote = false;
  // Calibrated empirically: related short-query/document pairs land around
  // 0.3-0.4 with this feature-hashing scheme, unrelated pairs near 0.
  readonly fullConfidenceSimilarity = 0.35;

  private readonly weights: Required<NonNullable<LocalEmbeddingOptions['weights']>>;
  private readonly useCharNgrams: boolean;

  constructor(options: LocalEmbeddingOptions = {}) {
    this.dimensions = options.dimensions ?? 384;
    if (this.dimensions < 32 || this.dimensions > 8192) {
      throw new RangeError(`dimensions must be between 32 and 8192, received ${this.dimensions}`);
    }
    this.weights = { ...DEFAULT_WEIGHTS, ...options.weights };
    this.useCharNgrams = options.useCharNgrams ?? true;
    this.model = `local-hash-v1-${this.dimensions}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  /** Synchronous single-text path — handy in tests and tight loops. */
  embedOne(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    if (!text.trim()) return vector;

    // Sublinear term frequency (1 + log tf) prevents one repeated word from
    // dominating a long document, exactly as in classic TF-IDF weighting.
    const accumulate = (features: string[], familyWeight: number): void => {
      if (features.length === 0 || familyWeight === 0) return;
      const counts = new Map<string, number>();
      for (const feature of features) counts.set(feature, (counts.get(feature) ?? 0) + 1);

      for (const [feature, count] of counts) {
        const weight = familyWeight * (1 + Math.log(count));
        const bucket = murmur3(feature) % this.dimensions;
        // Independent second hash picks the sign so collisions cancel rather than stack.
        const sign = (fnv1a32(feature) & 1) === 0 ? 1 : -1;
        vector[bucket] = (vector[bucket] as number) + sign * weight;
      }
    };

    const analyzed = analyze(text);
    accumulate(analyzed, this.weights.unigram);
    accumulate(ngrams(analyzed, 2), this.weights.bigram);

    if (this.useCharNgrams) {
      // Built from raw tokens, not stemmed ones, so morphology stays visible.
      const raw = tokenize(text).join(' ');
      accumulate(charNgrams(raw, 3), this.weights.charTrigram);
    }

    return normalizeInPlace(vector);
  }
}

/**
 * Convenience factory. Exported so callers can spin up the default provider
 * without importing the class.
 */
export function createLocalEmbeddingProvider(options?: LocalEmbeddingOptions): EmbeddingProvider {
  return new LocalEmbeddingProvider(options);
}
