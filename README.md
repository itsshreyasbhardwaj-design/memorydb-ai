<div align="center">

# MemoryDB AI

**Long-term memory infrastructure for AI agents.**

Every AI assistant forgets. MemoryDB AI is the layer that stops it — store conversations,
documents, and knowledge, then retrieve exactly what matters, with citations, in a few lines of code.

[![CI](https://github.com/itsshreyasbhardwaj-design/memorydb-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/itsshreyasbhardwaj-design/memorydb-ai/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-06b6d4.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](tsconfig.base.json)
[![Tests](https://img.shields.io/badge/tests-266%20passing-22c55e.svg)](#testing)

[Quickstart](#quickstart) · [Features](#features) · [Architecture](#architecture) · [API](#api-reference) · [SDKs](#sdks) · [Benchmarks](#benchmarks) · [Deployment](#deployment)

</div>

---

## Why this exists

An LLM's context window is its entire world, and it resets every conversation. The usual fix —
bolting a vector database onto an app — solves storage but not _memory_: you get a pile of
undifferentiated chunks, no notion of what matters, no sense of when something became stale, and
retrieval that returns five near-identical passages while the one useful fact sits at rank 40.

MemoryDB AI treats memory as a first-class problem:

- **Not all memories are equal.** Seven cognitive types, each with its own retention policy and
  retrieval prior. Scratch notes expire in an hour; a learned procedure never does.
- **Relevance is not just similarity.** Hybrid retrieval fuses dense vectors with BM25, then
  re-ranks by recency, importance, confidence, and how often a memory has actually been useful.
- **Memory decays without maintenance.** Consolidation merges duplicates, summarises old
  conversations, archives stale entries, and clusters topics — automatically.
- **Facts have structure.** A knowledge graph of people, projects, technologies, and events builds
  itself as you write, with no extra API calls.

**It runs with zero API keys and zero cost.** The default embedding provider is local, offline, and
deterministic. Point it at a neural model when you want one — it is a one-line config change.

---

## Quickstart

### Embedded (no server, no database)

```bash
pnpm add @memorydb/core
```

```ts
import { MemoryClient } from "@memorydb/core";

const memory = await MemoryClient.create();

await memory.store({
  content: "Ada prefers async written updates over standups.",
  type: "semantic",
  tags: ["people", "preferences"],
});

const { context, citations, confidence } = await memory.retrieve({
  query: "How should I communicate with Ada?",
  tokenBudget: 2000,
});

console.log(context);
//  Relevant memories:
//
//  [1] people · preferences (2026-07-27)
//  Ada prefers async written updates over standups.
```

`context` drops straight into a prompt. `citations` maps each `[n]` marker back to a memory id, so
every claim your model makes is traceable to a stored fact.

### As a service

```bash
git clone https://github.com/itsshreyasbhardwaj-design/memorydb-ai.git
cd memorydb-ai
pnpm install
pnpm dev
```

Open <http://localhost:3000/dashboard>. There is no configuration step — the app starts with an
in-memory store, local embeddings, and a small demo corpus so the dashboard is never an empty shell.

---

## Features

### Memory types

Seven cognitive classes, each with distinct retention and ranking behaviour:

| Type         | Default TTL | On expiry | Consolidated | Retrieval prior |
| ------------ | ----------- | --------- | ------------ | --------------- |
| `short_term` | 1 hour      | expire    | no           | 0.75            |
| `working`    | 1 day       | summarise | yes          | 0.85            |
| `episodic`   | 90 days     | summarise | yes          | 0.95            |
| `long_term`  | never       | keep      | yes          | 1.00            |
| `semantic`   | never       | keep      | yes          | 1.00            |
| `procedural` | never       | keep      | no           | 1.00            |
| `graph`      | never       | keep      | no           | 0.90            |

Every policy is overridable per namespace or per write.

### Hybrid retrieval

```
query ──┬──▶ dense vector leg  (cosine, HNSW)  ──┐
        │                                        ├──▶ RRF fusion ──▶ re-rank ──▶ cite
        └──▶ lexical leg (BM25 / tsvector)     ──┘
```

Reciprocal Rank Fusion combines the legs without needing score calibration between them. Results are
then re-ranked by recency (exponential decay), importance, confidence, and usage — applied
_multiplicatively_, so relevance stays a hard ceiling and an irrelevant-but-recent memory can never
float to the top.

Scores are calibrated to the configured embedder, which means `minScore` is a real threshold rather
than a relative one. A query with no genuine matches returns nothing, instead of returning the least
bad option at score 1.0.

### Automatic knowledge graph

Entities (people, projects, organizations, technologies, files, events, locations) and their
relationships are extracted on write and merged into a persistent graph. Entity resolution is by
normalised name, so "Acme Corp.", "ACME Corp", and "Acme" collapse into one node whose mention count
grows over time. The dashboard renders it as an interactive force-directed graph.

### Consolidation

| Pass        | What it does                                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| Deduplicate | Exact (content hash) and near-duplicate (cosine) merges; survivors inherit the union of tags and the maximum importance |
| Summarize   | Groups of old related memories collapse into one summary that supersedes them                                           |
| Archive     | Stale memories leave the active set without data loss                                                                   |
| Expire      | TTL-elapsed memories are purged per their retention policy                                                              |
| Cluster     | Single-pass leader clustering labels topics for the dashboard                                                           |

Nothing is destroyed: merged memories are marked `superseded` and remain auditable.

### Everything else

- **Import/export** — JSON, JSONL, CSV, Markdown, plain text, and ZIP (with a dependency-free ZIP writer)
- **Namespaces** — hard multi-tenant boundary, enforced by Postgres row-level security
- **Observability** — latency histograms with real quantiles, counters, and a Prometheus endpoint
- **Security** — constant-time key comparison, Zod validation on every route, sliding-window rate
  limiting, strict CSP, and fail-closed environment validation

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│  apps/web — Next.js 15 App Router                                  │
│  ┌──────────────────────────┐  ┌───────────────────────────────┐   │
│  │ Dashboard (React 19)     │  │ REST API  /api/v1/*           │   │
│  │ charts · graph · search  │  │ auth · rate limit · validation│   │
│  └──────────────────────────┘  └───────────────────────────────┘   │
└──────────────────────────────┬─────────────────────────────────────┘
                               │
┌──────────────────────────────▼─────────────────────────────────────┐
│  @memorydb/core — the engine (zero runtime dependencies)           │
│                                                                    │
│   MemoryClient ── store · retrieve · search · update · delete      │
│        │                                                           │
│        ├── Embeddings    local hashing │ OpenAI-compatible         │
│        ├── Retrieval     BM25 · RRF fusion · calibrated re-ranking │
│        ├── Graph         entity extraction · resolution · traversal│
│        ├── Consolidation dedupe · summarise · archive · cluster    │
│        └── Storage       ┌─────────────┬──────────────────────┐    │
│                          │ in-memory   │ Postgres + pgvector  │    │
│                          └─────────────┴──────────────────────┘    │
└────────────────────────────────────────────────────────────────────┘
```

**The core has no runtime dependencies and no framework coupling.** It runs in Node, Bun, Deno, Edge
runtimes, and the browser. Storage is an interface with two implementations; the Postgres adapter
takes an injected driver, so `pg`, `postgres.js`, Neon, and Supabase all work without the core
depending on any of them.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the detailed design and the reasoning behind each choice.

---

## API reference

Full OpenAPI 3.1 spec at `GET /api/v1/openapi` — importable into Swagger UI, Postman, or an LLM
tool-calling adapter.

| Method       | Endpoint                 | Description                              |
| ------------ | ------------------------ | ---------------------------------------- |
| `POST`       | `/api/v1/memories`       | Create one memory or a batch             |
| `GET`        | `/api/v1/memories`       | List with filters, sorting, pagination   |
| `DELETE`     | `/api/v1/memories`       | Bulk delete by filter _(admin)_          |
| `GET`        | `/api/v1/memories/{id}`  | Fetch one                                |
| `PATCH`      | `/api/v1/memories/{id}`  | Update (re-embeds on content change)     |
| `DELETE`     | `/api/v1/memories/{id}`  | Soft or hard delete                      |
| `POST` `GET` | `/api/v1/search`         | Hybrid search with score breakdown       |
| `POST` `GET` | `/api/v1/retrieve`       | Context-ready retrieval with citations   |
| `POST` `GET` | `/api/v1/embeddings`     | Generate vectors / describe the provider |
| `GET`        | `/api/v1/stats`          | Growth, distribution, storage, top tags  |
| `GET`        | `/api/v1/graph`          | Knowledge graph nodes and edges          |
| `GET`        | `/api/v1/graph/entities` | List extracted entities                  |
| `POST`       | `/api/v1/batch/import`   | Import JSON/JSONL/CSV/MD/TXT/ZIP         |
| `GET`        | `/api/v1/batch/export`   | Export in any supported format           |
| `POST`       | `/api/v1/consolidate`    | Run consolidation _(admin)_              |
| `GET`        | `/api/v1/health`         | Liveness/readiness _(public)_            |
| `GET`        | `/api/v1/metrics`        | JSON or Prometheus metrics _(admin)_     |

```bash
curl -X POST http://localhost:3000/api/v1/search \
  -H 'authorization: Bearer $MEMORYDB_API_KEY' \
  -H 'content-type: application/json' \
  -d '{"query": "what database do we use?", "explain": true}'
```

```jsonc
{
  "data": {
    "hits": [{
      "memory": { "id": "mem_01JAV…", "title": "Production database configuration", … },
      "score": 0.942,
      "rank": 1,
      "citation": { "memoryId": "mem_01JAV…", "snippet": "…PostgreSQL 16 with pgvector…" },
      "scores": { "vector": 0.54, "keyword": 1.0, "recency": 1.0, "importance": 0.85, "final": 0.942 }
    }],
    "total": 5,
    "tookMs": 3.7
  },
  "error": null
}
```

Errors are uniform, with a machine-readable code and a correlatable request id:

```json
{
  "error": {
    "code": "not_found",
    "message": "memory 'mem_x' was not found",
    "retryable": false
  },
  "requestId": "evt_01KYH7…"
}
```

---

## SDKs

### TypeScript

```bash
pnpm add @memorydb/sdk
```

```ts
import { MemoryDB } from "@memorydb/sdk";

const memory = new MemoryDB({ apiKey: process.env.MEMORYDB_API_KEY });

await memory.store({
  content: "The API rate limit is 1000 rpm.",
  type: "semantic",
});

const results = await memory.search({ query: "rate limits", explain: true });
const context = await memory.context("what are our rate limits?");

// Paging is handled for you.
for await (const m of memory.iterate({ tags: ["infra"] })) {
  console.log(m.title);
}
```

Zero dependencies, works in Node 18+/Bun/Deno/Edge/browser, retries transient failures with
exponential backoff and full jitter, and never retries a 4xx that cannot succeed.

### Python

```bash
pip install memorydb          # stdlib only
pip install 'memorydb[async]' # adds httpx + the asyncio client
```

```python
from memorydb import MemoryDB

memory = MemoryDB(api_key="mdb_live_...")

memory.store(content="The API rate limit is 1000 rpm.", type="semantic", tags=["api"])

result = memory.retrieve(query="what are our rate limits?", token_budget=2000)
print(result.context)

for m in memory.iterate(tags=["infra"]):
    print(m.title)
```

```python
from memorydb import AsyncMemoryDB

async with AsyncMemoryDB(api_key="...") as memory:
    result = await memory.search("rate limits")
```

---

## Benchmarks

Measured with `pnpm bench` on an Apple M-series laptop against the in-memory adapter, so figures
reflect engine cost with no database latency. Reproduce with `pnpm bench`.

| Operation                      | Throughput    |
| ------------------------------ | ------------- |
| Embed a short text             | ~180k ops/sec |
| Embed a 500-word document      | ~6k ops/sec   |
| Cosine similarity (384-d)      | ~4M ops/sec   |
| Top-10 over 10k vectors        | ~35 ops/sec   |
| BM25 search over 10k documents | ~8 ops/sec    |
| Hybrid search over 1k memories | ~11 ops/sec   |
| Chunk a 5k-word document       | ~14 ops/sec   |

**What the shape tells you:** keyword search is roughly flat in corpus size because cost tracks
_matching_ documents, not total ones. Exact vector search grows linearly — which is precisely why the
Postgres adapter uses an HNSW index instead of a flat scan. The in-memory adapter is comfortable to
roughly 100k memories per namespace; past that, use Postgres.

---

## Deployment

### Vercel + Supabase

1. Create a Supabase project and run `supabase/migrations/0001_initial_schema.sql` in the SQL editor.
2. Deploy this repo to Vercel.
3. Set the environment variables:

```bash
STORAGE_DRIVER=postgres
DATABASE_URL=postgresql://…        # Supabase connection string
MEMORYDB_API_KEY=mdb_live_…        # generate a strong random key
NEXT_PUBLIC_APP_URL=https://your-app.vercel.app
```

That is the whole setup. Embeddings stay local and free unless you opt into a provider.

### Upgrading to neural embeddings

Free, local, via [Ollama](https://ollama.com):

```bash
ollama pull nomic-embed-text
```

```bash
EMBEDDING_PROVIDER=ollama
EMBEDDING_MODEL=nomic-embed-text
EMBEDDING_DIMENSIONS=768
```

Or a hosted provider (`openai`, `openrouter`, or any OpenAI-compatible `custom` endpoint). After
changing provider or dimensions, reindex:

```ts
await client.reindex({ force: true });
```

> The `vector(n)` column width is fixed by the migration. Changing `EMBEDDING_DIMENSIONS` for a
> Postgres deployment requires a migration altering that column before reindexing.

---

## Testing

```bash
pnpm test              # 216 unit + integration tests
pnpm test:coverage     # coverage report
pnpm bench             # performance benchmarks
pnpm test:e2e          # 50 end-to-end tests (starts the app itself)
pnpm verify            # lint + typecheck + test + build
cd sdks/python && pytest
```

Coverage spans the retrieval pipeline, all seven memory types, consolidation passes, the ZIP
writer/reader, every import/export round trip, SQL generation and injection-safety for the Postgres
adapter, and both SDKs' retry and error mapping.

---

## Roadmap

- [ ] Barnes-Hut quadtree for the graph layout (beyond ~500 nodes)
- [ ] Redis-backed rate limiting and cache for multi-replica deployments
- [ ] Incremental reindex with zero-downtime dimension migration
- [ ] MCP server so agents can use MemoryDB as a native tool
- [ ] Streaming retrieval for very large context assemblies
- [ ] Per-key scopes and rotation in the dashboard
- [ ] Cross-encoder re-ranking as an optional final stage

---

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). In short: `pnpm verify` must pass,
new behaviour needs a test, and comments should explain _why_ rather than restate the code.

## Security

Please report vulnerabilities privately — see [SECURITY.md](SECURITY.md). Do not open a public issue
for a security problem.

## License

[MIT](LICENSE).
