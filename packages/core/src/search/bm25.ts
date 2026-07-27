/**
 * BM25 Okapi lexical index.
 *
 * BM25 is the ranking function behind Lucene, Elasticsearch, and Postgres
 * `ts_rank_cd`. It improves on raw TF-IDF in two ways that matter for memory
 * retrieval:
 *
 *  1. **Term-frequency saturation** (`k1`) — the tenth occurrence of a word adds
 *     far less than the second, so a memory that merely repeats a keyword can't
 *     out-rank one that genuinely covers the topic.
 *  2. **Length normalisation** (`b`) — long documents don't win purely by
 *     containing more words, which matters when a corpus mixes one-line
 *     preferences with multi-page documents.
 *
 * The index is incremental: adding or removing a document updates the posting
 * lists and running statistics in place, with no full rebuild.
 */
import { analyze } from '../util/text.js';

export interface BM25Options {
  /** Term-frequency saturation. 1.2-2.0 is the standard range. */
  k1?: number;
  /** Length-normalisation strength, 0 (off) to 1 (full). */
  b?: number;
  /**
   * Field boosts. A term matched in a title should count for more than the
   * same term buried in the body.
   */
  fieldWeights?: { content?: number; title?: number; summary?: number; tags?: number };
}

interface Posting {
  docId: string;
  /** Weighted term frequency, after field boosts are applied. */
  tf: number;
}

interface DocumentInfo {
  /** Weighted length, used for the length-normalisation term. */
  length: number;
  terms: Set<string>;
}

export interface BM25Document {
  id: string;
  content: string;
  title?: string | null;
  summary?: string | null;
  tags?: string[];
}

const DEFAULT_FIELD_WEIGHTS = { content: 1.0, title: 2.5, summary: 1.5, tags: 2.0 } as const;

export class BM25Index {
  private readonly k1: number;
  private readonly b: number;
  private readonly fieldWeights: Required<NonNullable<BM25Options['fieldWeights']>>;

  /** term -> postings. The core inverted index. */
  private readonly postings = new Map<string, Posting[]>();
  private readonly documents = new Map<string, DocumentInfo>();
  private totalLength = 0;

  constructor(options: BM25Options = {}) {
    this.k1 = options.k1 ?? 1.2;
    this.b = options.b ?? 0.75;
    this.fieldWeights = { ...DEFAULT_FIELD_WEIGHTS, ...options.fieldWeights };
  }

  get size(): number {
    return this.documents.size;
  }

  private get averageLength(): number {
    return this.documents.size === 0 ? 0 : this.totalLength / this.documents.size;
  }

  add(doc: BM25Document): void {
    // Re-adding an existing id is an update; drop the old postings first.
    if (this.documents.has(doc.id)) this.remove(doc.id);

    const termFrequencies = new Map<string, number>();
    let length = 0;

    const ingest = (text: string | null | undefined, weight: number): void => {
      if (!text) return;
      const tokens = analyze(text);
      for (const token of tokens) {
        termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + weight);
        length += weight;
      }
    };

    ingest(doc.content, this.fieldWeights.content);
    ingest(doc.title, this.fieldWeights.title);
    ingest(doc.summary, this.fieldWeights.summary);
    if (doc.tags?.length) ingest(doc.tags.join(' '), this.fieldWeights.tags);

    if (termFrequencies.size === 0) return;

    for (const [term, tf] of termFrequencies) {
      let list = this.postings.get(term);
      if (!list) {
        list = [];
        this.postings.set(term, list);
      }
      list.push({ docId: doc.id, tf });
    }

    this.documents.set(doc.id, { length, terms: new Set(termFrequencies.keys()) });
    this.totalLength += length;
  }

  remove(docId: string): boolean {
    const info = this.documents.get(docId);
    if (!info) return false;

    for (const term of info.terms) {
      const list = this.postings.get(term);
      if (!list) continue;
      const filtered = list.filter((posting) => posting.docId !== docId);
      if (filtered.length === 0) this.postings.delete(term);
      else this.postings.set(term, filtered);
    }

    this.totalLength -= info.length;
    this.documents.delete(docId);
    return true;
  }

  has(docId: string): boolean {
    return this.documents.has(docId);
  }

  clear(): void {
    this.postings.clear();
    this.documents.clear();
    this.totalLength = 0;
  }

  /**
   * Score every document containing at least one query term.
   *
   * Only documents in the posting lists are touched, so cost scales with
   * matching documents rather than corpus size.
   */
  search(query: string, limit = 50, allowed?: Set<string>): Array<{ id: string; score: number }> {
    const queryTerms = analyze(query);
    if (queryTerms.length === 0 || this.documents.size === 0) return [];

    const avgdl = this.averageLength;
    const totalDocs = this.documents.size;
    const scores = new Map<string, number>();

    // Deduplicate query terms but keep their multiplicity as a weight.
    const uniqueTerms = new Map<string, number>();
    for (const term of queryTerms) uniqueTerms.set(term, (uniqueTerms.get(term) ?? 0) + 1);

    for (const [term, queryTf] of uniqueTerms) {
      const list = this.postings.get(term);
      if (!list || list.length === 0) continue;

      // Robertson-Sparck Jones IDF with the +1 smoothing that keeps it positive
      // even for terms appearing in more than half the corpus.
      const df = list.length;
      const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));

      for (const posting of list) {
        if (allowed && !allowed.has(posting.docId)) continue;
        const info = this.documents.get(posting.docId);
        if (!info) continue;

        const normalizedLength = avgdl === 0 ? 1 : info.length / avgdl;
        const denominator = posting.tf + this.k1 * (1 - this.b + this.b * normalizedLength);
        const termScore = idf * ((posting.tf * (this.k1 + 1)) / (denominator || 1));
        scores.set(posting.docId, (scores.get(posting.docId) ?? 0) + termScore * queryTf);
      }
    }

    return Array.from(scores, ([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Highest attainable score for a query, used to map raw BM25 output into
   * [0,1]. Assumes a hypothetical document of average length matching every
   * term once, which is a stable ceiling across corpus sizes.
   */
  maxPossibleScore(query: string): number {
    const uniqueTerms = new Set(analyze(query));
    if (uniqueTerms.size === 0) return 1;
    const totalDocs = Math.max(1, this.documents.size);
    let max = 0;
    for (const term of uniqueTerms) {
      const df = this.postings.get(term)?.length ?? 1;
      const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
      // tf is unbounded in principle; a weighted tf of 3 is a realistic strong match.
      const tf = 3 * this.fieldWeights.content;
      max += idf * ((tf * (this.k1 + 1)) / (tf + this.k1));
    }
    return max || 1;
  }

  stats(): { documents: number; terms: number; averageLength: number } {
    return {
      documents: this.documents.size,
      terms: this.postings.size,
      averageLength: this.averageLength,
    };
  }
}
