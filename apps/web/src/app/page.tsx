import Link from 'next/link';
import {
  ArrowRight,
  Brain,
  Clock,
  Database,
  GitGraph,
  Layers,
  Lock,
  Search,
  Sparkles,
  Zap,
} from 'lucide-react';
import { Badge, Button, Card } from '@/components/ui/primitives';

const FEATURES = [
  {
    icon: Search,
    title: 'Hybrid retrieval',
    body: 'Dense vector similarity fused with BM25 lexical matching via Reciprocal Rank Fusion, then re-ranked by recency, importance, confidence, and usage.',
  },
  {
    icon: Layers,
    title: 'Seven memory types',
    body: 'Short-term, working, long-term, semantic, episodic, procedural, and graph memory — each with its own retention strategy and retrieval prior.',
  },
  {
    icon: GitGraph,
    title: 'Automatic knowledge graph',
    body: 'People, projects, organizations, technologies, and events are extracted and linked as you write, with no extra calls.',
  },
  {
    icon: Sparkles,
    title: 'Self-maintaining',
    body: 'Consolidation merges duplicates, summarises old conversations, archives stale entries, and clusters topics on a schedule.',
  },
  {
    icon: Clock,
    title: 'Retention policies',
    body: 'Scratch memory expires in an hour; a learned procedure never does. Every policy is configurable per type or per write.',
  },
  {
    icon: Lock,
    title: 'Secure by default',
    body: 'Namespace isolation enforced by row-level security, constant-time key comparison, strict validation, and rate limiting.',
  },
] as const;

const CODE_SAMPLE = `import { MemoryClient } from '@memorydb/core';

const memory = await MemoryClient.create();

await memory.store({
  content: 'Ada prefers async written updates over standups.',
  type: 'semantic',
  tags: ['people', 'preferences'],
});

const { context, citations, confidence } = await memory.retrieve({
  query: 'How should I communicate with Ada?',
  tokenBudget: 2000,
});

// context  → model-ready block with [1] citation markers
// citations → resolvable back to memory ids`;

export default function LandingPage() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-16 lg:py-24">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-[var(--color-accent)] to-[var(--color-accent-strong)]">
            <Brain className="size-5 text-[var(--color-canvas)]" />
          </div>
          <span className="text-base font-semibold tracking-tight">MemoryDB AI</span>
        </div>

        <nav className="flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild>
            <a href="/api/v1/openapi" target="_blank" rel="noreferrer">
              API
            </a>
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <a
              href="https://github.com/itsshreyasbhardwaj-design/memorydb-ai"
              target="_blank"
              rel="noreferrer"
            >
              GitHub
            </a>
          </Button>
          <Button variant="primary" size="sm" asChild>
            <Link href="/dashboard">Dashboard</Link>
          </Button>
        </nav>
      </header>

      <section className="py-20 lg:py-28">
        <Badge variant="accent" className="mb-6">
          <Zap className="size-3" />
          Runs with zero API keys and zero cost by default
        </Badge>

        <h1 className="max-w-3xl text-balance text-5xl font-semibold leading-[1.05] tracking-tight lg:text-6xl">
          Every AI assistant <span className="text-gradient">forgets</span>. Yours doesn&rsquo;t have to.
        </h1>

        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-[var(--color-fg-muted)]">
          MemoryDB AI is production-ready long-term memory infrastructure for AI agents. Store
          conversations, documents, and knowledge — then retrieve exactly what matters, with citations,
          in a few lines of code.
        </p>

        <div className="mt-9 flex flex-wrap gap-3">
          <Button variant="primary" size="lg" asChild>
            <Link href="/dashboard">
              Open the dashboard <ArrowRight />
            </Link>
          </Button>
          <Button variant="outline" size="lg" asChild>
            <a
              href="https://github.com/itsshreyasbhardwaj-design/memorydb-ai#quickstart"
              target="_blank"
              rel="noreferrer"
            >
              Read the quickstart
            </a>
          </Button>
        </div>

        <dl className="mt-14 grid max-w-2xl grid-cols-2 gap-6 sm:grid-cols-4">
          {[
            ['7', 'memory types'],
            ['3', 'retrieval modes'],
            ['6', 'import/export formats'],
            ['$0', 'to run locally'],
          ].map(([value, label]) => (
            <div key={label}>
              <dt className="text-2xl font-semibold tracking-tight">{value}</dt>
              <dd className="mt-0.5 text-xs text-[var(--color-fg-subtle)]">{label}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card className="overflow-hidden p-0">
          <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2.5">
            <div className="flex gap-1.5" aria-hidden>
              <span className="size-2.5 rounded-full bg-[var(--color-danger)]" />
              <span className="size-2.5 rounded-full bg-[var(--color-warning)]" />
              <span className="size-2.5 rounded-full bg-[var(--color-success)]" />
            </div>
            <span className="ml-2 font-mono text-[11px] text-[var(--color-fg-subtle)]">agent.ts</span>
          </div>
          <pre className="overflow-x-auto p-5 font-mono text-xs leading-relaxed text-[var(--color-fg-muted)]">
            <code>{CODE_SAMPLE}</code>
          </pre>
        </Card>

        <div className="grid gap-4 sm:grid-cols-2">
          {FEATURES.slice(0, 4).map((feature) => (
            <Card key={feature.title} className="p-5">
              <feature.icon className="size-5 text-[var(--color-accent)]" />
              <h3 className="mt-3 text-sm font-semibold">{feature.title}</h3>
              <p className="mt-1.5 text-xs leading-relaxed text-[var(--color-fg-subtle)]">{feature.body}</p>
            </Card>
          ))}
        </div>
      </section>

      <section className="mt-4 grid gap-4 sm:grid-cols-2">
        {FEATURES.slice(4).map((feature) => (
          <Card key={feature.title} className="p-5">
            <feature.icon className="size-5 text-[var(--color-accent)]" />
            <h3 className="mt-3 text-sm font-semibold">{feature.title}</h3>
            <p className="mt-1.5 text-xs leading-relaxed text-[var(--color-fg-subtle)]">{feature.body}</p>
          </Card>
        ))}
      </section>

      <section className="mt-20">
        <h2 className="text-2xl font-semibold tracking-tight">Built on a stack you already trust</h2>
        <p className="mt-2 max-w-2xl text-sm text-[var(--color-fg-muted)]">
          PostgreSQL with pgvector and HNSW indexes for scale, Next.js for the API and dashboard, and a
          storage-agnostic core that runs entirely in memory when you just want to try it.
        </p>

        <div className="mt-6 flex flex-wrap gap-2">
          {[
            'TypeScript', 'Next.js 15', 'PostgreSQL', 'pgvector', 'HNSW', 'Supabase',
            'Tailwind CSS', 'Vitest', 'Playwright', 'Vercel',
          ].map((item) => (
            <Badge key={item}>{item}</Badge>
          ))}
        </div>
      </section>

      <footer className="mt-24 flex flex-wrap items-center justify-between gap-4 border-t border-[var(--color-border)] pt-8 text-xs text-[var(--color-fg-subtle)]">
        <p className="flex items-center gap-1.5">
          <Database className="size-3.5" />
          MemoryDB AI — MIT licensed open-source infrastructure
        </p>
        <div className="flex gap-4">
          <a className="hover:text-[var(--color-fg)]" href="/api/v1/openapi" target="_blank" rel="noreferrer">
            API reference
          </a>
          <a
            className="hover:text-[var(--color-fg)]"
            href="https://github.com/itsshreyasbhardwaj-design/memorydb-ai"
            target="_blank"
            rel="noreferrer"
          >
            Source
          </a>
        </div>
      </footer>
    </div>
  );
}
