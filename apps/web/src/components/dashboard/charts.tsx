'use client';

/**
 * Dashboard charts.
 *
 * Built on Recharts, restyled to the design tokens so charts read as part of
 * the interface rather than a bolted-on library. Every chart degrades to a
 * meaningful empty state rather than rendering empty axes.
 */
import * as React from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { MemoryStats } from '@memorydb/core';
import { cn, formatCompact, formatNumber, MEMORY_TYPE_LABELS, memoryTypeColor } from '@/lib/utils';
import { EmptyState } from '@/components/ui/primitives';

const AXIS_STYLE = {
  stroke: 'var(--color-border)',
  fontSize: 11,
  fill: 'var(--color-fg-subtle)',
} as const;

/** Shared tooltip so every chart explains itself identically. */
function ChartTooltip({
  active,
  payload,
  label,
  valueFormatter = formatNumber,
  labelFormatter,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; color?: string; payload?: Record<string, unknown> }>;
  label?: string | number;
  valueFormatter?: (value: number) => string;
  labelFormatter?: (label: string) => string;
}) {
  if (!active || !payload?.length) return null;

  return (
    <div className="glass rounded-lg px-3 py-2 text-xs shadow-[var(--shadow-overlay)]">
      {label !== undefined && (
        <p className="mb-1 font-medium text-[var(--color-fg)]">
          {labelFormatter ? labelFormatter(String(label)) : String(label)}
        </p>
      )}
      {payload.map((entry, index) => (
        <div key={index} className="flex items-center gap-2">
          {entry.color && (
            <span className="size-2 rounded-full" style={{ backgroundColor: entry.color }} aria-hidden />
          )}
          <span className="text-[var(--color-fg-subtle)]">{entry.name}</span>
          <span className="tabular ml-auto font-medium text-[var(--color-fg)]">
            {valueFormatter(entry.value ?? 0)}
          </span>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                               Growth chart                                  */
/* -------------------------------------------------------------------------- */

export function GrowthChart({ growth, className }: { growth: MemoryStats['growth']; className?: string }) {
  const hasData = growth.some((point) => point.count > 0);

  const data = React.useMemo(
    () => growth.map((point) => ({ ...point, label: point.date.slice(5) })),
    [growth],
  );

  if (!hasData) {
    return (
      <div className={className}>
        <EmptyState title="No memories yet" description="Growth appears here once memories are stored." />
      </div>
    );
  }

  return (
    <div className={cn('h-56 w-full min-w-0', className)}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
          <defs>
            <linearGradient id="growthFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} opacity={0.4} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} {...AXIS_STYLE} minTickGap={24} />
          <YAxis tickLine={false} axisLine={false} {...AXIS_STYLE} tickFormatter={formatCompact} width={44} />
          <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'var(--color-border-strong)' }} />
          <Area
            type="monotone"
            dataKey="cumulative"
            name="Total memories"
            stroke="var(--color-accent)"
            strokeWidth={2}
            fill="url(#growthFill)"
          />
          <Line
            type="monotone"
            dataKey="count"
            name="Added"
            stroke="var(--color-accent-strong)"
            strokeWidth={1.5}
            dot={false}
            strokeDasharray="4 3"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                          Memory type distribution                           */
/* -------------------------------------------------------------------------- */

export function TypeDistribution({ byType, className }: { byType: Record<string, number>; className?: string }) {
  const data = React.useMemo(
    () =>
      Object.entries(byType)
        .filter(([, count]) => count > 0)
        .map(([type, count]) => ({
          type,
          label: MEMORY_TYPE_LABELS[type] ?? type,
          count,
          color: memoryTypeColor(type),
        }))
        .sort((a, b) => b.count - a.count),
    [byType],
  );

  if (data.length === 0) {
    return (
      <div className={className}>
        <EmptyState title="No memories yet" description="Type distribution appears once memories exist." />
      </div>
    );
  }

  const total = data.reduce((sum, entry) => sum + entry.count, 0);

  return (
    <div className={cn('min-w-0 space-y-3', className)}>
      {/* A stacked bar reads proportion better than a pie at this scale. */}
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-[var(--color-surface-overlay)]">
        {data.map((entry) => (
          <div
            key={entry.type}
            className="h-full transition-all duration-500 [transition-timing-function:var(--ease-out-expo)]"
            style={{ width: `${(entry.count / total) * 100}%`, backgroundColor: entry.color }}
            title={`${entry.label}: ${entry.count}`}
          />
        ))}
      </div>

      <ul className="space-y-1.5">
        {data.map((entry) => (
          <li key={entry.type} className="flex items-center gap-2 text-xs">
            <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: entry.color }} aria-hidden />
            <span className="text-[var(--color-fg-muted)]">{entry.label}</span>
            <span className="ml-auto tabular font-medium text-[var(--color-fg)]">{formatNumber(entry.count)}</span>
            <span className="tabular w-10 text-right text-[var(--color-fg-subtle)]">
              {((entry.count / total) * 100).toFixed(0)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                                 Top tags                                    */
/* -------------------------------------------------------------------------- */

export function TopTagsChart({ tags, className }: { tags: Array<{ tag: string; count: number }>; className?: string }) {
  if (tags.length === 0) {
    return (
      <div className={className}>
        <EmptyState title="No tags yet" description="Tag memories to see which topics dominate." />
      </div>
    );
  }

  const data = tags.slice(0, 8);

  return (
    <div className={cn('h-56 w-full min-w-0', className)}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 12, left: 4, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" horizontal={false} opacity={0.4} />
          <XAxis type="number" tickLine={false} axisLine={false} {...AXIS_STYLE} tickFormatter={formatCompact} />
          <YAxis
            type="category"
            dataKey="tag"
            tickLine={false}
            axisLine={false}
            {...AXIS_STYLE}
            width={92}
mirror={false}
          />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--color-surface-overlay)' }} />
          <Bar dataKey="count" name="Memories" radius={[0, 4, 4, 0]} maxBarSize={18}>
            {data.map((_, index) => (
              <Cell
                key={index}
                // Fade successive bars so rank is legible without a legend.
                fill={`color-mix(in oklch, var(--color-accent) ${100 - index * 9}%, var(--color-surface-overlay))`}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                             Latency histogram                               */
/* -------------------------------------------------------------------------- */

export function LatencyChart({
  histogram,
  className,
}: {
  histogram: { p50: number; p95: number; p99: number; max: number; mean: number; count: number } | undefined;
  className?: string;
}) {
  if (!histogram || histogram.count === 0) {
    return (
      <div className={className}>
        <EmptyState title="No requests recorded" description="Latency percentiles appear after traffic arrives." />
      </div>
    );
  }

  const data = [
    { label: 'mean', value: histogram.mean },
    { label: 'p50', value: histogram.p50 },
    { label: 'p95', value: histogram.p95 },
    { label: 'p99', value: histogram.p99 },
    { label: 'max', value: histogram.max },
  ];

  return (
    <div className={cn('h-40 w-full min-w-0', className)}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: -24, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} opacity={0.4} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} {...AXIS_STYLE} />
          <YAxis tickLine={false} axisLine={false} {...AXIS_STYLE} width={44} unit="ms" />
          <Tooltip
            content={<ChartTooltip valueFormatter={(value) => `${value.toFixed(2)} ms`} />}
            cursor={{ fill: 'var(--color-surface-overlay)' }}
          />
          <Bar dataKey="value" name="Latency" radius={[4, 4, 0, 0]} maxBarSize={40}>
            {data.map((entry, index) => (
              <Cell
                key={index}
                // Tail latencies shift toward the warning hue — the eye should
                // land on p99 before the mean.
                fill={
                  entry.label === 'p99' || entry.label === 'max'
                    ? 'var(--color-warning)'
                    : 'var(--color-accent)'
                }
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                                 Sparkline                                   */
/* -------------------------------------------------------------------------- */

export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  if (values.length < 2) return <div className={cn('h-8', className)} />;

  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;

  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * 100;
      const y = 100 - ((value - min) / range) * 100;
      return `${x},${y}`;
    })
    .join(' ');

  return (
    <svg
      className={cn('h-8 w-full overflow-visible', className)}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden
    >
      <polyline
        points={points}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
