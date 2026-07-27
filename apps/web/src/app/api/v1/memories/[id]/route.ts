/**
 * `/api/v1/memories/[id]` — read, update, and delete a single memory.
 */
import { z } from 'zod';
import { NotFoundError, updateMemoryInputSchema } from '@memorydb/core';
import { handler, ok } from '@/lib/api';

export const GET = handler({ scope: 'read' }, async ({ params, client }) => {
  const id = params.id ?? '';
  const memory = await client.get(id);
  if (!memory || memory.status === 'deleted') throw new NotFoundError('memory', id);
  return ok({ memory });
});

export const PATCH = handler(
  { scope: 'write', write: true, bodySchema: updateMemoryInputSchema },
  async ({ params, body, client }) => {
    const memory = await client.update(params.id ?? '', body);
    return ok({ memory });
  },
);

const deleteQuerySchema = z.object({
  /** `?hard=true` permanently removes the row rather than soft-deleting it. */
  hard: z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((value) => value === true || value === 'true' || value === '1'),
});

export const DELETE = handler(
  { scope: 'write', write: true, querySchema: deleteQuerySchema },
  async ({ params, query, client }) => {
    const id = params.id ?? '';
    const deleted = await client.delete(id, query.hard);
    if (!deleted) throw new NotFoundError('memory', id);
    return ok({ id, deleted: true, hard: query.hard });
  },
);
