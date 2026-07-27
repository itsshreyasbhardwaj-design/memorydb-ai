'use client';

/**
 * Search explorer — run hybrid queries and inspect exactly how each result scored.
 */
import * as React from 'react';
import { toast } from 'sonner';
import { Search as SearchIcon, SlidersHorizontal, Sparkles } from 'lucide-react';
import type { RetrieveResult, SearchResult } from '@memorydb/core';
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
  Input,
  Progress,
  Spinner,
  TypeBadge,
} from '@/components/ui/primitives';
import { cn, formatDuration, formatPercent, formatRelativeTime } from '@/lib/utils';

const MODES = ['hybrid', 'semantic', 'keyword'] as const;

export default function SearchPage() {
  const [query, setQuery] = React.useState('');
  const [mode, setMode] = React.useState<(typeof MODES)[number]>('hybrid');
  const [minScore, setMinScore] = React.useState(0);
  const [searching, setSearching] = React.useState(false);
  const [result, setResult] = React.useState<SearchResult | null>(null);
  const [retrieved, setRetrieved] = React.useState<RetrieveResult | null>(null);
  const [showContext, setShowContext] = React.useState(false);

  const runSearch = React.useCallback(
    async (event?: React.FormEvent) => {
      event?.preventDefault();
      if (!query.trim()) return;

      setSearching(true);
      setRetrieved(null);
      try {
        const response = await api.search({ query, mode, limit: 20, explain: true, minScore });
        setResult(response);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Search failed');
      } finally {
        setSearching(false);
      }
    },
    [query, mode, minScore],
  );

  const runRetrieve = async (): Promise<void> => {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const response = await api.retrieve({ query, limit: 10, tokenBudget: 2000, diversify: true });
      setRetrieved(response);
      setShowContext(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Retrieval failed');
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Search</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Hybrid vector + keyword retrieval with a full score breakdown for every hit.
        </p>
      </header>

      <Card>
        <CardContent className="pt-5">
          <form onSubmit={runSearch} className="space-y-4">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <SearchIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--color-fg-subtle)]" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="What do you want to remember?"
                  className="h-11 pl-9 text-base"
                  aria-label="Search query"
                  autoFocus
                />
              </div>
              <Button type="submit" variant="primary" size="lg" disabled={searching || !query.trim()}>
                {searching ? <Spinner className="size-4" /> : <SearchIcon />}
                Search
              </Button>
              <Button type="button" variant="secondary" size="lg" onClick={runRetrieve} disabled={searching || !query.trim()}>
                <Sparkles />
                Retrieve
              </Button>
            </div>

            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-1.5">
                <SlidersHorizontal className="size-3.5 text-[var(--color-fg-subtle)]" />
                <span className="text-xs text-[var(--color-fg-subtle)]">Mode</span>
                <div className="flex rounded-[var(--radius-control)] border border-[var(--color-border)] p-0.5">
                  {MODES.map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setMode(option)}
                      className={cn(
                        'rounded-md px-2.5 py-1 text-xs capitalize transition-colors',
                        mode === option
                          ? 'bg-[var(--color-accent)] font-medium text-[var(--color-canvas)]'
                          : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]',
                      )}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </div>

              <label className="flex items-center gap-2 text-xs text-[var(--color-fg-subtle)]">
                Min score
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={minScore}
                  onChange={(event) => setMinScore(Number(event.target.value))}
                  className="w-28 accent-[var(--color-accent)]"
                />
                <span className="tabular w-8 text-[var(--color-fg)]">{minScore.toFixed(2)}</span>
              </label>
            </div>
          </form>
        </CardContent>
      </Card>

      {retrieved && showContext && (
        <Card>
          <CardHeader className="flex-row items-start justify-between">
            <div>
              <CardTitle>Model-ready context</CardTitle>
              <CardDescription>
                {retrieved.tokensUsed} tokens · {retrieved.citations.length} citations ·{' '}
                {retrieved.dropped} dropped as redundant · confidence {formatPercent(retrieved.confidence)}
              </CardDescription>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setShowContext(false)}>
              Hide
            </Button>
          </CardHeader>
          <CardContent>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--color-surface-raised)] p-4 font-mono text-xs leading-relaxed text-[var(--color-fg-muted)]">
              {retrieved.context || 'No context produced.'}
            </pre>
          </CardContent>
        </Card>
      )}

      {result && (
        <div className="space-y-3">
          <div className="flex items-center justify-between text-sm">
            <p className="text-[var(--color-fg-muted)]">
              <span className="font-medium text-[var(--color-fg)]">{result.total}</span> results for{' '}
              <span className="font-mono text-[var(--color-fg)]">&ldquo;{result.query}&rdquo;</span>
            </p>
            <Badge>{formatDuration(result.tookMs)}</Badge>
          </div>

          {result.hits.length === 0 ? (
            <Card>
              <EmptyState
                icon={<SearchIcon />}
                title="No matches"
                description={
                  minScore > 0
                    ? `Nothing scored above ${minScore.toFixed(2)}. Try lowering the minimum score.`
                    : 'Try different wording, or switch to keyword mode for exact terms.'
                }
              />
            </Card>
          ) : (
            <ul className="space-y-3">
              {result.hits.map((hit) => (
                <li key={hit.memory.id}>
                  <Card className="p-4">
                    <div className="flex items-start gap-4">
                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="tabular text-xs font-medium text-[var(--color-fg-subtle)]">
                            #{hit.rank}
                          </span>
                          <TypeBadge type={hit.memory.type} />
                          {hit.memory.title && <span className="text-sm font-medium">{hit.memory.title}</span>}
                        </div>

                        <p className="text-sm leading-relaxed text-[var(--color-fg-muted)]">
                          {hit.citation.snippet}
                        </p>

                        <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--color-fg-subtle)]">
                          <span>{formatRelativeTime(hit.memory.createdAt)}</span>
                          <span>·</span>
                          <span>{hit.memory.tokens} tokens</span>
                          {hit.memory.tags.length > 0 && (
                            <>
                              <span>·</span>
                              <span>{hit.memory.tags.join(', ')}</span>
                            </>
                          )}
                        </div>
                      </div>

                      <div className="w-40 shrink-0 space-y-2">
                        <div>
                          <div className="flex items-baseline justify-between">
                            <span className="text-[11px] text-[var(--color-fg-subtle)]">score</span>
                            <span className="tabular text-sm font-semibold">{hit.score.toFixed(3)}</span>
                          </div>
                          <Progress value={hit.score} className="mt-1" />
                        </div>

                        {hit.scores && (
                          <dl className="space-y-1 text-[10px]">
                            {(
                              [
                                ['vector', hit.scores.vector, 'var(--color-accent)'],
                                ['keyword', hit.scores.keyword, 'var(--color-type-episodic)'],
                                ['recency', hit.scores.recency, 'var(--color-success)'],
                                ['importance', hit.scores.importance, 'var(--color-warning)'],
                              ] as const
                            ).map(([label, value, color]) => (
                              <div key={label} className="flex items-center gap-1.5">
                                <dt className="w-14 text-[var(--color-fg-subtle)]">{label}</dt>
                                <dd className="flex-1">
                                  <Progress value={value} className="h-1" color={color} />
                                </dd>
                                <span className="tabular w-7 text-right text-[var(--color-fg-subtle)]">
                                  {value.toFixed(2)}
                                </span>
                              </div>
                            ))}
                          </dl>
                        )}
                      </div>
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!result && !searching && (
        <Card>
          <EmptyState
            icon={<SearchIcon />}
            title="Run a search"
            description="Search combines dense vector similarity with BM25 keyword matching, then re-ranks by recency, importance, confidence, and usage."
          />
        </Card>
      )}
    </div>
  );
}
