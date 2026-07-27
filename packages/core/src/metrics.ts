/**
 * Lightweight in-process metrics.
 *
 * Counters and latency histograms with no dependencies and no background
 * timers. Histograms use fixed exponential buckets so quantiles are computable
 * without retaining every sample — the same approach Prometheus uses, and the
 * reason memory stays constant regardless of traffic.
 */

/** Bucket upper bounds in milliseconds, spanning sub-millisecond to 30s. */
const DEFAULT_BUCKETS = [0.5, 1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000];

export interface HistogramSnapshot {
  count: number;
  sum: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  buckets: Array<{ le: number; count: number }>;
}

export class Histogram {
  private readonly bounds: number[];
  private readonly counts: number[];
  private sum = 0;
  private total = 0;
  private minValue = Infinity;
  private maxValue = -Infinity;

  constructor(bounds: number[] = DEFAULT_BUCKETS) {
    this.bounds = bounds;
    // One extra bucket for the +Inf overflow.
    this.counts = new Array<number>(bounds.length + 1).fill(0);
  }

  observe(value: number): void {
    this.sum += value;
    this.total++;
    if (value < this.minValue) this.minValue = value;
    if (value > this.maxValue) this.maxValue = value;

    // Linear scan: with ~15 buckets this beats a binary search in practice.
    let index = this.bounds.length;
    for (let i = 0; i < this.bounds.length; i++) {
      if (value <= (this.bounds[i] as number)) {
        index = i;
        break;
      }
    }
    this.counts[index] = (this.counts[index] as number) + 1;
  }

  /**
   * Quantile by linear interpolation inside the containing bucket. Accurate to
   * bucket width, which is what a bucketed histogram can offer.
   */
  private quantile(q: number): number {
    if (this.total === 0) return 0;
    const target = q * this.total;
    let cumulative = 0;

    for (let i = 0; i < this.counts.length; i++) {
      const bucketCount = this.counts[i] as number;
      if (cumulative + bucketCount >= target) {
        const lower = i === 0 ? 0 : (this.bounds[i - 1] as number);
        const upper = i < this.bounds.length ? (this.bounds[i] as number) : this.maxValue;
        if (bucketCount === 0) return upper;
        const fraction = (target - cumulative) / bucketCount;
        return lower + (upper - lower) * fraction;
      }
      cumulative += bucketCount;
    }
    return this.maxValue === -Infinity ? 0 : this.maxValue;
  }

  snapshot(): HistogramSnapshot {
    return {
      count: this.total,
      sum: this.sum,
      min: this.minValue === Infinity ? 0 : this.minValue,
      max: this.maxValue === -Infinity ? 0 : this.maxValue,
      mean: this.total === 0 ? 0 : this.sum / this.total,
      p50: this.quantile(0.5),
      p90: this.quantile(0.9),
      p95: this.quantile(0.95),
      p99: this.quantile(0.99),
      buckets: this.bounds.map((le, i) => ({ le, count: this.counts[i] as number })),
    };
  }

  reset(): void {
    this.counts.fill(0);
    this.sum = 0;
    this.total = 0;
    this.minValue = Infinity;
    this.maxValue = -Infinity;
  }
}

export interface MetricsSnapshot {
  counters: Record<string, number>;
  histograms: Record<string, HistogramSnapshot>;
  gauges: Record<string, number>;
  uptimeMs: number;
}

export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly histograms = new Map<string, Histogram>();
  private readonly gauges = new Map<string, number>();
  private readonly startedAt = Date.now();

  increment(name: string, value = 1, labels?: Record<string, string>): void {
    const key = this.key(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  observe(name: string, valueMs: number, labels?: Record<string, string>): void {
    const key = this.key(name, labels);
    let histogram = this.histograms.get(key);
    if (!histogram) {
      histogram = new Histogram();
      this.histograms.set(key, histogram);
    }
    histogram.observe(valueMs);
  }

  gauge(name: string, value: number, labels?: Record<string, string>): void {
    this.gauges.set(this.key(name, labels), value);
  }

  /** Time an async operation, recording latency and success/failure counters. */
  async time<T>(name: string, fn: () => Promise<T>, labels?: Record<string, string>): Promise<T> {
    const startedAt = performance.now();
    try {
      const result = await fn();
      this.observe(name, performance.now() - startedAt, labels);
      this.increment(`${name}.success`, 1, labels);
      return result;
    } catch (err) {
      this.observe(name, performance.now() - startedAt, labels);
      this.increment(`${name}.error`, 1, labels);
      throw err;
    }
  }

  snapshot(): MetricsSnapshot {
    return {
      counters: Object.fromEntries(this.counters),
      histograms: Object.fromEntries(
        Array.from(this.histograms, ([key, histogram]) => [key, histogram.snapshot()]),
      ),
      gauges: Object.fromEntries(this.gauges),
      uptimeMs: Date.now() - this.startedAt,
    };
  }

  reset(): void {
    this.counters.clear();
    this.histograms.clear();
    this.gauges.clear();
  }

  /** Render as Prometheus text exposition format. */
  toPrometheus(prefix = 'memorydb'): string {
    const lines: string[] = [];

    for (const [key, value] of this.counters) {
      const { name, labels } = this.parseKey(key);
      lines.push(`${prefix}_${sanitize(name)}_total${labels} ${value}`);
    }
    for (const [key, value] of this.gauges) {
      const { name, labels } = this.parseKey(key);
      lines.push(`${prefix}_${sanitize(name)}${labels} ${value}`);
    }
    for (const [key, histogram] of this.histograms) {
      const { name, labels } = this.parseKey(key);
      const snapshot = histogram.snapshot();
      const base = `${prefix}_${sanitize(name)}_milliseconds`;
      let cumulative = 0;
      for (const bucket of snapshot.buckets) {
        cumulative += bucket.count;
        lines.push(`${base}_bucket${mergeLabels(labels, `le="${bucket.le}"`)} ${cumulative}`);
      }
      lines.push(`${base}_bucket${mergeLabels(labels, 'le="+Inf"')} ${snapshot.count}`);
      lines.push(`${base}_sum${labels} ${snapshot.sum}`);
      lines.push(`${base}_count${labels} ${snapshot.count}`);
    }

    return `${lines.join('\n')}\n`;
  }

  private key(name: string, labels?: Record<string, string>): string {
    if (!labels || Object.keys(labels).length === 0) return name;
    // Sort so label order can't create duplicate series for the same metric.
    const serialized = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');
    return `${name}{${serialized}}`;
  }

  private parseKey(key: string): { name: string; labels: string } {
    const braceIndex = key.indexOf('{');
    if (braceIndex === -1) return { name: key, labels: '' };
    return { name: key.slice(0, braceIndex), labels: key.slice(braceIndex) };
  }
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

function mergeLabels(existing: string, extra: string): string {
  if (!existing) return `{${extra}}`;
  return `${existing.slice(0, -1)},${extra}}`;
}

/** Shared process-wide metrics registry. */
export const metrics = new Metrics();
