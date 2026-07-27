/**
 * `/api/v1/search` — hybrid semantic + keyword search.
 *
 * Exposed as both POST (full filter grammar in the body) and GET (simple
 * queries that are easy to hit from a browser or `curl`).
 */
import { z } from 'zod';
import { searchInputSchema } from '@memorydb/core';
import { csvArray, handler, ok } from '@/lib/api';

export const POST = handler({ scope: 'read', bodySchema: searchInputSchema }, async ({ body, client }) => {
  const result = await client.search(body);
  return ok(result);
});

const searchQuerySchema = z.object({
  q: z.string().min(1, 'q is required'),
  mode: z.enum(['hybrid', 'semantic', 'keyword']).default('hybrid'),
  limit: z.coerce.number().int().positive().max(200).default(10),
  offset: z.coerce.number().int().nonnegative().default(0),
  minScore: z.coerce.number().min(0).max(1).default(0),
  type: csvArray,
  tags: csvArray,
  userId: z.string().optional(),
  sessionId: z.string().optional(),
  explain: z.coerce.boolean().default(false),
});

export const GET = handler({ scope: 'read', querySchema: searchQuerySchema }, async ({ query, client }) => {
  const result = await client.search({
    query: query.q,
    mode: query.mode,
    limit: query.limit,
    offset: query.offset,
    minScore: query.minScore,
    explain: query.explain,
    filter: {
      ...(query.type ? { type: query.type as never } : {}),
      ...(query.tags ? { tags: query.tags } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.sessionId ? { sessionId: query.sessionId } : {}),
    },
  });
  return ok(result);
});
