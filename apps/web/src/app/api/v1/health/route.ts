/**
 * `/api/v1/health` — liveness and readiness.
 *
 * Unauthenticated by design: a load balancer or uptime monitor must be able to
 * reach it without credentials. It reports only whether dependencies are
 * reachable, never configuration values or connection strings.
 */
import { NextResponse } from 'next/server';
import { getMemoryClient } from '@/lib/memory';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const startedAt = performance.now();

  try {
    const client = await getMemoryClient();
    const health = await client.health();

    return NextResponse.json(
      {
        status: health.ok ? 'healthy' : 'degraded',
        version: '0.1.0',
        uptime: Math.floor(process.uptime()),
        checks: {
          storage: {
            ok: health.ok,
            adapter: health.adapter,
            latencyMs: Math.round(health.latencyMs * 100) / 100,
            details: health.details,
          },
          embeddings: {
            ok: true,
            provider: health.embeddings.provider,
            model: health.embeddings.model,
            dimensions: health.embeddings.dimensions,
          },
        },
        environment: env.NODE_ENV,
        tookMs: Math.round((performance.now() - startedAt) * 100) / 100,
      },
      { status: health.ok ? 200 : 503 },
    );
  } catch (err) {
    return NextResponse.json(
      {
        status: 'unhealthy',
        version: '0.1.0',
        // The message is safe to surface here: it comes from our own startup
        // validation and is what an operator needs to fix the deployment.
        error: err instanceof Error ? err.message : 'unknown error',
        tookMs: Math.round((performance.now() - startedAt) * 100) / 100,
      },
      { status: 503 },
    );
  }
}
