"""
Synchronous and asyncio clients.

The transport is deliberately pluggable: ``httpx`` is used when available for
connection pooling and HTTP/2, and ``urllib`` from the standard library
otherwise. That keeps the package installable with no dependencies at all while
still performing well in production, where ``httpx`` is usually present.
"""

from __future__ import annotations

import contextlib
import json
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterator, Sequence
from typing import Any

from .errors import ConnectionError as MemoryDBConnectionError
from .errors import MemoryDBError, RateLimitError, error_from_response
from .models import (
    ConsolidationReport,
    Entity,
    ImportResult,
    KnowledgeGraph,
    Memory,
    MemoryStats,
    Page,
    RetrieveResult,
    SearchResult,
)

try:  # pragma: no cover - exercised implicitly by whichever transport is present
    import httpx

    _HAS_HTTPX = True
except ImportError:  # pragma: no cover
    httpx = None  # type: ignore[assignment]
    _HAS_HTTPX = False


DEFAULT_BASE_URL = "http://localhost:3000"
RETRYABLE_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})

JsonDict = dict[str, Any]


def _clean(params: JsonDict) -> JsonDict:
    """Drop ``None`` values and flatten sequences into comma-separated strings."""
    out: JsonDict = {}
    for key, value in params.items():
        if value is None:
            continue
        if isinstance(value, (list, tuple)):
            if not value:
                continue
            out[key] = ",".join(str(item) for item in value)
        elif isinstance(value, bool):
            out[key] = "true" if value else "false"
        else:
            out[key] = value
    return out


class _BaseClient:
    """Shared configuration and URL/header construction."""

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str = DEFAULT_BASE_URL,
        namespace: str | None = None,
        timeout: float = 30.0,
        max_retries: int = 2,
        headers: dict[str, str] | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.namespace = namespace
        self.timeout = timeout
        self.max_retries = max_retries
        self._extra_headers = headers or {}

    def _url(self, path: str, params: JsonDict | None = None) -> str:
        url = f"{self.base_url}/api/v1{path}"
        if params:
            cleaned = _clean(params)
            if cleaned:
                url = f"{url}?{urllib.parse.urlencode(cleaned)}"
        return url

    def _headers(self, content_type: str | None = None) -> dict[str, str]:
        headers = {"Accept": "application/json", **self._extra_headers}
        if content_type:
            headers["Content-Type"] = content_type
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        if self.namespace:
            headers["X-Namespace"] = self.namespace
        return headers

    @staticmethod
    def _backoff(attempt: int) -> float:
        """Exponential backoff with full jitter, capped at 8 seconds."""
        return random.random() * min(8.0, 0.3 * (2 ** attempt))


class MemoryDB(_BaseClient):
    """Synchronous MemoryDB client.

    Example:
        >>> memory = MemoryDB(api_key="mdb_live_...")
        >>> memory.store(content="Ada prefers dark mode.", type="semantic")
        >>> memory.retrieve(query="Ada preferences?").context
    """

    def __init__(self, api_key: str | None = None, **kwargs: Any) -> None:
        super().__init__(api_key, **kwargs)
        self._client = httpx.Client(timeout=self.timeout) if _HAS_HTTPX else None

    def __enter__(self) -> MemoryDB:
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.close()

    def close(self) -> None:
        if self._client is not None:
            self._client.close()

    # ---------------------------------------------------------------- request

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        params: JsonDict | None = None,
        raw_body: str | bytes | None = None,
        content_type: str | None = None,
    ) -> Any:
        url = self._url(path, params)

        payload: bytes | None = None
        if raw_body is not None:
            payload = raw_body.encode("utf-8") if isinstance(raw_body, str) else raw_body
        elif body is not None:
            payload = json.dumps(body).encode("utf-8")
            content_type = "application/json"

        last_error: Exception | None = None

        for attempt in range(self.max_retries + 1):
            if attempt > 0:
                time.sleep(self._backoff(attempt - 1))

            try:
                status, text, headers = self._send(method, url, payload, content_type)
            except Exception as exc:  # transport-level failure
                last_error = MemoryDBConnectionError(
                    f"request to {url} failed: {exc}", retryable=True
                )
                if attempt == self.max_retries:
                    raise last_error from exc
                continue

            if status in RETRYABLE_STATUS and attempt < self.max_retries:
                # Honour Retry-After when present, so a 429 backs off correctly.
                retry_after = headers.get("retry-after")
                if retry_after:
                    with contextlib.suppress(ValueError):
                        time.sleep(min(30.0, float(retry_after)))
                continue

            try:
                parsed = json.loads(text) if text else {}
            except json.JSONDecodeError as exc:
                raise MemoryDBError(
                    f"expected JSON but received: {text[:200]}", status=status
                ) from exc

            if status >= 400:
                raise error_from_response(status, parsed)

            return parsed.get("data")

        raise last_error or MemoryDBError("request failed after retries")

    def _send(
        self,
        method: str,
        url: str,
        payload: bytes | None,
        content_type: str | None,
    ) -> tuple[int, str, dict[str, str]]:
        headers = self._headers(content_type)

        if self._client is not None:  # httpx transport
            response = self._client.request(method, url, content=payload, headers=headers)
            return response.status_code, response.text, {k.lower(): v for k, v in response.headers.items()}

        request = urllib.request.Request(url, data=payload, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return (
                    response.status,
                    response.read().decode("utf-8"),
                    {k.lower(): v for k, v in response.headers.items()},
                )
        except urllib.error.HTTPError as exc:
            # An HTTP error status is a valid response, not a transport failure.
            return exc.code, exc.read().decode("utf-8"), {k.lower(): v for k, v in exc.headers.items()}

    # --------------------------------------------------------------- memories

    def store(
        self,
        content: str,
        *,
        type: str = "long_term",  # noqa: A002 - matches the API field name
        kind: str = "note",
        title: str | None = None,
        summary: str | None = None,
        tags: Sequence[str] | None = None,
        metadata: JsonDict | None = None,
        importance: float | None = None,
        confidence: float | None = None,
        user_id: str | None = None,
        agent_id: str | None = None,
        session_id: str | None = None,
        source_id: str | None = None,
        ttl_seconds: int | None = None,
        deduplicate: bool = True,
        chunk: bool = False,
    ) -> Memory:
        """Store a memory and return it.

        Identical content is de-duplicated by default, in which case the
        pre-existing memory is returned rather than a new one being created.
        """
        body = _clean_body(
            {
                "content": content,
                "type": type,
                "kind": kind,
                "title": title,
                "summary": summary,
                "tags": list(tags) if tags else None,
                "metadata": metadata,
                "importance": importance,
                "confidence": confidence,
                "userId": user_id,
                "agentId": agent_id,
                "sessionId": session_id,
                "sourceId": source_id,
                "ttlSeconds": ttl_seconds,
                "deduplicate": deduplicate,
                "chunk": chunk,
            }
        )
        data = self._request("POST", "/memories", body=body)
        return Memory.from_dict(data["memory"])

    def store_many(self, memories: Sequence[JsonDict]) -> list[Memory]:
        """Store many memories in one request, embedding them in a single batch."""
        data = self._request("POST", "/memories", body={"memories": list(memories)})
        return [Memory.from_dict(item) for item in data["memories"]]

    def get(self, memory_id: str) -> Memory:
        data = self._request("GET", f"/memories/{urllib.parse.quote(memory_id)}")
        return Memory.from_dict(data["memory"])

    def update(self, memory_id: str, **patch: Any) -> Memory:
        """Update a memory. Changing ``content`` re-embeds it automatically."""
        body = _clean_body(
            {
                "content": patch.get("content"),
                "title": patch.get("title"),
                "summary": patch.get("summary"),
                "type": patch.get("type"),
                "kind": patch.get("kind"),
                "status": patch.get("status"),
                "metadata": patch.get("metadata"),
                "tags": patch.get("tags"),
                "addTags": patch.get("add_tags"),
                "removeTags": patch.get("remove_tags"),
                "importance": patch.get("importance"),
                "confidence": patch.get("confidence"),
                "expiresAt": patch.get("expires_at"),
            }
        )
        data = self._request("PATCH", f"/memories/{urllib.parse.quote(memory_id)}", body=body)
        return Memory.from_dict(data["memory"])

    def delete(self, memory_id: str, *, hard: bool = False) -> bool:
        data = self._request(
            "DELETE", f"/memories/{urllib.parse.quote(memory_id)}", params={"hard": hard}
        )
        return bool(data.get("deleted"))

    def delete_many(self, filter: JsonDict, *, hard: bool = False) -> int:  # noqa: A002
        """Bulk delete by filter. Requires the ``admin`` scope."""
        data = self._request("DELETE", "/memories", body={"filter": filter, "hard": hard})
        return int(data.get("deleted", 0))

    def list(  # noqa: A003 - mirrors the REST resource name
        self,
        *,
        limit: int = 50,
        offset: int = 0,
        sort_by: str = "createdAt",
        sort_dir: str = "desc",
        type: Sequence[str] | None = None,  # noqa: A002
        tags: Sequence[str] | None = None,
        user_id: str | None = None,
        include_archived: bool = False,
    ) -> Page[Memory]:
        data = self._request(
            "GET",
            "/memories",
            params={
                "limit": limit,
                "offset": offset,
                "sortBy": sort_by,
                "sortDir": sort_dir,
                "type": type,
                "tags": tags,
                "userId": user_id,
                "includeArchived": include_archived,
            },
        )
        return Page.from_dict(data, Memory.from_dict)

    def iterate(self, *, batch_size: int = 100, **filters: Any) -> Iterator[Memory]:
        """Yield every matching memory, paging transparently."""
        offset = 0
        while True:
            page = self.list(limit=batch_size, offset=offset, **filters)
            yield from page.items
            if not page.has_more or not page.items:
                return
            offset += len(page.items)

    # -------------------------------------------------------------- retrieval

    def search(
        self,
        query: str,
        *,
        mode: str = "hybrid",
        limit: int = 10,
        offset: int = 0,
        filter: JsonDict | None = None,  # noqa: A002
        min_score: float = 0.0,
        explain: bool = False,
        track_access: bool = False,
    ) -> SearchResult:
        """Hybrid semantic + keyword search with intelligent ranking."""
        body = _clean_body(
            {
                "query": query,
                "mode": mode,
                "limit": limit,
                "offset": offset,
                "filter": filter,
                "minScore": min_score,
                "explain": explain,
                "trackAccess": track_access,
            }
        )
        return SearchResult.from_dict(self._request("POST", "/search", body=body))

    def retrieve(
        self,
        query: str,
        *,
        limit: int = 10,
        token_budget: int = 4000,
        mode: str = "hybrid",
        filter: JsonDict | None = None,  # noqa: A002
        diversify: bool = True,
        min_score: float = 0.0,
    ) -> RetrieveResult:
        """Retrieve memories shaped for direct use as model context."""
        body = _clean_body(
            {
                "query": query,
                "limit": limit,
                "tokenBudget": token_budget,
                "mode": mode,
                "filter": filter,
                "diversify": diversify,
                "minScore": min_score,
            }
        )
        return RetrieveResult.from_dict(self._request("POST", "/retrieve", body=body))

    def context(self, query: str, **kwargs: Any) -> str:
        """Shorthand returning only the formatted context block."""
        return self.retrieve(query, **kwargs).context

    # ------------------------------------------------------------------ graph

    def graph(
        self,
        *,
        types: Sequence[str] | None = None,
        root_ids: Sequence[str] | None = None,
        depth: int = 2,
        max_nodes: int = 150,
        min_weight: float | None = None,
        search: str | None = None,
    ) -> KnowledgeGraph:
        data = self._request(
            "GET",
            "/graph",
            params={
                "types": types,
                "rootIds": root_ids,
                "depth": depth,
                "maxNodes": max_nodes,
                "minWeight": min_weight,
                "search": search,
            },
        )
        return KnowledgeGraph.from_dict(data)

    def entities(
        self,
        *,
        type: Sequence[str] | None = None,  # noqa: A002
        search: str | None = None,
        limit: int = 50,
        offset: int = 0,
        sort_by: str = "mentionCount",
    ) -> Page[Entity]:
        data = self._request(
            "GET",
            "/graph/entities",
            params={
                "type": type,
                "search": search,
                "limit": limit,
                "offset": offset,
                "sortBy": sort_by,
            },
        )
        return Page.from_dict(data, Entity.from_dict)

    # ------------------------------------------------------------- embeddings

    def embed(self, texts: str | Sequence[str], *, similarity: bool = False) -> JsonDict:
        """Generate embeddings using the server's configured provider."""
        payload = texts if isinstance(texts, str) else list(texts)
        return self._request("POST", "/embeddings", body={"input": payload, "similarity": similarity})

    # ------------------------------------------------------------------ admin

    def stats(self, *, growth_days: int = 30) -> MemoryStats:
        data = self._request("GET", "/stats", params={"growthDays": growth_days})
        return MemoryStats.from_dict(data)

    def consolidate(self, *, dry_run: bool = False, **options: Any) -> ConsolidationReport:
        """Merge duplicates, summarise, archive, expire, and cluster."""
        body = {"dryRun": dry_run, **options}
        return ConsolidationReport.from_dict(self._request("POST", "/consolidate", body=body))

    def health(self) -> JsonDict:
        url = f"{self.base_url}/api/v1/health"
        request = urllib.request.Request(url, headers={"Accept": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            return json.loads(exc.read().decode("utf-8"))

    # ------------------------------------------------------------ portability

    def import_data(
        self,
        data: str | bytes,
        *,
        format: str = "json",  # noqa: A002
        deduplicate: bool = True,
        dry_run: bool = False,
        tags: Sequence[str] | None = None,
    ) -> ImportResult:
        """Import memories from JSON, JSONL, CSV, Markdown, text, or a ZIP archive."""
        content_types = {
            "json": "application/json",
            "jsonl": "application/x-ndjson",
            "csv": "text/csv",
            "markdown": "text/markdown",
            "txt": "text/plain",
            "zip": "application/zip",
        }
        result = self._request(
            "POST",
            "/batch/import",
            params={"format": format, "deduplicate": deduplicate, "dryRun": dry_run, "tags": tags},
            raw_body=data,
            content_type=content_types.get(format, "application/json"),
        )
        return ImportResult.from_dict(result)

    def export_data(
        self,
        *,
        format: str = "json",  # noqa: A002
        include_embeddings: bool = False,
        include_graph: bool = False,
        limit: int = 100_000,
    ) -> str | bytes:
        """Export the namespace. Returns ``bytes`` for ZIP, ``str`` otherwise."""
        url = self._url(
            "/batch/export",
            {
                "format": format,
                "includeEmbeddings": include_embeddings,
                "includeGraph": include_graph,
                "limit": limit,
            },
        )
        request = urllib.request.Request(url, headers=self._headers(), method="GET")
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            raw = response.read()
        return raw if format == "zip" else raw.decode("utf-8")


class AsyncMemoryDB(_BaseClient):
    """Asyncio MemoryDB client. Requires ``httpx`` (``pip install memorydb[async]``).

    Example:
        >>> async with AsyncMemoryDB(api_key="mdb_live_...") as memory:
        ...     await memory.store(content="Ada prefers dark mode.")
    """

    def __init__(self, api_key: str | None = None, **kwargs: Any) -> None:
        if not _HAS_HTTPX:
            raise ImportError(
                "AsyncMemoryDB requires httpx. Install it with: pip install 'memorydb[async]'"
            )
        super().__init__(api_key, **kwargs)
        self._client = httpx.AsyncClient(timeout=self.timeout)

    async def __aenter__(self) -> AsyncMemoryDB:
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        await self.close()

    async def close(self) -> None:
        await self._client.aclose()

    async def _request(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        params: JsonDict | None = None,
    ) -> Any:
        import asyncio

        url = self._url(path, params)
        content = json.dumps(body).encode("utf-8") if body is not None else None
        headers = self._headers("application/json" if body is not None else None)

        for attempt in range(self.max_retries + 1):
            if attempt > 0:
                await asyncio.sleep(self._backoff(attempt - 1))

            try:
                response = await self._client.request(method, url, content=content, headers=headers)
            except Exception as exc:
                if attempt == self.max_retries:
                    raise MemoryDBConnectionError(f"request to {url} failed: {exc}", retryable=True) from exc
                continue

            if response.status_code in RETRYABLE_STATUS and attempt < self.max_retries:
                continue

            try:
                parsed = response.json() if response.text else {}
            except ValueError as exc:
                raise MemoryDBError(
                    f"expected JSON but received: {response.text[:200]}",
                    status=response.status_code,
                ) from exc

            if response.status_code >= 400:
                raise error_from_response(response.status_code, parsed)

            return parsed.get("data")

        raise MemoryDBError("request failed after retries")

    async def store(self, content: str, **kwargs: Any) -> Memory:
        body = _clean_body({"content": content, **_snake_to_camel(kwargs)})
        data = await self._request("POST", "/memories", body=body)
        return Memory.from_dict(data["memory"])

    async def store_many(self, memories: Sequence[JsonDict]) -> list[Memory]:
        data = await self._request("POST", "/memories", body={"memories": list(memories)})
        return [Memory.from_dict(item) for item in data["memories"]]

    async def get(self, memory_id: str) -> Memory:
        data = await self._request("GET", f"/memories/{urllib.parse.quote(memory_id)}")
        return Memory.from_dict(data["memory"])

    async def delete(self, memory_id: str, *, hard: bool = False) -> bool:
        data = await self._request(
            "DELETE", f"/memories/{urllib.parse.quote(memory_id)}", params={"hard": hard}
        )
        return bool(data.get("deleted"))

    async def search(self, query: str, **kwargs: Any) -> SearchResult:
        body = _clean_body({"query": query, **_snake_to_camel(kwargs)})
        return SearchResult.from_dict(await self._request("POST", "/search", body=body))

    async def retrieve(self, query: str, **kwargs: Any) -> RetrieveResult:
        body = _clean_body({"query": query, **_snake_to_camel(kwargs)})
        return RetrieveResult.from_dict(await self._request("POST", "/retrieve", body=body))

    async def context(self, query: str, **kwargs: Any) -> str:
        return (await self.retrieve(query, **kwargs)).context

    async def stats(self, *, growth_days: int = 30) -> MemoryStats:
        data = await self._request("GET", "/stats", params={"growthDays": growth_days})
        return MemoryStats.from_dict(data)

    async def graph(self, **kwargs: Any) -> KnowledgeGraph:
        return KnowledgeGraph.from_dict(
            await self._request("GET", "/graph", params=_snake_to_camel(kwargs))
        )

    async def consolidate(self, *, dry_run: bool = False, **options: Any) -> ConsolidationReport:
        body = {"dryRun": dry_run, **options}
        return ConsolidationReport.from_dict(await self._request("POST", "/consolidate", body=body))


def _clean_body(body: JsonDict) -> JsonDict:
    """Drop ``None`` values so server-side defaults apply."""
    return {key: value for key, value in body.items() if value is not None}


def _snake_to_camel(params: JsonDict) -> JsonDict:
    """Convert Python's snake_case kwargs to the API's camelCase fields."""
    out: JsonDict = {}
    for key, value in params.items():
        parts = key.split("_")
        camel = parts[0] + "".join(part.title() for part in parts[1:])
        out[camel] = value
    return out


__all__ = ["MemoryDB", "AsyncMemoryDB", "RateLimitError"]
