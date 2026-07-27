/**
 * Import/export serialisation.
 *
 * Supported: JSON, JSONL, CSV, Markdown, plain text, and ZIP. Every format
 * round-trips through the same `PortableMemory` shape, so an export can always
 * be re-imported without loss of anything that format can represent.
 */
import type { Memory, MemoryKind, MemoryType, StoreMemoryInput } from '../types.js';
import { MEMORY_KINDS, MEMORY_TYPES } from '../types.js';
import { ValidationError } from '../errors.js';

export const EXPORT_FORMATS = ['json', 'jsonl', 'csv', 'markdown', 'txt', 'zip'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const IMPORT_FORMATS = ['json', 'jsonl', 'csv', 'markdown', 'txt'] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

/** The wire shape. Embeddings are excluded by default — they are large and derivable. */
export interface PortableMemory {
  id?: string;
  content: string;
  type?: string;
  kind?: string;
  title?: string | null;
  summary?: string | null;
  tags?: string[];
  metadata?: Record<string, unknown>;
  importance?: number;
  confidence?: number;
  userId?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
  sourceId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  embedding?: number[] | null;
}

export interface ExportEnvelope {
  version: '1.0';
  exportedAt: string;
  namespace: string;
  count: number;
  memories: PortableMemory[];
}

export interface ExportOptions {
  includeEmbeddings?: boolean;
  includeIds?: boolean;
  namespace?: string;
}

export function toPortable(memory: Memory, options: ExportOptions = {}): PortableMemory {
  const portable: PortableMemory = {
    content: memory.content,
    type: memory.type,
    kind: memory.kind,
    title: memory.title,
    summary: memory.summary,
    tags: memory.tags,
    metadata: memory.metadata,
    importance: memory.importance,
    confidence: memory.confidence,
    userId: memory.userId,
    agentId: memory.agentId,
    sessionId: memory.sessionId,
    sourceId: memory.sourceId,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
  if (options.includeIds !== false) portable.id = memory.id;
  if (options.includeEmbeddings) portable.embedding = memory.embedding;
  return portable;
}

/** Coerce an arbitrary imported record into a valid `StoreMemoryInput`. */
export function toStoreInput(portable: PortableMemory): StoreMemoryInput {
  if (!portable.content || typeof portable.content !== 'string') {
    throw new ValidationError('imported record is missing a string "content" field');
  }

  const type = MEMORY_TYPES.includes(portable.type as MemoryType) ? (portable.type as MemoryType) : 'long_term';
  const kind = MEMORY_KINDS.includes(portable.kind as MemoryKind) ? (portable.kind as MemoryKind) : 'note';

  return {
    content: portable.content,
    type,
    kind,
    title: portable.title ?? null,
    summary: portable.summary ?? null,
    tags: Array.isArray(portable.tags) ? portable.tags.filter((t) => typeof t === 'string') : [],
    metadata: (portable.metadata ?? {}) as StoreMemoryInput['metadata'],
    ...(typeof portable.importance === 'number' ? { importance: clamp01(portable.importance) } : {}),
    ...(typeof portable.confidence === 'number' ? { confidence: clamp01(portable.confidence) } : {}),
    userId: portable.userId ?? null,
    agentId: portable.agentId ?? null,
    sessionId: portable.sessionId ?? null,
    sourceId: portable.sourceId ?? null,
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/* -------------------------------------------------------------------------- */
/*                                    JSON                                     */
/* -------------------------------------------------------------------------- */

export function serializeJson(memories: Memory[], options: ExportOptions = {}): string {
  const envelope: ExportEnvelope = {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    namespace: options.namespace ?? 'default',
    count: memories.length,
    memories: memories.map((memory) => toPortable(memory, options)),
  };
  return JSON.stringify(envelope, null, 2);
}

export function parseJson(input: string): PortableMemory[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (err) {
    throw new ValidationError('input is not valid JSON', { cause: String(err) });
  }

  // Accept both our envelope and a bare array, since hand-written files are common.
  if (Array.isArray(parsed)) return parsed as PortableMemory[];
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as ExportEnvelope).memories)) {
    return (parsed as ExportEnvelope).memories;
  }
  throw new ValidationError('JSON must be an array of memories or an export envelope with a "memories" array');
}

/* -------------------------------------------------------------------------- */
/*                                   JSONL                                     */
/* -------------------------------------------------------------------------- */

export function serializeJsonl(memories: Memory[], options: ExportOptions = {}): string {
  return memories.map((memory) => JSON.stringify(toPortable(memory, options))).join('\n');
}

export function parseJsonl(input: string): PortableMemory[] {
  const out: PortableMemory[] = [];
  const lines = input.split('\n');

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      out.push(JSON.parse(trimmed) as PortableMemory);
    } catch {
      throw new ValidationError(`invalid JSON on line ${index + 1}`);
    }
  });
  return out;
}

/* -------------------------------------------------------------------------- */
/*                                     CSV                                     */
/* -------------------------------------------------------------------------- */

const CSV_COLUMNS = [
  'id','content','type','kind','title','summary','tags','importance','confidence',
  'userId','agentId','sessionId','sourceId','createdAt','metadata',
] as const;

function escapeCsv(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  // Quote whenever the value could otherwise break the row structure.
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

export function serializeCsv(memories: Memory[], options: ExportOptions = {}): string {
  const rows = [CSV_COLUMNS.join(',')];

  for (const memory of memories) {
    const portable = toPortable(memory, options);
    rows.push(
      [
        escapeCsv(portable.id),
        escapeCsv(portable.content),
        escapeCsv(portable.type),
        escapeCsv(portable.kind),
        escapeCsv(portable.title),
        escapeCsv(portable.summary),
        escapeCsv((portable.tags ?? []).join('|')),
        escapeCsv(portable.importance),
        escapeCsv(portable.confidence),
        escapeCsv(portable.userId),
        escapeCsv(portable.agentId),
        escapeCsv(portable.sessionId),
        escapeCsv(portable.sourceId),
        escapeCsv(portable.createdAt),
        escapeCsv(JSON.stringify(portable.metadata ?? {})),
      ].join(','),
    );
  }
  return rows.join('\n');
}

/** RFC 4180 parser: handles quoted fields, escaped quotes, and embedded newlines. */
export function parseCsvRows(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      // Consume CRLF as a single terminator.
      if (char === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

export function parseCsv(input: string): PortableMemory[] {
  const rows = parseCsvRows(input);
  const header = rows[0];
  if (!header) return [];

  const columns = header.map((name) => name.trim());
  const contentIndex = columns.findIndex((name) => name.toLowerCase() === 'content');
  if (contentIndex === -1) {
    throw new ValidationError('CSV must include a "content" column');
  }

  const indexOf = (name: string): number => columns.findIndex((c) => c.toLowerCase() === name.toLowerCase());
  const at = (row: string[], index: number): string | undefined =>
    index >= 0 ? row[index]?.trim() || undefined : undefined;

  const idx = {
    id: indexOf('id'),
    type: indexOf('type'),
    kind: indexOf('kind'),
    title: indexOf('title'),
    summary: indexOf('summary'),
    tags: indexOf('tags'),
    importance: indexOf('importance'),
    confidence: indexOf('confidence'),
    userId: indexOf('userId'),
    agentId: indexOf('agentId'),
    sessionId: indexOf('sessionId'),
    sourceId: indexOf('sourceId'),
    createdAt: indexOf('createdAt'),
    metadata: indexOf('metadata'),
  };

  const out: PortableMemory[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const content = row[contentIndex];
    if (!content?.trim()) continue;

    const rawTags = at(row, idx.tags);
    const rawMetadata = at(row, idx.metadata);
    let metadata: Record<string, unknown> = {};
    if (rawMetadata) {
      try {
        const parsed = JSON.parse(rawMetadata);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed;
      } catch {
        // A non-JSON metadata cell is preserved verbatim rather than dropped.
        metadata = { raw: rawMetadata };
      }
    }

    out.push({
      id: at(row, idx.id),
      content,
      type: at(row, idx.type),
      kind: at(row, idx.kind),
      title: at(row, idx.title) ?? null,
      summary: at(row, idx.summary) ?? null,
      // Accept both `|` (our export) and `,` inside a quoted cell.
      tags: rawTags ? rawTags.split(/[|,]/).map((t) => t.trim()).filter(Boolean) : [],
      metadata,
      ...(at(row, idx.importance) ? { importance: Number(at(row, idx.importance)) } : {}),
      ...(at(row, idx.confidence) ? { confidence: Number(at(row, idx.confidence)) } : {}),
      userId: at(row, idx.userId) ?? null,
      agentId: at(row, idx.agentId) ?? null,
      sessionId: at(row, idx.sessionId) ?? null,
      sourceId: at(row, idx.sourceId) ?? null,
      createdAt: at(row, idx.createdAt),
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*                                  Markdown                                   */
/* -------------------------------------------------------------------------- */

export function serializeMarkdown(memories: Memory[], options: ExportOptions = {}): string {
  const header = [
    `# MemoryDB export`,
    '',
    `- **Namespace:** ${options.namespace ?? 'default'}`,
    `- **Exported:** ${new Date().toISOString()}`,
    `- **Memories:** ${memories.length}`,
    '',
    '---',
    '',
  ].join('\n');

  const body = memories
    .map((memory) => {
      const title = memory.title ?? `${memory.kind} · ${memory.createdAt.slice(0, 10)}`;
      const frontmatter = [
        '```yaml',
        `id: ${memory.id}`,
        `type: ${memory.type}`,
        `kind: ${memory.kind}`,
        `importance: ${memory.importance}`,
        `confidence: ${memory.confidence}`,
        `created: ${memory.createdAt}`,
        memory.tags.length > 0 ? `tags: [${memory.tags.join(', ')}]` : null,
        memory.userId ? `user: ${memory.userId}` : null,
        '```',
      ]
        .filter(Boolean)
        .join('\n');

      return `## ${title}\n\n${frontmatter}\n\n${memory.content}\n`;
    })
    .join('\n---\n\n');

  return header + body;
}

/**
 * Parse Markdown into memories by splitting on `##` headings.
 *
 * A YAML-ish fenced block directly under a heading is read as attributes;
 * anything else becomes content. Documents with no headings import as one memory.
 */
export function parseMarkdown(input: string): PortableMemory[] {
  const withoutExportHeader = input.replace(/^#\s+MemoryDB export[\s\S]*?\n---\n/, '');
  const sections = withoutExportHeader.split(/^##\s+/m).filter((section) => section.trim());

  if (sections.length === 0) {
    const content = input.trim();
    return content ? [{ content, kind: 'document' }] : [];
  }

  // No `##` headings at all — treat the whole document as a single memory.
  if (sections.length === 1 && !/^##\s+/m.test(withoutExportHeader)) {
    const content = withoutExportHeader.trim();
    return content ? [{ content, kind: 'document' }] : [];
  }

  return sections.map((section) => {
    const lines = section.split('\n');
    const title = (lines[0] ?? '').trim();
    let body = lines.slice(1).join('\n');

    const attributes: Record<string, string> = {};
    const fence = body.match(/^\s*```(?:yaml|yml)?\n([\s\S]*?)\n```\s*/);
    if (fence?.[1]) {
      for (const line of fence[1].split('\n')) {
        const match = line.match(/^(\w+):\s*(.+)$/);
        if (match?.[1] && match[2]) attributes[match[1]] = match[2].trim();
      }
      body = body.slice(fence[0].length);
    }

    const rawTags = attributes.tags;
    const tags = rawTags
      ? rawTags.replace(/^\[|\]$/g, '').split(',').map((t) => t.trim()).filter(Boolean)
      : [];

    return {
      content: body.replace(/\n---\s*$/, '').trim(),
      title: title || null,
      type: attributes.type,
      kind: attributes.kind ?? 'document',
      tags,
      ...(attributes.importance ? { importance: Number(attributes.importance) } : {}),
      ...(attributes.confidence ? { confidence: Number(attributes.confidence) } : {}),
      ...(attributes.created ? { createdAt: attributes.created } : {}),
      userId: attributes.user ?? null,
    };
  }).filter((memory) => memory.content.length > 0);
}

/* -------------------------------------------------------------------------- */
/*                                 Plain text                                  */
/* -------------------------------------------------------------------------- */

export function serializeTxt(memories: Memory[]): string {
  return memories
    .map((memory) => {
      const header = `--- ${memory.title ?? memory.id} (${memory.type}/${memory.kind}, ${memory.createdAt.slice(0, 10)}) ---`;
      return `${header}\n${memory.content}`;
    })
    .join('\n\n');
}

/**
 * Parse plain text. Blank-line-separated blocks become individual memories,
 * which matches how people paste notes. A single block imports as one memory.
 */
export function parseTxt(input: string): PortableMemory[] {
  const blocks = input
    .split(/\n\s*\n\s*\n+/)
    .map((block) => block.trim())
    .filter(Boolean);

  if (blocks.length === 0) return [];
  if (blocks.length === 1) {
    const only = blocks[0];
    return only ? [{ content: only, kind: 'note' }] : [];
  }

  return blocks.map((block) => {
    // Strip an export header line if this text came from serializeTxt.
    const match = block.match(/^---\s+(.+?)\s+\((\w+)\/(\w+),\s*[\d-]+\)\s+---\n([\s\S]*)$/);
    if (match) {
      return { content: (match[4] ?? '').trim(), title: match[1] ?? null, type: match[2], kind: match[3] };
    }
    return { content: block, kind: 'note' };
  });
}

/* -------------------------------------------------------------------------- */
/*                                  Dispatch                                   */
/* -------------------------------------------------------------------------- */

export function serialize(memories: Memory[], format: Exclude<ExportFormat, 'zip'>, options: ExportOptions = {}): string {
  switch (format) {
    case 'json':
      return serializeJson(memories, options);
    case 'jsonl':
      return serializeJsonl(memories, options);
    case 'csv':
      return serializeCsv(memories, options);
    case 'markdown':
      return serializeMarkdown(memories, options);
    case 'txt':
      return serializeTxt(memories);
    default: {
      const exhaustive: never = format;
      throw new ValidationError(`unsupported export format: ${String(exhaustive)}`);
    }
  }
}

export function parse(input: string, format: ImportFormat): PortableMemory[] {
  switch (format) {
    case 'json':
      return parseJson(input);
    case 'jsonl':
      return parseJsonl(input);
    case 'csv':
      return parseCsv(input);
    case 'markdown':
      return parseMarkdown(input);
    case 'txt':
      return parseTxt(input);
    default: {
      const exhaustive: never = format;
      throw new ValidationError(`unsupported import format: ${String(exhaustive)}`);
    }
  }
}

/** Guess a format from a filename, falling back to JSON. */
export function formatFromFilename(filename: string): ImportFormat {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) return 'jsonl';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.txt') || lower.endsWith('.text')) return 'txt';
  return 'json';
}

export const CONTENT_TYPES: Record<ExportFormat, string> = {
  json: 'application/json',
  jsonl: 'application/x-ndjson',
  csv: 'text/csv',
  markdown: 'text/markdown',
  txt: 'text/plain',
  zip: 'application/zip',
};
