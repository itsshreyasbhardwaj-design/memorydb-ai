/**
 * `/api/v1/metrics` — observability.
 *
 * Returns JSON by default and Prometheus text exposition format when the client
 * asks for it, so it can be scraped directly.
 */
import { NextResponse } from 'next/server';
import { handler, ok } from '@/lib/api';
import { metrics } from '@/lib/memory';
import { env } from '@/lib/env';

export const GET = handler({ scope: 'admin' }, async ({ request }) => {
  if (!env.METRICS_ENABLED) {
    return ok({ enabled: false, message: 'metrics collection is disabled (METRICS_ENABLED=false)' });
  }

  const accepts = request.headers.get('accept') ?? '';
  const format = new URL(request.url).searchParams.get('format');

  if (format === 'prometheus' || accepts.includes('text/plain')) {
    return new NextResponse(metrics.toPrometheus(), {
      status: 200,
      headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
    });
  }

  const snapshot = metrics.snapshot();
  return ok({
    ...snapshot,
    process: {
      uptimeSeconds: Math.floor(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      nodeVersion: process.version,
    },
  });
});
