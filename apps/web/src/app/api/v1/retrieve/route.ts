/**
 * `/api/v1/retrieve` — intelligent retrieval.
 *
 * Search, plus everything an agent needs to actually use the result: redundant
 * hits removed, a token budget enforced, a ready-to-paste context block with
 * inline citation markers, and an aggregate confidence score.
 */
import { z } from 'zod';
import { retrieveInputSchema } from '@memorydb/core';
import { csvArray, handler, ok } from '@/lib/api';

export const POST = handler({ scope: 'read', bodySchema: retrieveInputSchema }, async ({ body, client }) => {
  const result = await client.retrieve(body);
  return ok(result);
});

const retrieveQuerySchema = z.object({
  q: z.string().min(1, 'q is required'),
  limit: z.coerce.number().int().positive().max(100).default(10),
  tokenBudget: z.coerce.number().int().positive().max(200_000).default(4000),
  mode: z.enum(['hybrid', 'semantic', 'keyword']).default('hybrid'),
  diversify: z.coerce.boolean().default(true),
  minScore: z.coerce.number().min(0).max(1).default(0),
  type: csvArray,
  tags: csvArray,
  userId: z.string().optional(),
});

export const GET = handler({ scope: 'read', querySchema: retrieveQuerySchema }, async ({ query, client }) => {
  const result = await client.retrieve({
    query: query.q,
    limit: query.limit,
    tokenBudget: query.tokenBudget,
    mode: query.mode,
    diversify: query.diversify,
    minScore: query.minScore,
    filter: {
      ...(query.type ? { type: query.type as never } : {}),
      ...(query.tags ? { tags: query.tags } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
    },
  });
  return ok(result);
});
