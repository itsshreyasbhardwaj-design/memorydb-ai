/**
 * `/api/v1/embeddings` — generate embeddings with the configured provider.
 *
 * Useful for clients that want to compute vectors with exactly the same model
 * MemoryDB uses, so their own similarity maths agrees with the server's.
 */
import { z } from 'zod';
import { cosineSimilarity } from '@memorydb/core';
import { handler, ok } from '@/lib/api';

const embeddingsBodySchema = z.object({
  input: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(256)]),
  /** Also return the pairwise cosine similarity matrix. */
  similarity: z.boolean().default(false),
});

export const POST = handler(
  { scope: 'read', write: true, bodySchema: embeddingsBodySchema },
  async ({ body, client }) => {
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    const vectors = await client.embeddings.embed(inputs);

    // Vectors are unit length, so the matrix is symmetric with a diagonal of 1.
    let similarity: number[][] | undefined;
    if (body.similarity) {
      similarity = vectors.map((a) => vectors.map((b) => cosineSimilarity(a, b)));
    }

    return ok({
      model: client.embeddings.model,
      provider: client.embeddings.id,
      dimensions: client.embeddings.dimensions,
      embeddings: vectors.map((embedding, index) => ({ index, embedding })),
      ...(similarity ? { similarity } : {}),
    });
  },
);

export const GET = handler({ scope: 'read' }, async ({ client }) =>
  ok({
    provider: client.embeddings.id,
    model: client.embeddings.model,
    dimensions: client.embeddings.dimensions,
    remote: client.embeddings.remote,
    maxBatchSize: client.embeddings.maxBatchSize,
    fullConfidenceSimilarity: client.embeddings.fullConfidenceSimilarity,
  }),
);
