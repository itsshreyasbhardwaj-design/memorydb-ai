import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge class names, resolving conflicting Tailwind utilities in favour of the last. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Compact number formatting: 1_234 -> "1.2k". */
export function formatCompact(value: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('en').format(value);
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, exponent);
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function formatPercent(value: number, digits = 0): string {
  return `${(value * 100).toFixed(digits)}%`;
}

/** Human-readable relative time: "3 hours ago", "in 2 days". */
export function formatRelativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return 'unknown';

  const deltaSeconds = (timestamp - Date.now()) / 1000;
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

  const thresholds: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
  ];

  for (const [unit, seconds] of thresholds) {
    if (Math.abs(deltaSeconds) >= seconds) {
      return formatter.format(Math.round(deltaSeconds / seconds), unit);
    }
  }
  return formatter.format(Math.round(deltaSeconds), 'second');
}

export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(
    new Date(iso),
  );
}

export function formatDuration(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 1 : 0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Truncate on a word boundary for display. */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(' ');
  return `${(lastSpace > maxChars * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd()}…`;
}

/** CSS custom property holding a memory type's colour. */
export function memoryTypeColor(type: string): string {
  return `var(--color-type-${type.replace(/_/g, '-')})`;
}

export const MEMORY_TYPE_LABELS: Record<string, string> = {
  short_term: 'Short-term',
  long_term: 'Long-term',
  working: 'Working',
  semantic: 'Semantic',
  episodic: 'Episodic',
  procedural: 'Procedural',
  graph: 'Graph',
};

export const ENTITY_TYPE_COLORS: Record<string, string> = {
  person: 'var(--color-type-semantic)',
  project: 'var(--color-type-long-term)',
  concept: 'var(--color-type-episodic)',
  file: 'var(--color-fg-subtle)',
  organization: 'var(--color-type-procedural)',
  event: 'var(--color-type-working)',
  location: 'var(--color-type-graph)',
  product: 'var(--color-accent-strong)',
  technology: 'var(--color-accent)',
  other: 'var(--color-fg-subtle)',
};

/** Trailing-edge debounce, for search-as-you-type inputs. */
export function debounce<T extends (...args: never[]) => void>(fn: T, delayMs: number): T & { cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const debounced = ((...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...(args as never[])), delayMs);
  }) as T & { cancel(): void };

  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
  };
  return debounced;
}
