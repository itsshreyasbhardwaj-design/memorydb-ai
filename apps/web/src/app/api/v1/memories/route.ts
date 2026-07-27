/**
 * `/api/v1/memories` — create and list memories.
 */
import { z } from 'zod';
import {
  memoryKindSchema,
  memoryTypeSchema,
  metadataSchema,
  storeMemoryInputSchema,
} from '@memorydb/core';
import { csvArray, created, handler, ok } from '@/lib/api';
import { env } from '@/lib/env';

/* ------------------------------- POST ------------------------------------ */

/**
 * Accepts either a single memory or a batch. Reusing the engine's own schema
 * means the API can never drift from what the engine validates.
 */
const createBodySchema = z.union([
  storeMemoryInputSchema,
  z.object({
    memories: z.array(storeMemoryInputSchema).min(1).max(env.MAX_BATCH_SIZE),
  }),
]);

export const POST = handler(
  { scope: 'write', write: true, bodySchema: createBodySchema },
  async ({ body, client }) => {
    if ('memories' in body) {
      const results = await client.storeMany(body.memories);
      return created({
        memories: results.map((result) => result.memory),
        count: results.length,
        deduplicated: results.filter((result) => result.deduplicated).length,
      });
    }

    const result = await client.store(body);
    return created({
      memory: result.memory,
      deduplicated: result.deduplicated,
      entitiesExtracted: result.entitiesExtracted,
      ...(result.chunks ? { chunks: result.chunks.length } : {}),
    });
  },
);

/* -------------------------------- GET ------------------------------------ */

const listQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
  sortBy: z.enum(['createdAt', 'updatedAt', 'importance', 'accessCount', 'lastAccessedAt']).default('createdAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),

  type: csvArray,
  kind: csvArray,
  status: csvArray,
  tags: csvArray,
  anyTags: csvArray,
  userId: z.string().optional(),
  agentId: z.string().optional(),
  sessionId: z.string().optional(),
  sourceId: z.string().optional(),
  createdAfter: z.string().optional(),
  createdBefore: z.string().optional(),
  minImportance: z.coerce.number().min(0).max(1).optional(),
  minConfidence: z.coerce.number().min(0).max(1).optional(),
  includeArchived: z.coerce.boolean().optional(),
  /** JSON-encoded metadata filter, e.g. `?metadata={"score":{"gte":5}}`. */
  metadata: z.string().optional(),
});

export const GET = handler({ scope: 'read', querySchema: listQuerySchema }, async ({ query, client }) => {
  let metadata: Record<string, unknown> | undefined;
  if (query.metadata) {
    try {
      metadata = JSON.parse(query.metadata) as Record<string, unknown>;
    } catch {
      throw new z.ZodError([
        { code: 'custom', path: ['metadata'], message: 'metadata must be a JSON object' },
      ]);
    }
  }

  const page = await client.list({
    limit: query.limit,
    offset: query.offset,
    sortBy: query.sortBy,
    sortDir: query.sortDir,
    filter: {
      ...(query.type ? { type: query.type as never } : {}),
      ...(query.kind ? { kind: query.kind as never } : {}),
      ...(query.status ? { status: query.status as never } : {}),
      ...(query.tags ? { tags: query.tags } : {}),
      ...(query.anyTags ? { anyTags: query.anyTags } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.agentId ? { agentId: query.agentId } : {}),
      ...(query.sessionId ? { sessionId: query.sessionId } : {}),
      ...(query.sourceId ? { sourceId: query.sourceId } : {}),
      ...(query.createdAfter ? { createdAfter: query.createdAfter } : {}),
      ...(query.createdBefore ? { createdBefore: query.createdBefore } : {}),
      ...(query.minImportance !== undefined ? { minImportance: query.minImportance } : {}),
      ...(query.minConfidence !== undefined ? { minConfidence: query.minConfidence } : {}),
      ...(query.includeArchived ? { includeArchived: query.includeArchived } : {}),
      ...(metadata ? { metadata: metadata as never } : {}),
    },
  });

  return ok(page);
});

/* ------------------------------- DELETE ---------------------------------- */

const bulkDeleteSchema = z.object({
  filter: z.object({
    type: z.array(memoryTypeSchema).optional(),
    kind: z.array(memoryKindSchema).optional(),
    tags: z.array(z.string()).optional(),
    userId: z.string().optional(),
    sessionId: z.string().optional(),
    sourceId: z.string().optional(),
    createdBefore: z.string().optional(),
    metadata: metadataSchema.optional(),
  }),
  /** Permanently remove rows instead of soft-deleting them. */
  hard: z.boolean().default(false),
});

export const DELETE = handler(
  { scope: 'admin', write: true, bodySchema: bulkDeleteSchema },
  async ({ body, client }) => {
    // Requiring a non-empty filter makes "delete everything" impossible to
    // trigger by sending an empty object.
    const hasFilter = Object.values(body.filter).some((value) => value !== undefined);
    if (!hasFilter) {
      throw new z.ZodError([
        { code: 'custom', path: ['filter'], message: 'bulk delete requires at least one filter condition' },
      ]);
    }

    const deleted = await client.deleteMany(body.filter as never, body.hard);
    return ok({ deleted, hard: body.hard });
  },
);
