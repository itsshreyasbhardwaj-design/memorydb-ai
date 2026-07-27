# Contributing to MemoryDB AI

Thanks for considering a contribution. This guide covers everything you need to be productive.

## Getting started

```bash
git clone https://github.com/itsshreyasbhardwaj-design/memorydb-ai.git
cd memorydb-ai
pnpm install
pnpm dev
```

No configuration is required. The app starts with in-memory storage, local embeddings, and a demo
corpus — no database, no API keys, no cost.

## Before you open a pull request

```bash
pnpm verify   # lint + typecheck + test + build — all four must pass
```

For Python SDK changes:

```bash
cd sdks/python
pip install -e ".[dev]"
pytest && ruff check .
```

## Project layout

```
packages/core     the engine — zero runtime dependencies
packages/sdk      TypeScript client SDK
apps/web          Next.js dashboard + REST API
sdks/python       Python client SDK
supabase/         SQL migrations
benchmarks/       vitest bench suites
```

## Standards

**TypeScript is strict.** `noUncheckedIndexedAccess` is on, which means indexing an array yields
`T | undefined`. Handle it — do not reach for `!` unless you can articulate why the value cannot be
absent.

**Comments explain judgement, not syntax.** Write a comment when a decision is non-obvious: why this
algorithm, why this constant, what breaks without it. Do not narrate what the code already says.

```ts
// Good — explains a decision a reader would otherwise question.
// A negative cosine means "unrelated", not "anti-related" — clamp to 0 rather
// than mapping it onto the middle of the range.
const vector = Math.max(0, rawVector);

// Bad — restates the code.
// Set vector to the max of 0 and rawVector.
const vector = Math.max(0, rawVector);
```

**New behaviour needs a test.** Bug fixes need a regression test that fails before the fix.

**Keep the core dependency-free.** `@memorydb/core` must stay installable with no transitive
dependencies beyond Zod. If you need a library, consider whether the functionality belongs in the
app layer instead, or whether a focused implementation is preferable — that is why the ZIP writer and
the force-directed graph layout are hand-written.

## Adding a storage adapter

Implement `StorageAdapter` from `packages/core/src/storage/types.ts`. The filter semantics in
`storage/filter.ts` are the reference implementation — your adapter must agree with them. Add tests
mirroring `postgres-adapter.test.ts`, especially around parameter binding if you generate a query
language.

## Adding an embedding provider

Implement `EmbeddingProvider`. Three requirements:

1. Return L2-normalised vectors of exactly `dimensions` length.
2. Preserve input order.
3. Declare an honest `fullConfidenceSimilarity` — the cosine at which a match should count as fully
   confident. Retrieval calibration depends on it, and getting it wrong will silently skew scoring.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/):

```
feat(core): add procedural memory retention policy
fix(search): clamp negative cosine to zero before calibration
perf(text): make chunking linear in word count
docs(readme): document the Ollama upgrade path
test(sdk): cover retry bounds
```

## Reporting bugs

Open an issue with the reproduction, expected versus actual behaviour, and your environment. A
failing test case is the most useful thing you can attach.

## Security

Do not open a public issue for a vulnerability — see [SECURITY.md](SECURITY.md).

## Code of conduct

Be respectful and constructive. Assume good faith. We are all trying to build something useful.
