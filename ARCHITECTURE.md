# Architecture

This document explains how MemoryDB AI is put together and, more usefully, _why_ — the constraints
behind each decision and the alternatives that were rejected.

---

## Design principles

**1. The engine is a library, not a service.**
`@memorydb/core` has no runtime dependencies and no framework coupling. The Next.js app is one
consumer; you can equally embed the engine in a CLI, a worker, a Lambda, or a browser tab. This is
why storage is an interface and the Postgres driver is injected rather than imported.

**2. Zero-cost by default, never by accident.**
The default embedding provider is local, offline, and deterministic. A billable provider is only ever
constructed from explicit configuration, and selecting one without an API key throws at boot rather
than failing on the first write. Nothing in the default path can quietly start spending money.

**3. Fail closed.**
Environment validation runs at module load and refuses to boot on a dangerous configuration
(`AUTH_DISABLED` in production). Auth throws rather than returning falsy, so a route that forgets to
check the result fails closed. Every route goes through one wrapper that applies rate limiting,
authentication, and scope checks in a fixed order — a route cannot skip a control by omission.

**4. Comments explain judgement, not syntax.**
Non-obvious decisions carry their reasoning. Obvious code carries nothing.

---

## Layers

```
types.ts        Zod schemas, single source of truth for API + SDK + engine validation
  ↓
util/           hash · id · text · vector · cache   (pure, dependency-free)
  ↓
embeddings/     provider interface + local hashing + OpenAI-compatible remote
search/         BM25 index · RRF fusion · calibrated re-ranking
storage/        adapter interface · in-memory · Postgres+pgvector · filter semantics
graph/          entity extraction · resolution · traversal
consolidation/  dedupe · summarise · archive · cluster
  ↓
client.ts       MemoryClient — the public surface that composes all of the above
```

Dependencies point strictly downward. `util/` knows nothing about memories; `search/` knows nothing
about storage; `client.ts` is the only module that knows about everything.

---

## The retrieval pipeline

This is the part that most repays explanation, because the naive version is subtly broken.

```
query
  │
  ├─▶ embed ──▶ vector leg ──▶ top-N by cosine ────┐
  │                                                 ├─▶ RRF fusion
  └─────────────▶ lexical leg ─▶ top-N by BM25 ────┘        │
                                                            ▼
                                            evidence calibration
                                                            │
                                                            ▼
                                    re-rank (recency · importance · confidence · usage)
                                                            │
                                                            ▼
                                    diversify → token budget → citations
```

### Why Reciprocal Rank Fusion

Cosine similarity lives in `[-1, 1]`; BM25 is unbounded and corpus-dependent. Adding them is
meaningless, and normalising them requires calibration that drifts as the corpus grows. RRF
(Cormack et al., 2009) fuses on _rank position_ instead, which is scale-free and needs no tuning —
and empirically beats tuned score combinations across TREC collections.

### Why RRF alone is not enough

RRF discards magnitude by design. That makes it excellent for ordering and useless for thresholding:
whatever ranks first in a pool of uniformly irrelevant candidates still scores ~1.0. An early version
of this engine returned five confident-looking results for the query "zzzz nonexistent quantum flux
capacitor".

The fix is an **evidence term** multiplied into the fused score:

```
vector   = max(0, cosine) / provider.fullConfidenceSimilarity   // clamped to 1
keyword  = matched ? 0.5 + 0.5 · (bm25 / bestBm25) : 0
evidence = max(vector, keyword)

relevance = evidence · (0.7 + 0.3 · fusedRankScore)
```

Two details matter here:

- **A negative cosine means "unrelated", not "anti-related".** Mapping `[-1,1] → [0,1]` linearly puts
  an unrelated pair at 0.5, which reads as half-relevant. Clamping to 0 is correct.
- **`fullConfidenceSimilarity` is per-provider.** Neural embedders put related pairs around 0.7–0.9;
  the feature-hashing embedder produces much smaller magnitudes because a short query shares few
  features with a long document. A single hard-coded threshold would either reject every local match
  or accept every neural one, so each provider declares its own scale.

### Why the priors are multiplicative

Recency, importance, confidence, and usage adjust the score _within a band bounded by relevance_:

```
score = relevance · (1 − priorInfluence + priorInfluence · priorScore)   // priorInfluence ≤ 0.4
```

With an additive blend, a brand-new high-importance memory accumulates a respectable score from
recency and importance alone even when it matches the query not at all. Multiplying keeps relevance a
hard ceiling: zero relevance stays zero regardless of how fresh or important a memory is.

---

## The local embedding provider

A _feature-hashing_ embedder — the same technique behind scikit-learn's `HashingVectorizer` and
Vowpal Wabbit's input layer.

Three feature families are hashed into a fixed-width vector so the signal degrades gracefully:

| Family             | Weight | Contributes                        |
| ------------------ | ------ | ---------------------------------- |
| word unigrams      | 1.00   | topical meaning                    |
| word bigrams       | 0.55   | short phrases, word order          |
| character trigrams | 0.35   | robustness to typos and morphology |

Each feature is placed by `murmur3(feature) % dims`, with its sign chosen by an independent
`fnv1a32` hash. The signed hash matters: collisions then cancel in expectation rather than compound,
which is what keeps the approximation unbiased. Term frequency is damped sublinearly (`1 + log tf`)
so one repeated word cannot dominate a long document.

**What it is:** a genuine vector space where cosine similarity tracks lexical and distributional
overlap. Excellent for near-duplicate detection, clustering, and as the dense leg of hybrid search.

**What it is not:** a neural embedding. It cannot match "car" to "automobile" without shared
substrings. When true synonymy matters, configure a remote provider — the interface is identical and
no other code changes.

The trade is deliberate: the project is fully functional, testable, and benchmarkable with no API key
and no spend, and upgrades to neural embeddings with a one-line config change.

---

## Storage

### The adapter contract

`vectorSearch` and `keywordSearch` return **scored ids**, not hydrated rows. This lets each adapter
decide how much work happens in the database: the in-memory adapter scans and heaps, while Postgres
pushes filters, ranking, and limits into SQL and returns only ids for the engine to fuse.

Filter semantics are defined once in `storage/filter.ts` and compiled to SQL in the Postgres adapter.
Both must agree; the shared test suite asserts they do.

### In-memory adapter

The default, and a real implementation rather than a stub: an incremental BM25 inverted index, exact
vector search with a bounded min-heap for top-k, the complete filter grammar, and full graph support.

Vector search is a flat scan, so recall is 100% and latency grows linearly. Comfortable to ~100k
memories per namespace.

### Postgres + pgvector

- **HNSW over IVFFlat.** HNSW needs no training step, handles incremental inserts without periodic
  reclustering, and gives better recall at equal latency. Memories arrive continuously rather than in
  one bulk load, which makes IVFFlat's retraining requirement a poor fit.
- **Generated `tsvector` column.** Full-text search stays in sync with no trigger code, and the
  weights (`A` title, `B` summary/tags, `C` content) mirror the engine's BM25 field boosts.
- **Keyset pagination for iteration.** `OFFSET` degrades linearly as the scan advances and can skip
  rows under concurrent inserts; ordering on the primary key with `id > cursor` is constant-cost and
  correct.
- **Window-function counts.** `count(*) over ()` returns the page total in the same query, so count
  and rows are consistent under concurrent writes and cost one round trip instead of two.
- **Row-level security.** Namespace isolation is enforced by the database, not just the application,
  so a bug in the service layer cannot leak across tenants.

Every user-supplied value is bound as a `$n` placeholder. Injection is structurally impossible rather
than merely unlikely, and the test suite asserts it by feeding malicious namespaces, queries, tags,
and metadata paths through the adapter and checking they appear only in parameters.

---

## Knowledge graph

The default extractor is rule-based: deterministic, instant, free, and offline. It combines
orthographic cues (capitalised sequences), gazetteers (technologies, organisation suffixes, location
cues), structural patterns (emails, URLs, file paths, `@handles`), and surface syntax for relations
("X works at Y", "X depends on Y").

It is **tuned for precision over recall**. A graph with fewer correct nodes is far more useful than
one polluted with noise, so:

- Sentence-initial common words are filtered — the single biggest precision win in any
  capitalisation-based extractor.
- Technology names that are also ordinary English words (`go`, `rust`, `swift`, `next`) only match
  when capitalised. "Releases **go** out on Thursday" is not a mention of the Go language.
- Weekday and month plurals are excluded, not just their singular forms.

Entities resolve by normalised name (case-folded, punctuation-stripped, legal suffixes removed), so
repeated mentions reinforce one node instead of creating duplicates. Relations are identified by
`(source, target, type)` rather than by id, so repeated observation strengthens one edge with
diminishing returns rather than creating parallel ones.

For higher recall, implement `EntityExtractor` over an LLM and pass it in — the rest of the pipeline
is unchanged.

---

## Consolidation

Left alone, an agent's memory store degrades predictably: the same fact is written a dozen times in
slightly different words, stale working memory piles up, and retrieval quality falls because the
top-k fills with near-duplicates. Consolidation is the background process that fights this, loosely
modelled on the role sleep plays in human memory.

Each pass is independently toggleable and failure-isolated — a failing pass records a warning and the
run continues. Ids retired by an earlier pass are tracked so a later pass cannot reprocess them.

Clustering uses single-pass **leader clustering**: each memory joins the first centroid it is close
enough to, otherwise it seeds a new one. `O(n·k)` rather than the `O(n²)` of full agglomeration, and
it requires no pre-chosen `k` — which matters because the number of topics in a memory store is not
known in advance. The threshold is derived from the embedding provider's calibrated scale for the
same reason the retrieval threshold is.

---

## API layer

Every route is wrapped by one `handler` function that applies, in fixed order: request identity →
rate limiting → authentication → scope check → body size limit → schema validation → uniform error
serialisation.

Rate limiting runs _before_ authentication so an unauthenticated flood is cheap to reject, keyed by
IP until an API key identifies the caller.

The limiter uses a **sliding window with weighted carry-over**. A fixed window lets a caller send 2×
the limit across a boundary (all of window N at its end, all of N+1 at its start); the sliding
approach smooths that spike while keeping memory at O(1) per key.

Errors carry a stable machine-readable `code`, an HTTP status derived from it, and a request id.
Internal messages and stack traces are never surfaced to clients; 5xx responses are logged server-side
with full detail.

---

## Performance notes

Two algorithmic fixes worth recording, both found by benchmarking rather than by reading:

- **Chunking was `O(n²)`.** The hard-split path re-estimated tokens over a growing accumulator for
  every word. Accumulating counts incrementally made chunking a 5k-word document ~24× faster.
- **Top-k uses a bounded min-heap**, not a full sort — `O(n log k)` instead of `O(n log n)`. The
  difference is significant when scanning hundreds of thousands of candidate vectors for k=10.

Elsewhere: vectors are stored L2-normalised so cosine similarity is a plain dot product on the hot
path; the dot product is manually 4-way unrolled, which is measurably faster on V8 at the 256–1536
dimension range; and the embedding cache keys include the model id so switching models can never
serve a stale vector.

---

## Testing strategy

| Layer          | Approach                                                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Pure functions | Direct unit tests with adversarial inputs                                                                                          |
| Retrieval      | Ranking assertions on a fixed corpus — correct hit must rank first                                                                 |
| Storage        | Behavioural tests against the in-memory adapter; SQL-shape and injection-safety tests against a recording fake driver for Postgres |
| Portability    | Full round trips through every format, including a real ZIP archive                                                                |
| SDKs           | Injected transport stubs — no server, no network, no database                                                                      |
| Performance    | `vitest bench` over deterministic seeded corpora                                                                                   |

The Postgres adapter's tests deliberately use a recording fake rather than a live database: they run
in CI with no services, and they verify the properties that are expensive to debug in production —
that values are bound rather than interpolated, that filters compile to the intended predicates, and
that rows map correctly back to domain objects.
