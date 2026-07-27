/**
 * `/api/v1/batch/import` — bulk import.
 *
 * Accepts JSON, JSONL, CSV, Markdown, plain text, and ZIP, delivered either as
 * a raw body or as `multipart/form-data`.
 */
import { z } from 'zod';
import { MemoryDBError, importMemories } from '@memorydb/core';
import { handler, ok } from '@/lib/api';
import { env } from '@/lib/env';

const IMPORT_FORMATS = ['json', 'jsonl', 'csv', 'markdown', 'txt', 'zip'] as const;

const importQuerySchema = z.object({
  format: z.enum(IMPORT_FORMATS).optional(),
  filename: z.string().optional(),
  deduplicate: z.coerce.boolean().default(true),
  dryRun: z.coerce.boolean().default(false),
  tags: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value) => {
      if (!value) return undefined;
      const list = Array.isArray(value) ? value : value.split(',');
      return list.map((tag) => tag.trim()).filter(Boolean);
    }),
});

export const POST = handler(
  {
    scope: 'write',
    write: true,
    rawBody: true,
    querySchema: importQuerySchema,
    maxBodyBytes: env.MAX_IMPORT_BYTES,
  },
  async ({ request, query, client }) => {
    const contentType = request.headers.get('content-type') ?? '';

    let data: string | Uint8Array;
    let filename = query.filename;

    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      const file = form.get('file');
      if (!(file instanceof File)) {
        throw new MemoryDBError('validation_error', 'multipart request must include a "file" field');
      }
      if (file.size > env.MAX_IMPORT_BYTES) {
        throw new MemoryDBError('payload_too_large', `file exceeds the ${env.MAX_IMPORT_BYTES} byte limit`);
      }
      filename ??= file.name;
      // Binary formats must not round-trip through a string.
      const buffer = new Uint8Array(await file.arrayBuffer());
      data = filename.toLowerCase().endsWith('.zip') ? buffer : new TextDecoder().decode(buffer);
    } else if (contentType.includes('application/zip') || query.format === 'zip') {
      data = new Uint8Array(await request.arrayBuffer());
    } else {
      data = await request.text();
    }

    if (typeof data === 'string' && data.length === 0) {
      throw new MemoryDBError('validation_error', 'request body is empty');
    }

    const result = await importMemories(client, {
      data,
      ...(query.format ? { format: query.format } : {}),
      ...(filename ? { filename } : {}),
      deduplicate: query.deduplicate,
      dryRun: query.dryRun,
      ...(query.tags?.length ? { tags: query.tags } : {}),
    });

    return ok(result);
  },
);
