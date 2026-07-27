/**
 * Remote embedding provider for any OpenAI-compatible `/embeddings` endpoint.
 *
 * Verified shapes: OpenAI, OpenRouter, Together, Voyage, Mistral, Ollama, and
 * LM Studio. Ollama and LM Studio run locally and cost nothing, so a neural
 * upgrade does not have to mean a bill.
 *
 * Never constructed implicitly — callers must supply a configuration, so no
 * code path can start making billable calls by accident.
 */
import type { EmbeddingProvider } from './types.js';
import { EmbeddingError } from '../errors.js';
import { normalizeInPlace } from '../util/vector.js';

export interface RemoteEmbeddingOptions {
  /** e.g. `https://openrouter.ai/api/v1` or `http://localhost:11434/v1`. */
  baseUrl: string;
  model: string;
  dimensions: number;
  /** Omit for endpoints that need no auth, such as a local Ollama. */
  apiKey?: string;
  /** Provider id recorded on stored vectors. Defaults to the baseUrl host. */
  id?: string;
  maxBatchSize?: number;
  timeoutMs?: number;
  maxRetries?: number;
  headers?: Record<string, string>;
}

interface EmbeddingApiResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
  error?: { message?: string };
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export class RemoteEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dimensions: number;
  readonly maxBatchSize: number;
  readonly remote = true;
  /** Neural embedders place semantically related pairs high on the cosine range. */
  readonly fullConfidenceSimilarity = 0.75;

  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: RemoteEmbeddingOptions) {
    if (!options.baseUrl) throw new EmbeddingError('baseUrl is required for a remote embedding provider');
    if (!options.model) throw new EmbeddingError('model is required for a remote embedding provider');

    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.model = options.model;
    this.dimensions = options.dimensions;
    this.apiKey = options.apiKey;
    this.maxBatchSize = options.maxBatchSize ?? 96;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.extraHeaders = options.headers ?? {};

    let host = options.baseUrl;
    try {
      host = new URL(options.baseUrl).host;
    } catch {
      // Leave the raw string as the id if it isn't a parseable URL.
    }
    this.id = options.id ?? host;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const batches: string[][] = [];
    for (let i = 0; i < texts.length; i += this.maxBatchSize) {
      batches.push(texts.slice(i, i + this.maxBatchSize));
    }

    const results: number[][] = [];
    // Sequential by design: parallel batches are the fastest way to trip a
    // provider rate limit, and embedding is rarely the latency bottleneck.
    for (const batch of batches) {
      results.push(...(await this.embedBatch(batch)));
    }
    return results;
  }

  private async embedBatch(batch: string[]): Promise<number[][]> {
    // Empty strings are rejected by most providers; substitute and zero out after.
    const sanitized = batch.map((text) => (text.trim() ? text : ' '));
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        // Exponential backoff with full jitter, capped at 8s.
        const backoff = Math.min(8000, 250 * 2 ** (attempt - 1));
        await sleep(Math.random() * backoff);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(`${this.baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
            ...this.extraHeaders,
          },
          body: JSON.stringify({ model: this.model, input: sanitized }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          if (RETRYABLE_STATUS.has(response.status) && attempt < this.maxRetries) {
            lastError = new EmbeddingError(`embedding provider returned ${response.status}: ${body.slice(0, 200)}`);
            continue;
          }
          throw new EmbeddingError(
            `embedding provider returned ${response.status}: ${body.slice(0, 200)}`,
          );
        }

        const payload = (await response.json()) as EmbeddingApiResponse;
        if (payload.error) throw new EmbeddingError(payload.error.message ?? 'unknown embedding provider error');
        if (!payload.data || payload.data.length !== sanitized.length) {
          throw new EmbeddingError(
            `embedding provider returned ${payload.data?.length ?? 0} vectors for ${sanitized.length} inputs`,
          );
        }

        // `index` is authoritative — some providers do not preserve input order.
        const ordered = new Array<number[]>(sanitized.length);
        payload.data.forEach((item, position) => {
          const index = item.index ?? position;
          const embedding = item.embedding;
          if (!embedding) throw new EmbeddingError(`missing embedding at index ${index}`);
          if (embedding.length !== this.dimensions) {
            throw new EmbeddingError(
              `dimension mismatch: configured ${this.dimensions}, provider returned ${embedding.length}`,
            );
          }
          ordered[index] = normalizeInPlace(embedding.slice());
        });

        return ordered.map((vector, index) =>
          batch[index]?.trim() ? (vector ?? new Array<number>(this.dimensions).fill(0)) : new Array<number>(this.dimensions).fill(0),
        );
      } catch (err) {
        lastError = err;
        const aborted = err instanceof Error && err.name === 'AbortError';
        const retryable = aborted || err instanceof TypeError; // network-level failure
        if (!retryable || attempt === this.maxRetries) {
          if (err instanceof EmbeddingError) throw err;
          throw new EmbeddingError(
            aborted ? `embedding request timed out after ${this.timeoutMs}ms` : 'embedding request failed',
            err,
          );
        }
      } finally {
        clearTimeout(timer);
      }
    }

    throw new EmbeddingError('embedding request failed after retries', lastError);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** OpenRouter-flavoured factory, pre-filling the attribution headers it expects. */
export function createOpenRouterProvider(config: {
  apiKey: string;
  model?: string;
  dimensions?: number;
  appUrl?: string;
  appName?: string;
}): EmbeddingProvider {
  return new RemoteEmbeddingProvider({
    id: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: config.model ?? 'openai/text-embedding-3-small',
    dimensions: config.dimensions ?? 1536,
    apiKey: config.apiKey,
    headers: {
      ...(config.appUrl ? { 'HTTP-Referer': config.appUrl } : {}),
      ...(config.appName ? { 'X-Title': config.appName } : {}),
    },
  });
}

/** Ollama runs locally and is free — the recommended neural upgrade path. */
export function createOllamaProvider(config: {
  model?: string;
  dimensions?: number;
  baseUrl?: string;
}): EmbeddingProvider {
  return new RemoteEmbeddingProvider({
    id: 'ollama',
    baseUrl: config.baseUrl ?? 'http://localhost:11434/v1',
    model: config.model ?? 'nomic-embed-text',
    dimensions: config.dimensions ?? 768,
  });
}
