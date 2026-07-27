'use client';

/**
 * Memory browser — list, filter, create, and delete memories.
 */
import * as React from 'react';
import { toast } from 'sonner';
import { Database, Download, Plus, Trash2, Upload, X } from 'lucide-react';
import { MEMORY_TYPES, type Memory } from '@memorydb/core';
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
  Textarea,
  TypeBadge,
} from '@/components/ui/primitives';
import { cn, formatNumber, formatRelativeTime, MEMORY_TYPE_LABELS, truncateText } from '@/lib/utils';

const PAGE_SIZE = 20;

export default function MemoriesPage() {
  const [memories, setMemories] = React.useState<Memory[]>([]);
  const [total, setTotal] = React.useState(0);
  const [offset, setOffset] = React.useState(0);
  const [typeFilter, setTypeFilter] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [creating, setCreating] = React.useState(false);
  const [expanded, setExpanded] = React.useState<string | null>(null);

  const [draft, setDraft] = React.useState({
    content: '',
    title: '',
    type: 'long_term',
    tags: '',
  });

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const page = await api.listMemories({
        limit: PAGE_SIZE,
        offset,
        sortBy: 'createdAt',
        sortDir: 'desc',
        ...(typeFilter.length > 0 ? { type: typeFilter } : {}),
      });
      setMemories(page.items);
      setTotal(page.total);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load memories');
    } finally {
      setLoading(false);
    }
  }, [offset, typeFilter]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const createMemory = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!draft.content.trim()) return;

    try {
      const result = await api.createMemory({
        content: draft.content,
        type: draft.type,
        ...(draft.title ? { title: draft.title } : {}),
        tags: draft.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      });

      toast.success(result.deduplicated ? 'Matched an existing memory' : 'Memory stored', {
        description: result.entitiesExtracted
          ? `${result.entitiesExtracted} entities extracted into the graph`
          : undefined,
      });

      setDraft({ content: '', title: '', type: 'long_term', tags: '' });
      setCreating(false);
      setOffset(0);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to store memory');
    }
  };

  const deleteMemory = async (id: string): Promise<void> => {
    try {
      await api.deleteMemory(id);
      toast.success('Memory deleted');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete');
    }
  };

  const handleImport = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const result = await api.importFile(file);
      toast.success('Import complete', {
        description: `${result.imported} imported · ${result.deduplicated} duplicates · ${result.failed} failed`,
      });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Import failed');
    } finally {
      event.target.value = '';
    }
  };

  const toggleType = (type: string): void => {
    setOffset(0);
    setTypeFilter((current) =>
      current.includes(type) ? current.filter((item) => item !== type) : [...current, type],
    );
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Memories</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            {formatNumber(total)} {total === 1 ? 'memory' : 'memories'} stored
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" asChild>
            <label className="cursor-pointer">
              <Upload />
              Import
              <input
                type="file"
                className="sr-only"
                accept=".json,.jsonl,.csv,.md,.markdown,.txt,.zip"
                onChange={handleImport}
              />
            </label>
          </Button>
          <Button variant="secondary" asChild>
            <a href={api.exportUrl({ format: 'zip', includeGraph: true })} download>
              <Download />
              Export
            </a>
          </Button>
          <Button variant="primary" onClick={() => setCreating((value) => !value)}>
            {creating ? <X /> : <Plus />}
            {creating ? 'Cancel' : 'New memory'}
          </Button>
        </div>
      </header>

      {creating && (
        <Card>
          <CardHeader>
            <CardTitle>Store a memory</CardTitle>
            <CardDescription>
              Content is embedded on write, and entities are extracted into the knowledge graph automatically.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={createMemory} className="space-y-3">
              <Textarea
                value={draft.content}
                onChange={(event) => setDraft({ ...draft, content: event.target.value })}
                placeholder="What should be remembered?"
                required
                rows={4}
                aria-label="Memory content"
              />
              <div className="grid gap-3 sm:grid-cols-3">
                <Input
                  value={draft.title}
                  onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                  placeholder="Title (optional)"
                  aria-label="Title"
                />
                <select
                  value={draft.type}
                  onChange={(event) => setDraft({ ...draft, type: event.target.value })}
                  aria-label="Memory type"
                  className="h-9 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 text-sm focus:border-[var(--color-accent)] focus:outline-none"
                >
                  {MEMORY_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {MEMORY_TYPE_LABELS[type] ?? type}
                    </option>
                  ))}
                </select>
                <Input
                  value={draft.tags}
                  onChange={(event) => setDraft({ ...draft, tags: event.target.value })}
                  placeholder="tags, comma, separated"
                  aria-label="Tags"
                />
              </div>
              <Button type="submit" variant="primary" disabled={!draft.content.trim()}>
                Store memory
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap gap-1.5">
        {MEMORY_TYPES.map((type) => (
          <button
            key={type}
            onClick={() => toggleType(type)}
            aria-pressed={typeFilter.includes(type)}
            className={cn(
              'rounded-md border px-2.5 py-1 text-xs transition-colors',
              typeFilter.includes(type)
                ? 'border-[var(--color-accent)] bg-[color-mix(in_oklch,var(--color-accent)_15%,transparent)] text-[var(--color-accent)]'
                : 'border-[var(--color-border)] text-[var(--color-fg-muted)] hover:border-[var(--color-border-strong)]',
            )}
          >
            {MEMORY_TYPE_LABELS[type] ?? type}
          </button>
        ))}
        {typeFilter.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setTypeFilter([])}>
            <X /> Clear
          </Button>
        )}
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-24" />
          ))}
        </div>
      ) : memories.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Database />}
            title="No memories found"
            description={
              typeFilter.length > 0
                ? 'No memories match the selected types.'
                : 'Store your first memory to get started.'
            }
          />
        </Card>
      ) : (
        <ul className="space-y-3">
          {memories.map((memory) => {
            const isExpanded = expanded === memory.id;
            return (
              <li key={memory.id}>
                <Card className="p-4">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <TypeBadge type={memory.type} />
                        <Badge>{memory.kind}</Badge>
                        {memory.title && <span className="text-sm font-medium">{memory.title}</span>}
                        {memory.status !== 'active' && <Badge variant="warning">{memory.status}</Badge>}
                      </div>

                      <button
                        onClick={() => setExpanded(isExpanded ? null : memory.id)}
                        className="block w-full text-left text-sm leading-relaxed text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
                        aria-expanded={isExpanded}
                      >
                        {isExpanded ? memory.content : truncateText(memory.content, 220)}
                      </button>

                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--color-fg-subtle)]">
                        <span title={memory.createdAt}>{formatRelativeTime(memory.createdAt)}</span>
                        <span>{memory.tokens} tokens</span>
                        <span>importance {memory.importance.toFixed(2)}</span>
                        {memory.accessCount > 0 && <span>recalled {memory.accessCount}×</span>}
                        {memory.expiresAt && <span>expires {formatRelativeTime(memory.expiresAt)}</span>}
                        {memory.tags.map((tag) => (
                          <span key={tag} className="rounded bg-[var(--color-surface-overlay)] px-1.5 py-0.5">
                            {tag}
                          </span>
                        ))}
                      </div>

                      {isExpanded && (
                        <p className="font-mono text-[10px] text-[var(--color-fg-subtle)]">{memory.id}</p>
                      )}
                    </div>

                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => deleteMemory(memory.id)}
                      aria-label={`Delete memory ${memory.title ?? memory.id}`}
                      className="hover:text-[var(--color-danger)]"
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-[var(--color-fg-subtle)]">
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {formatNumber(total)}
          </p>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
