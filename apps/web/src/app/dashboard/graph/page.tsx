'use client';

/**
 * Knowledge graph explorer.
 */
import * as React from 'react';
import { toast } from 'sonner';
import { GitGraph, Search } from 'lucide-react';
import { ENTITY_TYPES, type Entity, type KnowledgeGraph } from '@memorydb/core';
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
  Skeleton,
} from '@/components/ui/primitives';
import { KnowledgeGraphView } from '@/components/dashboard/knowledge-graph';
import { cn, ENTITY_TYPE_COLORS, formatNumber, formatRelativeTime } from '@/lib/utils';

export default function GraphPage() {
  const [graph, setGraph] = React.useState<KnowledgeGraph | null>(null);
  const [entities, setEntities] = React.useState<Entity[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [typeFilter, setTypeFilter] = React.useState<string[]>([]);
  const [search, setSearch] = React.useState('');
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const [graphResult, entitiesResult] = await Promise.all([
        api.graph({
          maxNodes: 120,
          ...(typeFilter.length > 0 ? { types: typeFilter } : {}),
          ...(search ? { search } : {}),
        }),
        api.entities({
          limit: 20,
          sortBy: 'mentionCount',
          ...(typeFilter.length > 0 ? { type: typeFilter } : {}),
          ...(search ? { search } : {}),
        }),
      ]);
      setGraph(graphResult);
      setEntities(entitiesResult.items);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load the graph');
    } finally {
      setLoading(false);
    }
  }, [typeFilter, search]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const selected = React.useMemo(
    () => graph?.nodes.find((node) => node.id === selectedId) ?? null,
    [graph, selectedId],
  );

  const connections = React.useMemo(() => {
    if (!graph || !selectedId) return [];
    return graph.edges
      .filter((edge) => edge.sourceId === selectedId || edge.targetId === selectedId)
      .map((edge) => ({
        type: edge.type,
        weight: edge.weight,
        other: edge.sourceId === selectedId ? edge.targetName : edge.sourceName,
        direction: edge.sourceId === selectedId ? ('out' as const) : ('in' as const),
      }))
      .sort((a, b) => b.weight - a.weight);
  }, [graph, selectedId]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Knowledge graph</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Entities and relationships extracted automatically from stored memories.
          </p>
        </div>
        {graph && (
          <div className="flex gap-2">
            <Badge>{formatNumber(graph.stats.nodeCount)} entities</Badge>
            <Badge>{formatNumber(graph.stats.edgeCount)} relations</Badge>
            <Badge>density {graph.stats.density.toFixed(3)}</Badge>
          </div>
        )}
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-56 flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-[var(--color-fg-subtle)]" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter entities…"
            className="pl-8"
            aria-label="Filter entities"
          />
        </div>

        <div className="flex flex-wrap gap-1.5">
          {ENTITY_TYPES.slice(0, 8).map((type) => {
            const active = typeFilter.includes(type);
            return (
              <button
                key={type}
                onClick={() =>
                  setTypeFilter((current) =>
                    current.includes(type) ? current.filter((item) => item !== type) : [...current, type],
                  )
                }
                aria-pressed={active}
                className={cn(
                  'flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs capitalize transition-colors',
                  active
                    ? 'border-transparent text-[var(--color-fg)]'
                    : 'border-[var(--color-border)] text-[var(--color-fg-muted)] hover:border-[var(--color-border-strong)]',
                )}
                style={
                  active
                    ? { backgroundColor: `color-mix(in oklch, ${ENTITY_TYPE_COLORS[type]} 18%, transparent)` }
                    : undefined
                }
              >
                <span
                  className="size-1.5 rounded-full"
                  style={{ backgroundColor: ENTITY_TYPE_COLORS[type] }}
                  aria-hidden
                />
                {type}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-4">
        <Card className="overflow-hidden lg:col-span-3">
          <KnowledgeGraphView graph={graph} loading={loading} onSelectEntity={setSelectedId} />
        </Card>

        <div className="space-y-4">
          {selected ? (
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <span
                    className="size-2.5 rounded-full"
                    style={{ backgroundColor: ENTITY_TYPE_COLORS[selected.type] }}
                    aria-hidden
                  />
                  <CardTitle className="truncate">{selected.name}</CardTitle>
                </div>
                <CardDescription className="capitalize">
                  {selected.type} · {selected.mentionCount} mentions · degree {selected.degree}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {selected.aliases.length > 0 && (
                  <div>
                    <p className="mb-1 text-[11px] text-[var(--color-fg-subtle)]">Also known as</p>
                    <p className="text-xs">{selected.aliases.join(', ')}</p>
                  </div>
                )}

                <div>
                  <p className="mb-1.5 text-[11px] text-[var(--color-fg-subtle)]">
                    Connections ({connections.length})
                  </p>
                  <ul className="max-h-64 space-y-1.5 overflow-auto">
                    {connections.map((connection, index) => (
                      <li key={index} className="flex items-center gap-1.5 text-xs">
                        <span className="text-[var(--color-fg-subtle)]">
                          {connection.direction === 'out' ? '→' : '←'}
                        </span>
                        <span className="truncate text-[var(--color-fg)]">{connection.other}</span>
                        <Badge className="ml-auto shrink-0">{connection.type.replace(/_/g, ' ')}</Badge>
                      </li>
                    ))}
                  </ul>
                </div>

                <p className="text-[11px] text-[var(--color-fg-subtle)]">
                  Last seen {formatRelativeTime(selected.lastSeenAt)}
                </p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Top entities</CardTitle>
                <CardDescription>Click a node to inspect it</CardDescription>
              </CardHeader>
              <CardContent>
                {loading ? (
                  <div className="space-y-2">
                    {Array.from({ length: 8 }).map((_, index) => (
                      <Skeleton key={index} className="h-6" />
                    ))}
                  </div>
                ) : entities.length === 0 ? (
                  <EmptyState icon={<GitGraph />} title="No entities" description="Store memories to build the graph." />
                ) : (
                  <ul className="space-y-1.5">
                    {entities.map((entity) => (
                      <li key={entity.id}>
                        <button
                          onClick={() => setSelectedId(entity.id)}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-[var(--color-surface-raised)]"
                        >
                          <span
                            className="size-2 shrink-0 rounded-full"
                            style={{ backgroundColor: ENTITY_TYPE_COLORS[entity.type] }}
                            aria-hidden
                          />
                          <span className="truncate text-[var(--color-fg)]">{entity.name}</span>
                          <span className="tabular ml-auto shrink-0 text-[var(--color-fg-subtle)]">
                            {entity.mentionCount}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          )}

          {selected && (
            <Button variant="secondary" className="w-full" onClick={() => setSelectedId(null)}>
              Back to all entities
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
