/**
 * `/api/v1/batch/export` — bulk export.
 *
 * Streams a downloadable file in the requested format. ZIP bundles JSON, CSV,
 * Markdown, and optionally the knowledge graph into one archive.
 */
import { z } from 'zod';
import { exportMemories } from '@memorydb/core';
import { csvArray, handler } from '@/lib/api';

const EXPORT_FORMATS = ['json', 'jsonl', 'csv', 'markdown', 'txt', 'zip'] as const;

const exportQuerySchema = z.object({
  format: z.enum(EXPORT_FORMATS).default('json'),
  includeEmbeddings: z.coerce.boolean().default(false),
  includeGraph: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().positive().max(1_000_000).default(100_000),
  type: csvArray,
  tags: csvArray,
  userId: z.string().optional(),
  sessionId: z.string().optional(),
  createdAfter: z.string().optional(),
  createdBefore: z.string().optional(),
  includeArchived: z.coerce.boolean().default(false),
  /** `?download=false` renders inline instead of triggering a file download. */
  download: z.coerce.boolean().default(true),
});

export const GET = handler({ scope: 'read', querySchema: exportQuerySchema }, async ({ query, client }) => {
  const result = await exportMemories(client, {
    format: query.format,
    includeEmbeddings: query.includeEmbeddings,
    includeGraph: query.includeGraph,
    limit: query.limit,
    filter: {
      ...(query.type ? { type: query.type as never } : {}),
      ...(query.tags ? { tags: query.tags } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.sessionId ? { sessionId: query.sessionId } : {}),
      ...(query.createdAfter ? { createdAfter: query.createdAfter } : {}),
      ...(query.createdBefore ? { createdBefore: query.createdBefore } : {}),
      ...(query.includeArchived ? { includeArchived: true } : {}),
    },
  });

  const body: BodyInit =
    typeof result.data === 'string' ? result.data : (result.data.slice().buffer as ArrayBuffer);

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': result.contentType,
      'content-disposition': query.download
        ? `attachment; filename="${result.filename}"`
        : `inline; filename="${result.filename}"`,
      'x-memorydb-count': String(result.count),
    },
  });
});
