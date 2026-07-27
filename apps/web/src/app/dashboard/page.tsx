'use client';

/**
 * Dashboard overview — the at-a-glance view of a namespace.
 */
import * as React from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  Activity,
  ArrowRight,
  Coins,
  Database,
  GitGraph,
  Hash,
  Sparkles,
  Zap,
} from 'lucide-react';
import type { Memory, MemoryStats } from '@memorydb/core';
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
  TypeBadge,
} from '@/components/ui/primitives';
import { GrowthChart, TopTagsChart, TypeDistribution } from '@/components/dashboard/charts';
import { cn, formatBytes, formatCompact, formatNumber, formatRelativeTime, truncateText } from '@/lib/utils';

type Stats = MemoryStats & {
  namespace: string;
  embeddings: { provider: string; model: string; dimensions: number; remote: boolean };
};

function StatCard({
  label,
  value,
  hint,
  icon,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: React.ReactNode;
  accent?: string;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-medium text-[var(--color-fg-subtle)]">{label}</p>
          <p className="tabular truncate text-2xl font-semibold tracking-tight">{value}</p>
          {hint && <p className="truncate text-[11px] text-[var(--color-fg-subtle)]">{hint}</p>}
        </div>
        <div
          className="grid size-9 shrink-0 place-items-center rounded-lg [&_svg]:size-4"
          style={{
            color: accent ?? 'var(--color-accent)',
            backgroundColor: `color-mix(in oklch, ${accent ?? 'var(--color-accent)'} 12%, transparent)`,
          }}
        >
          {icon}
        </div>
      </div>
    </Card>
  );
}

export default function OverviewPage() {
  const [stats, setStats] = React.useState<Stats | null>(null);
  const [recent, setRecent] = React.useState<Memory[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [consolidating, setConsolidating] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const [statsResult, memoriesResult] = await Promise.all([
        api.stats(30),
        api.listMemories({ limit: 6, sortBy: 'createdAt', sortDir: 'desc' }),
      ]);
      setStats(statsResult);
      setRecent(memoriesResult.items);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const runConsolidation = async (): Promise<void> => {
    setConsolidating(true);
    try {
      const report = await api.consolidate({ dryRun: false });
      toast.success('Consolidation complete', {
        description: `${report.duplicatesMerged} duplicates merged · ${report.archived} archived · ${report.clusters.length} clusters · ${report.tookMs}ms`,
      });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Consolidation failed');
    } finally {
      setConsolidating(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-28" />
          ))}
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-80 lg:col-span-2" />
          <Skeleton className="h-80" />
        </div>
      </div>
    );
  }

  if (!stats) {
    return <EmptyState title="Could not load statistics" description="Check that the API is reachable." />;
  }

  const addedThisPeriod = stats.growth.reduce((sum, point) => sum + point.count, 0);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Namespace <span className="font-mono text-[var(--color-fg)]">{stats.namespace}</span> ·{' '}
            {stats.embeddings.model}
            {!stats.embeddings.remote && (
              <Badge variant="success" className="ml-2">
                local · $0
              </Badge>
            )}
          </p>
        </div>

        <div className="flex gap-2">
          <Button variant="secondary" onClick={runConsolidation} disabled={consolidating}>
            <Sparkles className={cn(consolidating && 'animate-pulse')} />
            {consolidating ? 'Consolidating…' : 'Consolidate'}
          </Button>
          <Button variant="primary" asChild>
            <Link href="/dashboard/memories">
              Browse memories <ArrowRight />
            </Link>
          </Button>
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Total memories"
          value={formatNumber(stats.total)}
          hint={`${formatNumber(stats.active)} active · ${formatNumber(stats.archived)} archived`}
          icon={<Database />}
        />
        <StatCard
          label="Added (30d)"
          value={formatNumber(addedThisPeriod)}
          hint={stats.newestMemoryAt ? `latest ${formatRelativeTime(stats.newestMemoryAt)}` : 'no memories yet'}
          icon={<Zap />}
          accent="var(--color-success)"
        />
        <StatCard
          label="Knowledge graph"
          value={formatNumber(stats.entityCount)}
          hint={`${formatNumber(stats.relationCount)} relationships`}
          icon={<GitGraph />}
          accent="var(--color-type-graph)"
        />
        <StatCard
          label="Tokens stored"
          value={formatCompact(stats.totalTokens)}
          hint={formatBytes(stats.storageBytes)}
          icon={<Coins />}
          accent="var(--color-warning)"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Memory growth</CardTitle>
            <CardDescription>Cumulative total and daily additions over the last 30 days</CardDescription>
          </CardHeader>
          <CardContent>
            <GrowthChart growth={stats.growth} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>By memory type</CardTitle>
            <CardDescription>Distribution across cognitive classes</CardDescription>
          </CardHeader>
          <CardContent>
            <TypeDistribution byType={stats.byType} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle>Recent memories</CardTitle>
              <CardDescription>The most recently stored entries</CardDescription>
            </div>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/dashboard/memories">
                View all <ArrowRight />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            {recent.length === 0 ? (
              <EmptyState
                icon={<Database />}
                title="No memories yet"
                description="Store your first memory through the API or an SDK."
              />
            ) : (
              <ul className="divide-y divide-[var(--color-border)]">
                {recent.map((memory) => (
                  <li key={memory.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <TypeBadge type={memory.type} />
                        {memory.title && (
                          <span className="truncate text-sm font-medium">{memory.title}</span>
                        )}
                      </div>
                      <p className="line-clamp-2 text-xs text-[var(--color-fg-muted)]">
                        {truncateText(memory.content, 180)}
                      </p>
                      <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--color-fg-subtle)]">
                        <span>{formatRelativeTime(memory.createdAt)}</span>
                        {memory.tags.slice(0, 3).map((tag) => (
                          <span key={tag} className="flex items-center gap-0.5">
                            <Hash className="size-2.5" />
                            {tag}
                          </span>
                        ))}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Top tags</CardTitle>
            <CardDescription>Most frequently applied labels</CardDescription>
          </CardHeader>
          <CardContent>
            <TopTagsChart tags={stats.topTags} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="size-4" /> Engine configuration
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 text-xs sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['Embedding provider', stats.embeddings.provider],
              ['Model', stats.embeddings.model],
              ['Dimensions', String(stats.embeddings.dimensions)],
              ['Average importance', stats.avgImportance.toFixed(2)],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-[var(--color-fg-subtle)]">{label}</dt>
                <dd className="mt-0.5 truncate font-mono text-[var(--color-fg)]">{value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
