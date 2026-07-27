/**
 * `/api/v1/graph/entities` — list extracted entities.
 */
import { z } from 'zod';
import { entityTypeSchema } from '@memorydb/core';
import { csvArray, handler, ok } from '@/lib/api';

const entitiesQuerySchema = z.object({
  type: csvArray,
  search: z.string().optional(),
  minMentions: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(500).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
  sortBy: z.enum(['mentionCount', 'salience', 'lastSeenAt', 'name']).default('mentionCount'),
});

export const GET = handler({ scope: 'read', querySchema: entitiesQuerySchema }, async ({ query, client }) => {
  const types = query.type?.filter(
    (type): type is z.infer<typeof entityTypeSchema> => entityTypeSchema.safeParse(type).success,
  );

  const page = await client.entities({
    ...(types?.length ? { type: types } : {}),
    ...(query.search ? { search: query.search } : {}),
    ...(query.minMentions !== undefined ? { minMentions: query.minMentions } : {}),
    limit: query.limit,
    offset: query.offset,
    sortBy: query.sortBy,
  });

  return ok(page);
});
