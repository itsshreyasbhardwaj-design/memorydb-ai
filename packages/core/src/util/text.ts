/**
 * Text processing: tokenisation, stopwords, stemming, token estimation, and
 * semantic chunking. Deliberately dependency-free and deterministic so results
 * are identical across Node, Edge, and browser runtimes.
 */

/** English stopwords. Kept small — aggressive removal hurts short-query recall. */
const STOPWORDS = new Set([
  'a','an','and','are','as','at','be','been','but','by','can','did','do','does','for','from','had',
  'has','have','he','her','him','his','how','i','if','in','is','it','its','me','my','of','on','or',
  'our','out','she','so','than','that','the','their','them','then','there','these','they','this',
  'those','to','up','was','we','were','what','when','where','which','who','why','will','with','you',
  'your','not','no','all','any','more','most','some','such','only','own','same','too','very','just',
]);

export function isStopword(token: string): boolean {
  return STOPWORDS.has(token);
}

/**
 * Split text into lowercase alphanumeric tokens. Keeps intra-word `.`, `_`, `-`
 * and `+` so identifiers like `user_id`, `Vector.search`, and `c++` survive as
 * single tokens — important when memories contain code.
 */
export function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z0-9]+(?:[._+-][a-z0-9]+)*/g);
  return matches ?? [];
}

/**
 * Light Porter-style suffix stripping.
 *
 * Full Porter over-stems technical vocabulary ("routing" -> "rout"), so this
 * implements only the high-value, low-risk steps — but it applies them in
 * sequence rather than returning at the first match. That matters: "deployments"
 * has to lose both the plural *and* the derivational suffix to reach "deploy",
 * and a query for "deploy" is otherwise a total miss against a document that
 * says "Deployments".
 *
 * Length guards are deliberately conservative. `-ment` only strips from words of
 * 9+ characters, so "deployment" and "requirement" reduce while "comment" and
 * "document" — where the suffix is not derivational — are left intact.
 */
export function stem(token: string): string {
  if (token.length <= 3) return token;
  let word = token;

  // Step 1 — plurals.
  if (word.endsWith('ies') && word.length > 4) {
    word = `${word.slice(0, -3)}y`;
  } else if (word.endsWith('sses')) {
    word = word.slice(0, -2);
  } else if (!word.endsWith('ss') && word.endsWith('s') && !word.endsWith('us') && !word.endsWith('is')) {
    word = word.slice(0, -1);
  }

  // Step 2 — verb inflections.
  if (word.endsWith('ing') && word.length > 5) {
    word = word.slice(0, -3);
  } else if (word.endsWith('ed') && word.length > 4) {
    word = word.slice(0, -2);
  }

  // Step 3 — derivational suffixes.
  if (word.endsWith('ment') && word.length > 8) {
    word = word.slice(0, -4);
  } else if (word.endsWith('ness') && word.length > 6) {
    word = word.slice(0, -4);
  } else if (word.endsWith('ly') && word.length > 5) {
    word = word.slice(0, -2);
  }

  return word;
}

export interface AnalyzeOptions {
  removeStopwords?: boolean;
  applyStemming?: boolean;
  minLength?: number;
}

/** Full analysis pipeline shared by the lexical index and the local embedder. */
export function analyze(text: string, options: AnalyzeOptions = {}): string[] {
  const { removeStopwords = true, applyStemming = true, minLength = 1 } = options;
  let tokens = tokenize(text);
  if (removeStopwords) tokens = tokens.filter((t) => !STOPWORDS.has(t));
  if (minLength > 1) tokens = tokens.filter((t) => t.length >= minLength);
  if (applyStemming) tokens = tokens.map(stem);
  return tokens;
}

/** Contiguous n-grams over an already-tokenised sequence. */
export function ngrams(tokens: string[], n: number): string[] {
  if (n <= 1) return tokens;
  const out: string[] = [];
  for (let i = 0; i + n <= tokens.length; i++) {
    out.push(tokens.slice(i, i + n).join('_'));
  }
  return out;
}

/** Character n-grams, which give the embedder robustness to typos and morphology. */
export function charNgrams(text: string, n = 3): string[] {
  const normalized = ` ${text.toLowerCase().replace(/\s+/g, ' ').trim()} `;
  const out: string[] = [];
  for (let i = 0; i + n <= normalized.length; i++) out.push(normalized.slice(i, i + n));
  return out;
}

/**
 * Approximate token count for context budgeting.
 *
 * Calibrated against the BPE vocabularies used by GPT/Claude-class models:
 * ~4 characters per token for prose, with a word-count floor so that
 * whitespace-heavy or CJK content isn't wildly underestimated. Exact counts
 * require the model's own tokenizer; this stays within ~10% for English prose
 * and errs high, which is the safe direction for a budget.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const chars = text.length;
  const words = text.trim().split(/\s+/).length;
  // CJK characters are roughly one token each and defeat the 4-chars heuristic.
  const cjk = (text.match(/[一-鿿぀-ヿ가-힯]/g) ?? []).length;
  const latinChars = chars - cjk;
  return Math.max(1, Math.ceil(latinChars / 4 + cjk + words * 0.05));
}

/** Collapse whitespace and strip C0/C1 control characters (tab and newline survive). */
export function normalizeWhitespace(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Truncate on a word boundary, appending an ellipsis when the text was cut. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > maxChars * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

/* -------------------------------------------------------------------------- */
/*                                  Chunking                                   */
/* -------------------------------------------------------------------------- */

export interface ChunkOptions {
  /** Target chunk size in estimated tokens. */
  maxTokens?: number;
  /** Tokens of overlap carried between adjacent chunks to preserve context. */
  overlapTokens?: number;
  /** Chunks smaller than this get merged into their neighbour. */
  minTokens?: number;
}

export interface TextChunk {
  content: string;
  index: number;
  tokens: number;
  /** Character offsets into the original text, for citation spans. */
  start: number;
  end: number;
}

/**
 * Split long text into overlapping chunks, preferring natural boundaries.
 *
 * Boundary preference runs paragraph -> sentence -> word, so a chunk is only
 * split mid-sentence when a single sentence exceeds the budget on its own.
 */
export function chunkText(text: string, options: ChunkOptions = {}): TextChunk[] {
  const maxTokens = options.maxTokens ?? 512;
  const overlapTokens = Math.min(options.overlapTokens ?? 64, Math.floor(maxTokens / 2));
  const minTokens = options.minTokens ?? 32;

  if (!text.trim()) return [];
  if (estimateTokens(text) <= maxTokens) {
    return [{ content: text, index: 0, tokens: estimateTokens(text), start: 0, end: text.length }];
  }

  // Segment into atomic units that we will never split further unless forced.
  const segments: Array<{ text: string; start: number }> = [];
  const paragraphRegex = /\n\s*\n/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = paragraphRegex.exec(text)) !== null) {
    segments.push({ text: text.slice(cursor, match.index), start: cursor });
    cursor = match.index + match[0].length;
  }
  segments.push({ text: text.slice(cursor), start: cursor });

  // Split oversized paragraphs on sentence boundaries.
  const units: Array<{ text: string; start: number }> = [];
  for (const segment of segments) {
    if (!segment.text.trim()) continue;
    if (estimateTokens(segment.text) <= maxTokens) {
      units.push(segment);
      continue;
    }
    const sentenceRegex = /[^.!?\n]+[.!?]+[\s]*|[^.!?\n]+$/g;
    let sentence: RegExpExecArray | null;
    let found = false;
    while ((sentence = sentenceRegex.exec(segment.text)) !== null) {
      found = true;
      units.push({ text: sentence[0], start: segment.start + sentence.index });
    }
    if (!found) units.push(segment);
  }

  const chunks: TextChunk[] = [];
  let buffer: Array<{ text: string; start: number }> = [];
  let bufferTokens = 0;

  const flush = (): void => {
    if (buffer.length === 0) return;
    const first = buffer[0];
    const last = buffer[buffer.length - 1];
    if (!first || !last) return;
    const content = buffer.map((u) => u.text).join('').trim();
    if (!content) {
      buffer = [];
      bufferTokens = 0;
      return;
    }
    const start = first.start;
    const end = last.start + last.text.length;
    chunks.push({ content, index: chunks.length, tokens: estimateTokens(content), start, end });

    // Carry the tail of this chunk forward as overlap.
    if (overlapTokens > 0) {
      const carried: Array<{ text: string; start: number }> = [];
      let carriedTokens = 0;
      for (let i = buffer.length - 1; i >= 0; i--) {
        const unit = buffer[i];
        if (!unit) continue;
        const unitTokens = estimateTokens(unit.text);
        if (carriedTokens + unitTokens > overlapTokens) break;
        carried.unshift(unit);
        carriedTokens += unitTokens;
      }
      buffer = carried;
      bufferTokens = carriedTokens;
    } else {
      buffer = [];
      bufferTokens = 0;
    }
  };

  for (const unit of units) {
    const unitTokens = estimateTokens(unit.text);

    // A single unit larger than the budget must be hard-split on words.
    if (unitTokens > maxTokens) {
      flush();
      const words = unit.text.split(/(\s+)/);

      // Token counts are accumulated incrementally rather than recomputed over
      // the growing accumulator. Re-estimating `acc + word` on every iteration
      // makes this O(n²) in the word count, which dominates runtime on large
      // documents — a 5k-word paragraph took seconds instead of milliseconds.
      const pieces: string[] = [];
      let accTokens = 0;
      let accStart = unit.start;
      let offset = 0;
      let hasContent = false;

      for (const word of words) {
        const wordTokens = estimateTokens(word);

        if (accTokens + wordTokens > maxTokens && hasContent) {
          const acc = pieces.join('');
          chunks.push({
            content: acc.trim(),
            index: chunks.length,
            tokens: accTokens,
            start: accStart,
            end: accStart + acc.length,
          });
          accStart = unit.start + offset;
          pieces.length = 0;
          accTokens = 0;
          hasContent = false;
        }

        pieces.push(word);
        accTokens += wordTokens;
        if (!hasContent && word.trim()) hasContent = true;
        offset += word.length;
      }

      const acc = pieces.join('');
      if (acc.trim()) {
        buffer = [{ text: acc, start: accStart }];
        bufferTokens = accTokens;
      }
      continue;
    }

    if (bufferTokens + unitTokens > maxTokens) flush();
    buffer.push(unit);
    bufferTokens += unitTokens;
  }
  flush();

  // Fold a runt final chunk back into its predecessor.
  if (chunks.length > 1) {
    const last = chunks[chunks.length - 1];
    const prev = chunks[chunks.length - 2];
    if (last && prev && last.tokens < minTokens) {
      prev.content = `${prev.content}\n${last.content}`;
      prev.tokens = estimateTokens(prev.content);
      prev.end = last.end;
      chunks.pop();
    }
  }

  return chunks.map((chunk, index) => ({ ...chunk, index }));
}

/**
 * Locate the span inside `content` that best matches the query terms, for
 * citation highlighting. Uses a sliding window scored by distinct term hits.
 */
export function bestMatchingSpan(
  content: string,
  query: string,
  windowChars = 240,
): { start: number; end: number; snippet: string } {
  const terms = new Set(analyze(query));
  if (terms.size === 0 || content.length <= windowChars) {
    return { start: 0, end: Math.min(content.length, windowChars), snippet: truncate(content, windowChars) };
  }

  const lower = content.toLowerCase();
  const step = Math.max(32, Math.floor(windowChars / 4));
  let bestStart = 0;
  let bestScore = -1;

  for (let start = 0; start < content.length; start += step) {
    const window = lower.slice(start, start + windowChars);
    const windowTerms = new Set(analyze(window));
    let score = 0;
    for (const term of terms) if (windowTerms.has(term)) score++;
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }

  // Nudge the window start to a word boundary so snippets don't begin mid-word.
  let start = bestStart;
  if (start > 0) {
    const space = content.indexOf(' ', start);
    if (space !== -1 && space - start < 40) start = space + 1;
  }
  const end = Math.min(content.length, start + windowChars);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < content.length ? '…' : '';
  return { start, end, snippet: `${prefix}${content.slice(start, end).trim()}${suffix}` };
}
