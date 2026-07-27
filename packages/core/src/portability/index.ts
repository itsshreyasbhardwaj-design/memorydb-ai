/**
 * Import/export orchestration over a `MemoryClient`.
 */
import type { MemoryClient } from '../client.js';
import type { Memory, MemoryFilter } from '../types.js';
import type { ExportFormat, ExportOptions, ImportFormat, PortableMemory } from './formats.js';
import { CONTENT_TYPES, formatFromFilename, parse, serialize, toStoreInput } from './formats.js';
import { createZip, readZip } from './zip.js';
import { ValidationError } from '../errors.js';

export * from './formats.js';
export { createZip, readZip, crc32 } from './zip.js';

export interface ExportRequest {
  format: ExportFormat;
  filter?: MemoryFilter;
  includeEmbeddings?: boolean;
  /** Hard cap on exported rows. */
  limit?: number;
  /** Also include entities and relations. ZIP only. */
  includeGraph?: boolean;
}

export interface ExportResult {
  data: string | Uint8Array;
  contentType: string;
  filename: string;
  count: number;
}

/**
 * Export a namespace.
 *
 * ZIP bundles the JSON export together with human-readable Markdown, a CSV for
 * spreadsheets, and optionally the graph — a single portable archive of
 * everything the namespace knows.
 */
export async function exportMemories(client: MemoryClient, request: ExportRequest): Promise<ExportResult> {
  const limit = request.limit ?? 100_000;
  const memories: Memory[] = [];

  for await (const batch of client.storage.iterateMemories(client.namespace, request.filter, 500)) {
    memories.push(...batch);
    if (memories.length >= limit) break;
  }
  const bounded = memories.slice(0, limit);

  const options: ExportOptions = {
    namespace: client.namespace,
    ...(request.includeEmbeddings !== undefined ? { includeEmbeddings: request.includeEmbeddings } : {}),
  };
  const stamp = new Date().toISOString().slice(0, 10);

  if (request.format === 'zip') {
    const entries = [
      { name: 'memories.json', data: serialize(bounded, 'json', options) },
      { name: 'memories.csv', data: serialize(bounded, 'csv', options) },
      { name: 'memories.md', data: serialize(bounded, 'markdown', options) },
      {
        name: 'README.txt',
        data: [
          'MemoryDB AI export',
          '==================',
          '',
          `Namespace : ${client.namespace}`,
          `Exported  : ${new Date().toISOString()}`,
          `Memories  : ${bounded.length}`,
          '',
          'memories.json  Canonical export. Re-import this file to restore.',
          'memories.csv   Spreadsheet-friendly view.',
          'memories.md    Human-readable view.',
          request.includeGraph ? 'graph.json     Entities and relations.' : '',
          '',
          'Import with:  memorydb import --file memories.json',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ];

    if (request.includeGraph) {
      const graph = await client.graph({ maxNodes: 5000, maxEdges: 20_000 });
      entries.push({ name: 'graph.json', data: JSON.stringify(graph, null, 2) });
    }

    return {
      data: createZip(entries),
      contentType: CONTENT_TYPES.zip,
      filename: `memorydb-${client.namespace}-${stamp}.zip`,
      count: bounded.length,
    };
  }

  const extension = request.format === 'markdown' ? 'md' : request.format;
  return {
    data: serialize(bounded, request.format, options),
    contentType: CONTENT_TYPES[request.format],
    filename: `memorydb-${client.namespace}-${stamp}.${extension}`,
    count: bounded.length,
  };
}

export interface ImportRequest {
  data: string | Uint8Array;
  format?: ImportFormat | 'zip';
  filename?: string;
  /** Skip records whose content already exists. */
  deduplicate?: boolean;
  /** Validate and report without writing. */
  dryRun?: boolean;
  /** Records per storage batch. */
  batchSize?: number;
  /** Tags applied to every imported memory, e.g. to mark the source. */
  tags?: string[];
}

export interface ImportResult {
  imported: number;
  deduplicated: number;
  failed: number;
  total: number;
  dryRun: boolean;
  /** Per-record failures, capped so one bad file can't produce a huge payload. */
  errors: Array<{ index: number; message: string }>;
  tookMs: number;
}

export async function importMemories(client: MemoryClient, request: ImportRequest): Promise<ImportResult> {
  const startedAt = Date.now();
  const batchSize = request.batchSize ?? 100;
  const dryRun = request.dryRun ?? false;

  let records: PortableMemory[] = [];

  const isZip =
    request.format === 'zip' ||
    (request.filename?.toLowerCase().endsWith('.zip') ?? false) ||
    (typeof request.data !== 'string' && looksLikeZip(request.data));

  if (isZip) {
    if (typeof request.data === 'string') {
      throw new ValidationError('ZIP import requires binary data, not a string');
    }
    const entries = await readZip(request.data);
    // Prefer the canonical JSON export; fall back to any importable entry.
    const preferred =
      entries.find((entry) => entry.name === 'memories.json') ??
      entries.find((entry) => /\.(json|jsonl|csv|md|markdown|txt)$/i.test(entry.name));
    if (!preferred) throw new ValidationError('ZIP archive contains no importable file');
    records = parse(preferred.text(), formatFromFilename(preferred.name));
  } else {
    const text = typeof request.data === 'string' ? request.data : new TextDecoder().decode(request.data);
    const format = request.format ?? (request.filename ? formatFromFilename(request.filename) : 'json');
    records = parse(text, format as ImportFormat);
  }

  const result: ImportResult = {
    imported: 0,
    deduplicated: 0,
    failed: 0,
    total: records.length,
    dryRun,
    errors: [],
    tookMs: 0,
  };

  for (let start = 0; start < records.length; start += batchSize) {
    const batch = records.slice(start, start + batchSize);
    const inputs: Array<{ index: number; input: ReturnType<typeof toStoreInput> }> = [];

    batch.forEach((record, offset) => {
      const index = start + offset;
      try {
        const input = toStoreInput(record);
        if (request.tags?.length) {
          input.tags = Array.from(new Set([...(input.tags ?? []), ...request.tags]));
        }
        input.deduplicate = request.deduplicate ?? true;
        inputs.push({ index, input });
      } catch (err) {
        result.failed++;
        if (result.errors.length < 100) {
          result.errors.push({ index, message: err instanceof Error ? err.message : String(err) });
        }
      }
    });

    if (dryRun || inputs.length === 0) {
      result.imported += inputs.length;
      continue;
    }

    try {
      const stored = await client.storeMany(inputs.map((entry) => entry.input));
      for (const item of stored) {
        if (item.deduplicated) result.deduplicated++;
        else result.imported++;
      }
    } catch (err) {
      // Fall back to per-record writes so one bad row doesn't lose the batch.
      for (const entry of inputs) {
        try {
          const single = await client.store(entry.input);
          if (single.deduplicated) result.deduplicated++;
          else result.imported++;
        } catch (innerErr) {
          result.failed++;
          if (result.errors.length < 100) {
            result.errors.push({
              index: entry.index,
              message: innerErr instanceof Error ? innerErr.message : String(innerErr),
            });
          }
        }
      }
      void err;
    }
  }

  result.tookMs = Date.now() - startedAt;
  return result;
}

/** ZIP local file header signature: `PK\x03\x04`. */
function looksLikeZip(data: Uint8Array): boolean {
  return data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04;
}
