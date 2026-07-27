/**
 * `/api/v1/consolidate` — run memory consolidation.
 *
 * Merges duplicates, summarises old memories, archives stale ones, purges
 * expired ones, and rebuilds topic clusters. Admin-scoped because it rewrites
 * the store; `dryRun` reports the same numbers without changing anything.
 */
import { z } from 'zod';
import { memoryTypeSchema } from '@memorydb/core';
import { handler, ok } from '@/lib/api';

const consolidateBodySchema = z.object({
  duplicateThreshold: z.number().min(0).max(1).optional(),
  clusterThreshold: z.number().min(0).max(1).optional(),
  summarizeOlderThanDays: z.number().int().positive().max(3650).optional(),
  minGroupSize: z.number().int().min(2).max(1000).optional(),
  summaryMaxTokens: z.number().int().positive().max(4000).optional(),
  maxMemories: z.number().int().positive().max(100_000).optional(),
  types: z.array(memoryTypeSchema).optional(),
  dryRun: z.boolean().default(false),

  deduplicate: z.boolean().default(true),
  summarize: z.boolean().default(true),
  archive: z.boolean().default(true),
  expire: z.boolean().default(true),
  cluster: z.boolean().default(true),
});

export const POST = handler(
  { scope: 'admin', write: true, bodySchema: consolidateBodySchema },
  async ({ body, client }) => {
    const report = await client.consolidate(body);
    return ok(report);
  },
);
