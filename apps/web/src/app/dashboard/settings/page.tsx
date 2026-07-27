'use client';

/**
 * Settings and observability — engine configuration, live metrics, and maintenance.
 */
import * as React from 'react';
import { toast } from 'sonner';
import { Activity, Cpu, Database, Download, Sparkles } from 'lucide-react';
import { api } from '@/lib/client-api';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Skeleton,
} from '@/components/ui/primitives';
import { LatencyChart } from '@/components/dashboard/charts';
import { formatBytes, formatDuration, formatNumber } from '@/lib/utils';

type Metrics = Awaited<ReturnType<typeof api.metrics>>;
type Stats = Awaited<ReturnType<typeof api.stats>>;

export default function SettingsPage() {
  const [metrics, setMetrics] = React.useState<Metrics | null>(null);
  const [stats, setStats] = React.useState<Stats | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [report, setReport] = React.useState<Awaited<ReturnType<typeof api.consolidate>> | null>(null);

  const load = React.useCallback(async () => {
    try {
      // Metrics require the admin scope; a session may legitimately lack it, so
      // a failure here must not blank the whole page.
      const [statsResult, metricsResult] = await Promise.allSettled([api.stats(7), api.metrics()]);
      if (statsResult.status === 'fulfilled') setStats(statsResult.value);
      if (metricsResult.status === 'fulfilled') setMetrics(metricsResult.value);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const runConsolidation = async (dryRun: boolean): Promise<void> => {
    setBusy(true);
    try {
      const result = await api.consolidate({ dryRun });
      setReport(result);
      toast.success(dryRun ? 'Dry run complete — nothing was changed' : 'Consolidation complete', {
        description: `${result.duplicatesMerged} merged · ${result.summariesCreated} summaries · ${result.archived} archived · ${formatDuration(result.tookMs)}`,
      });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Consolidation failed');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-40" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const searchLatency = metrics?.histograms?.['search'] ?? metrics?.histograms?.['api.request'];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Settings &amp; observability</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Engine configuration, live performance metrics, and maintenance operations.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Cpu className="size-4" /> Embeddings
            </CardTitle>
            <CardDescription>The provider used for all vector operations</CardDescription>
          </CardHeader>
          <CardContent>
            {stats ? (
              <dl className="space-y-2.5 text-sm">
                {[
                  ['Provider', stats.embeddings.provider],
                  ['Model', stats.embeddings.model],
                  ['Dimensions', String(stats.embeddings.dimensions)],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between gap-4">
                    <dt className="text-[var(--color-fg-subtle)]">{label}</dt>
                    <dd className="truncate font-mono text-xs">{value}</dd>
                  </div>
                ))}
                <div className="flex items-center justify-between">
                  <dt className="text-[var(--color-fg-subtle)]">Cost</dt>
                  <dd>
                    {stats.embeddings.remote ? (
                      <Badge variant="warning">billed per request</Badge>
                    ) : (
                      <Badge variant="success">$0 — runs locally</Badge>
                    )}
                  </dd>
                </div>
              </dl>
            ) : (
              <EmptyState title="Unavailable" />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Database className="size-4" /> Storage
            </CardTitle>
            <CardDescription>Namespace footprint</CardDescription>
          </CardHeader>
          <CardContent>
            {stats ? (
              <dl className="space-y-2.5 text-sm">
                {[
                  ['Total memories', formatNumber(stats.total)],
                  ['Active', formatNumber(stats.active)],
                  ['Archived', formatNumber(stats.archived)],
                  ['Superseded', formatNumber(stats.superseded)],
                  ['Tokens', formatNumber(stats.totalTokens)],
                  ['Approx. size', formatBytes(stats.storageBytes)],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between">
                    <dt className="text-[var(--color-fg-subtle)]">{label}</dt>
                    <dd className="tabular font-medium">{value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <EmptyState title="Unavailable" />
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="size-4" /> Request latency
          </CardTitle>
          <CardDescription>
            {searchLatency
              ? `${formatNumber(searchLatency.count)} requests observed · updates every 15s`
              : 'No traffic recorded yet'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LatencyChart histogram={searchLatency} />
        </CardContent>
      </Card>

      {metrics && (
        <Card>
          <CardHeader>
            <CardTitle>Counters</CardTitle>
            <CardDescription>
              Process uptime {Math.floor(metrics.process.uptimeSeconds / 60)}m · heap{' '}
              {metrics.process.memoryMb} MB · Node {metrics.process.nodeVersion}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {Object.keys(metrics.counters).length === 0 ? (
              <EmptyState title="No counters yet" description="Counters appear as the API handles traffic." />
            ) : (
              <ul className="grid gap-1.5 text-xs sm:grid-cols-2 lg:grid-cols-3">
                {Object.entries(metrics.counters)
                  .sort(([, a], [, b]) => b - a)
                  .slice(0, 18)
                  .map(([name, value]) => (
                    <li key={name} className="flex items-center justify-between gap-2 rounded bg-[var(--color-surface-raised)] px-2 py-1">
                      <span className="truncate font-mono text-[var(--color-fg-muted)]">{name}</span>
                      <span className="tabular shrink-0 font-medium">{formatNumber(value)}</span>
                    </li>
                  ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="size-4" /> Maintenance
          </CardTitle>
          <CardDescription>
            Consolidation merges duplicates, summarises old memories, archives stale ones, purges expired
            ones, and rebuilds topic clusters.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => runConsolidation(true)} disabled={busy}>
              Dry run
            </Button>
            <Button variant="primary" onClick={() => runConsolidation(false)} disabled={busy}>
              <Sparkles />
              Run consolidation
            </Button>
            <Button variant="secondary" asChild>
              <a href={api.exportUrl({ format: 'zip', includeGraph: true, includeEmbeddings: false })} download>
                <Download />
                Download backup
              </a>
            </Button>
          </div>

          {report && (
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-4">
              <p className="mb-3 text-xs font-medium">
                {report.dryRun ? 'Dry run report — no changes were written' : 'Consolidation report'}
              </p>
              <dl className="grid gap-3 text-xs sm:grid-cols-3 lg:grid-cols-6">
                {[
                  ['Scanned', report.scanned],
                  ['Merged', report.duplicatesMerged],
                  ['Summaries', report.summariesCreated],
                  ['Archived', report.archived],
                  ['Expired', report.expired],
                  ['Clusters', report.clusters.length],
                ].map(([label, value]) => (
                  <div key={String(label)}>
                    <dt className="text-[var(--color-fg-subtle)]">{label}</dt>
                    <dd className="tabular mt-0.5 text-base font-semibold">{formatNumber(Number(value))}</dd>
                  </div>
                ))}
              </dl>

              {report.clusters.length > 0 && (
                <div className="mt-4">
                  <p className="mb-1.5 text-[11px] text-[var(--color-fg-subtle)]">Topic clusters</p>
                  <ul className="flex flex-wrap gap-1.5">
                    {report.clusters.slice(0, 8).map((cluster) => (
                      <li key={cluster.id}>
                        <Badge variant="accent">
                          {cluster.label} · {cluster.memoryIds.length}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {report.warnings.length > 0 && (
                <ul className="mt-3 space-y-1">
                  {report.warnings.map((warning, index) => (
                    <li key={index} className="text-[11px] text-[var(--color-warning)]">
                      {warning}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
