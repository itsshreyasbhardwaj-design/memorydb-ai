# memorydb

Official Python SDK for [MemoryDB AI](https://github.com/itsshreyasbhardwaj-design/memorydb-ai) —
long-term memory infrastructure for AI agents.

Store conversations, documents, and knowledge, then retrieve exactly what matters, with citations.

## Installation

```bash
pip install memorydb            # standard library only
pip install 'memorydb[async]'   # adds httpx + the asyncio client
```

Requires Python 3.9+.

## Quickstart

```python
from memorydb import MemoryDB

memory = MemoryDB(api_key="mdb_live_...", base_url="https://your-deployment.vercel.app")

memory.store(
    content="Ada prefers async written updates over standups.",
    type="semantic",
    tags=["people", "preferences"],
)

result = memory.retrieve(query="How should I communicate with Ada?", token_budget=2000)
print(result.context)
```

`result.context` drops straight into a prompt, and `result.citations` maps each `[n]` marker back to
a memory id so every claim is traceable.

## Usage

### Storing

```python
memory.store(
    content="The API rate limit is 1000 requests per minute.",
    type="semantic",          # short_term | working | long_term | semantic
                              # episodic | procedural | graph
    kind="knowledge",
    title="API rate limits",
    tags=["api", "limits"],
    metadata={"source": "runbook", "reviewed": True},
    importance=0.8,
    user_id="u_123",
    ttl_seconds=None,         # None uses the memory type's retention policy
)

# Batch — embeddings are computed in one call.
memory.store_many([
    {"content": "First fact"},
    {"content": "Second fact", "tags": ["important"]},
])
```

Identical content is de-duplicated by default; the existing memory is returned instead of a
duplicate being created.

### Searching

```python
results = memory.search("what are our rate limits?", explain=True)

for hit in results:
    print(f"{hit.rank}. [{hit.score:.3f}] {hit.memory.title}")
    print(f"   vector={hit.scores.vector:.2f} keyword={hit.scores.keyword:.2f}")
    print(f"   {hit.citation.snippet}")
```

Search modes: `hybrid` (default), `semantic`, `keyword`.

### Retrieving context for a model

```python
result = memory.retrieve(
    query="what are our deployment rules?",
    token_budget=2000,     # hard cap across all returned memories
    diversify=True,        # drop near-duplicate hits
    filter={"tags": ["ops"]},
)

print(result.context)      # ready to paste into a prompt
print(result.confidence)   # 0..1 — did the store actually know anything?
print(result.tokens_used)

# Shorthand when you only need the string:
context = memory.context("what are our deployment rules?")
```

### Filtering

```python
memory.search("incident", filter={
    "type": ["episodic"],
    "tags": ["postmortem"],
    "createdAfter": "2026-01-01T00:00:00Z",
    "minImportance": 0.5,
    "metadata": {"severity": {"gte": 3}, "source.channel": "pagerduty"},
})
```

Metadata operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`, `contains`, `exists`.
Dotted keys address nested paths.

### Iterating

```python
# Paging is handled for you.
for m in memory.iterate(tags=["infra"], batch_size=100):
    print(m.title)
```

### Knowledge graph

```python
graph = memory.graph(types=["person", "technology"], max_nodes=100)

for node in graph.nodes:
    print(f"{node.name} ({node.type}) — {node.mention_count} mentions")
```

### Maintenance

```python
report = memory.consolidate(dry_run=True)
print(f"{report.duplicates_merged} duplicates, {report.archived} archivable")

stats = memory.stats()
print(f"{stats.total} memories, {stats.entity_count} entities")
```

### Import and export

```python
backup = memory.export_data(format="zip", include_graph=True)
open("backup.zip", "wb").write(backup)

result = memory.import_data(open("memories.json").read(), format="json")
print(f"{result.imported} imported, {result.deduplicated} duplicates")
```

Formats: `json`, `jsonl`, `csv`, `markdown`, `txt`, `zip`.

## Async

```python
import asyncio
from memorydb import AsyncMemoryDB

async def main():
    async with AsyncMemoryDB(api_key="mdb_live_...") as memory:
        await memory.store(content="Ada prefers dark mode.")
        result = await memory.retrieve(query="Ada preferences?")
        print(result.context)

asyncio.run(main())
```

## Error handling

```python
from memorydb import MemoryDBError, NotFoundError, RateLimitError, ValidationError

try:
    memory.get("mem_does_not_exist")
except NotFoundError as exc:
    print(exc.code, exc.request_id)
except RateLimitError as exc:
    time.sleep(exc.retry_after)
except ValidationError as exc:
    print(exc.details)
except MemoryDBError as exc:
    if exc.retryable:
        ...
```

Transient failures are retried automatically with exponential backoff and full jitter. A 4xx that
cannot succeed is never retried.

## Configuration

```python
MemoryDB(
    api_key="mdb_live_...",
    base_url="http://localhost:3000",
    namespace="tenant-a",   # tenant scope; sent as X-Namespace
    timeout=30.0,
    max_retries=2,
)
```

## License

MIT
