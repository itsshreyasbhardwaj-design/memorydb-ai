/**
 * Summarisation.
 *
 * The default is *extractive*: it selects the most representative sentences
 * from the source rather than generating new text. That makes it free,
 * instant, deterministic, and — importantly for a memory system — incapable of
 * hallucinating a fact that was never stored.
 *
 * The algorithm is centroid-based, closely related to TextRank and LexRank:
 * score each sentence by similarity to the document centroid, then greedily
 * select high-scoring sentences that aren't redundant with what's already
 * chosen, and finally restore original document order for readability.
 *
 * For abstractive summaries, implement `Summarizer` over an LLM and pass it to
 * the consolidator — everything downstream is unchanged.
 */
import { analyze, estimateTokens, truncate } from '../util/text.js';

export interface SummarizeRequest {
  texts: string[];
  /** Approximate ceiling for the produced summary. */
  maxTokens?: number;
  /** Optional steer, e.g. "focus on decisions and action items". */
  instruction?: string;
}

export interface SummarizeResult {
  summary: string;
  /** `extractive` never invents text; `abstractive` may. */
  method: 'extractive' | 'abstractive';
  tokens: number;
}

export interface Summarizer {
  readonly name: string;
  summarize(request: SummarizeRequest): Promise<SummarizeResult>;
}

interface Sentence {
  text: string;
  index: number;
  terms: Set<string>;
  tokens: number;
}

/** Split into sentences, keeping list items and short lines as their own units. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z"'(])|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

export class ExtractiveSummarizer implements Summarizer {
  readonly name = 'extractive';

  async summarize(request: SummarizeRequest): Promise<SummarizeResult> {
    const maxTokens = request.maxTokens ?? 256;
    const combined = request.texts.filter(Boolean).join('\n\n');

    if (!combined.trim()) return { summary: '', method: 'extractive', tokens: 0 };
    if (estimateTokens(combined) <= maxTokens) {
      return { summary: combined, method: 'extractive', tokens: estimateTokens(combined) };
    }

    const sentences: Sentence[] = splitSentences(combined).map((text, index) => ({
      text,
      index,
      terms: new Set(analyze(text)),
      tokens: estimateTokens(text),
    }));

    if (sentences.length <= 1) {
      const clipped = truncate(combined, maxTokens * 4);
      return { summary: clipped, method: 'extractive', tokens: estimateTokens(clipped) };
    }

    // Document term frequencies form the centroid we score sentences against.
    const documentFrequency = new Map<string, number>();
    for (const sentence of sentences) {
      for (const term of sentence.terms) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
    }

    // Bias toward terms in the instruction, if one was supplied.
    const focusTerms = request.instruction ? new Set(analyze(request.instruction)) : null;

    const scored = sentences.map((sentence) => {
      let score = 0;
      for (const term of sentence.terms) {
        const df = documentFrequency.get(term) ?? 0;
        // Terms shared across the document are what the document is "about";
        // the sqrt damps the advantage of merely long sentences.
        score += df;
        if (focusTerms?.has(term)) score += df * 2;
      }
      const normalized = sentence.terms.size === 0 ? 0 : score / Math.sqrt(sentence.terms.size);
      // Lead bias: the opening sentences of a passage carry disproportionate
      // information — a well-established result in summarisation.
      const positionBoost = sentence.index < 2 ? 1.25 : 1;
      return { sentence, score: normalized * positionBoost };
    });

    scored.sort((a, b) => b.score - a.score);

    const selected: Sentence[] = [];
    let usedTokens = 0;

    for (const { sentence } of scored) {
      if (usedTokens + sentence.tokens > maxTokens) continue;
      // Skip sentences that mostly repeat something already selected.
      const redundant = selected.some((chosen) => jaccard(chosen.terms, sentence.terms) > 0.6);
      if (redundant) continue;
      selected.push(sentence);
      usedTokens += sentence.tokens;
      if (usedTokens >= maxTokens * 0.9) break;
    }

    if (selected.length === 0) {
      const first = sentences[0];
      const clipped = truncate(first ? first.text : combined, maxTokens * 4);
      return { summary: clipped, method: 'extractive', tokens: estimateTokens(clipped) };
    }

    // Restore document order — a summary that jumps around reads badly.
    selected.sort((a, b) => a.index - b.index);
    const summary = selected.map((sentence) => sentence.text).join(' ');
    return { summary, method: 'extractive', tokens: estimateTokens(summary) };
  }
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const term of a) if (b.has(term)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

/**
 * Chat-completions summariser for any OpenAI-compatible endpoint.
 *
 * Opt-in only. Constructing it requires an explicit endpoint and model, so no
 * default code path can trigger a billable call.
 */
export class LLMSummarizer implements Summarizer {
  readonly name = 'llm';

  constructor(
    private readonly config: {
      baseUrl: string;
      model: string;
      apiKey?: string;
      timeoutMs?: number;
    },
  ) {}

  async summarize(request: SummarizeRequest): Promise<SummarizeResult> {
    const maxTokens = request.maxTokens ?? 256;
    const instruction =
      request.instruction ??
      'Summarise the following memories into a single dense paragraph. Preserve concrete facts, names, dates, and decisions. Do not add information that is not present.';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 30_000);

    try {
      const response = await fetch(`${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: maxTokens,
          temperature: 0.2,
          messages: [
            { role: 'system', content: instruction },
            { role: 'user', content: request.texts.join('\n\n---\n\n') },
          ],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`summarizer returned ${response.status}`);
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const summary = payload.choices?.[0]?.message?.content?.trim() ?? '';
      if (!summary) throw new Error('summarizer returned an empty completion');

      return { summary, method: 'abstractive', tokens: estimateTokens(summary) };
    } finally {
      clearTimeout(timer);
    }
  }
}
