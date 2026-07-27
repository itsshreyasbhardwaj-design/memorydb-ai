/**
 * `/api/v1/stats` — namespace statistics for the dashboard.
 */
import { z } from 'zod';
import { handler, ok } from '@/lib/api';

const statsQuerySchema = z.object({
  growthDays: z.coerce.number().int().positive().max(365).default(30),
  topTagsLimit: z.coerce.number().int().positive().max(100).default(20),
});

export const GET = handler({ scope: 'read', querySchema: statsQuerySchema }, async ({ query, client, auth }) => {
  const stats = await client.stats(query);
  return ok({
    ...stats,
    namespace: auth.namespace,
    embeddings: {
      provider: client.embeddings.id,
      model: client.embeddings.model,
      dimensions: client.embeddings.dimensions,
      remote: client.embeddings.remote,
    },
  });
});
