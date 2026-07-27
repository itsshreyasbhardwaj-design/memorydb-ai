/**
 * Browser-side API client.
 *
 * A thin typed wrapper over `fetch` for the dashboard. Requests are same-origin
 * and carry the session cookie, so no key is embedded in client code.
 */
'use client';

import type {
  Entity,
  KnowledgeGraph,
  Memory,
  MemoryStats,
  Page,
  RetrieveResult,
  SearchResult,
} from '@memorydb/core';

export interface ApiEnvelope<T> {
  data: T;
  error: null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
    credentials: 'same-origin',
  });

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    if (!response.ok) throw new ApiError(response.status, 'internal_error', response.statusText);
    return undefined as T;
  }

  const payload = (await response.json()) as ApiEnvelope<T> | { error: { code: string; message: string }; requestId?: string };

  if (!response.ok || ('error' in payload && payload.error)) {
    const error = 'error' in payload && payload.error ? payload.error : null;
    throw new ApiError(
      response.status,
      error?.code ?? 'internal_error',
      error?.message ?? 'request failed',
      'requestId' in payload ? payload.requestId : undefined,
    );
  }

  return (payload as ApiEnvelope<T>).data;
}

function qs(params: Record<string, string | number | boolean | string[] | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const serialized = search.toString();
  return serialized ? `?${serialized}` : '';
}

export const api = {
  stats: (growthDays = 30) =>
    request<MemoryStats & { namespace: string; embeddings: { provider: string; model: string; dimensions: number; remote: boolean } }>(
      `/stats${qs({ growthDays })}`,
    ),

  listMemories: (params: {
    limit?: number;
    offset?: number;
    sortBy?: string;
    sortDir?: string;
    type?: string[];
    tags?: string[];
    includeArchived?: boolean;
  } = {}) => request<Page<Memory>>(`/memories${qs(params)}`),

  getMemory: (id: string) => request<{ memory: Memory }>(`/memories/${encodeURIComponent(id)}`),

  createMemory: (input: Record<string, unknown>) =>
    request<{ memory: Memory; deduplicated: boolean; entitiesExtracted: number }>('/memories', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateMemory: (id: string, patch: Record<string, unknown>) =>
    request<{ memory: Memory }>(`/memories/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteMemory: (id: string, hard = false) =>
    request<{ id: string; deleted: boolean }>(`/memories/${encodeURIComponent(id)}${qs({ hard })}`, {
      method: 'DELETE',
    }),

  search: (input: { query: string; mode?: string; limit?: number; explain?: boolean; minScore?: number; filter?: unknown }) =>
    request<SearchResult>('/search', { method: 'POST', body: JSON.stringify(input) }),

  retrieve: (input: { query: string; limit?: number; tokenBudget?: number; diversify?: boolean }) =>
    request<RetrieveResult>('/retrieve', { method: 'POST', body: JSON.stringify(input) }),

  graph: (params: { maxNodes?: number; types?: string[]; minWeight?: number; search?: string } = {}) =>
    request<KnowledgeGraph>(`/graph${qs(params)}`),

  entities: (params: { limit?: number; type?: string[]; search?: string; sortBy?: string } = {}) =>
    request<Page<Entity>>(`/graph/entities${qs(params)}`),

  consolidate: (options: Record<string, unknown> = {}) =>
    request<{
      scanned: number;
      duplicatesMerged: number;
      summariesCreated: number;
      archived: number;
      expired: number;
      clusters: Array<{ id: string; label: string; memoryIds: string[]; keywords: string[]; coherence: number }>;
      tokensReclaimed: number;
      tookMs: number;
      dryRun: boolean;
      warnings: string[];
    }>('/consolidate', { method: 'POST', body: JSON.stringify(options) }),

  metrics: () =>
    request<{
      counters: Record<string, number>;
      histograms: Record<string, { count: number; mean: number; p50: number; p95: number; p99: number; max: number }>;
      uptimeMs: number;
      process: { uptimeSeconds: number; memoryMb: number; nodeVersion: string };
    }>('/metrics'),

  exportUrl: (params: { format: string; includeGraph?: boolean; includeEmbeddings?: boolean }) =>
    `/api/v1/batch/export${qs(params)}`,

  importFile: async (file: File, options: { dryRun?: boolean; tags?: string[] } = {}) => {
    const form = new FormData();
    form.append('file', file);
    const response = await fetch(`/api/v1/batch/import${qs({ ...options, filename: file.name })}`, {
      method: 'POST',
      body: form,
      credentials: 'same-origin',
    });
    const payload = (await response.json()) as ApiEnvelope<{
      imported: number;
      deduplicated: number;
      failed: number;
      total: number;
      errors: Array<{ index: number; message: string }>;
    }> | { error: { code: string; message: string } };

    if (!response.ok || ('error' in payload && payload.error)) {
      const error = 'error' in payload ? payload.error : null;
      throw new ApiError(response.status, error?.code ?? 'internal_error', error?.message ?? 'import failed');
    }
    return (payload as ApiEnvelope<{ imported: number; deduplicated: number; failed: number; total: number; errors: Array<{ index: number; message: string }> }>).data;
  },
};
