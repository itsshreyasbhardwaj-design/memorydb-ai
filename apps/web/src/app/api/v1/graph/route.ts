/**
 * `/api/v1/graph` — the knowledge graph as renderable nodes and edges.
 */
import { z } from 'zod';
import { entityTypeSchema } from '@memorydb/core';
import { csvArray, handler, ok } from '@/lib/api';

const graphQuerySchema = z.object({
  types: csvArray,
  /** Restrict to the subgraph reachable from these entity ids. */
  rootIds: csvArray,
  depth: z.coerce.number().int().min(1).max(5).default(2),
  minWeight: z.coerce.number().min(0).max(1).optional(),
  maxNodes: z.coerce.number().int().positive().max(2000).default(150),
  maxEdges: z.coerce.number().int().positive().max(5000).default(400),
  search: z.string().optional(),
});

export const GET = handler({ scope: 'read', querySchema: graphQuerySchema }, async ({ query, client }) => {
  const types = query.types
    ? query.types.filter((type): type is z.infer<typeof entityTypeSchema> =>
        entityTypeSchema.safeParse(type).success,
      )
    : undefined;

  const graph = await client.graph({
    ...(types?.length ? { types } : {}),
    ...(query.rootIds?.length ? { rootIds: query.rootIds } : {}),
    depth: query.depth,
    ...(query.minWeight !== undefined ? { minWeight: query.minWeight } : {}),
    maxNodes: query.maxNodes,
    maxEdges: query.maxEdges,
    ...(query.search ? { search: query.search } : {}),
  });

  return ok(graph);
});
