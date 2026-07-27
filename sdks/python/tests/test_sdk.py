"""
Python SDK tests.

These run against a stub HTTP server rather than a live deployment, so CI needs
no database, no API key, and no network egress. They verify the parts most
likely to break silently: request shaping, snake_case-to-camelCase conversion,
response parsing, retry behaviour, and error mapping.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import pytest

from memorydb import MemoryDB
from memorydb.errors import (
    MemoryDBError,
    NotFoundError,
    RateLimitError,
    UnauthorizedError,
    ValidationError,
)
from memorydb.models import Memory


class StubHandler(BaseHTTPRequestHandler):
    """Records requests and replays scripted responses."""

    requests: list[dict[str, Any]] = []
    responses: dict[str, tuple[int, dict[str, Any]]] = {}
    # Paths that should fail with 503 the first N times they are called.
    fail_counts: dict[str, int] = {}

    def log_message(self, *_args: Any) -> None:  # silence stderr noise
        pass

    def _handle(self) -> None:
        length = int(self.headers.get("content-length", 0))
        raw = self.rfile.read(length).decode("utf-8") if length else ""

        path = self.path.split("?")[0]
        type(self).requests.append(
            {
                "method": self.command,
                "path": path,
                "query": self.path.split("?")[1] if "?" in self.path else "",
                "body": json.loads(raw) if raw and raw.startswith(("{", "[")) else raw,
                "headers": {k.lower(): v for k, v in self.headers.items()},
            }
        )

        remaining = type(self).fail_counts.get(path, 0)
        if remaining > 0:
            type(self).fail_counts[path] = remaining - 1
            self.send_response(503)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error":{"code":"storage_error","message":"try again"}}')
            return

        status, payload = type(self).responses.get(path, (200, {"data": {}, "error": None}))
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = do_POST = do_PATCH = do_DELETE = _handle  # noqa: N815


@pytest.fixture()
def server():
    StubHandler.requests = []
    StubHandler.responses = {}
    StubHandler.fail_counts = {}

    httpd = HTTPServer(("127.0.0.1", 0), StubHandler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()

    yield httpd, f"http://127.0.0.1:{httpd.server_port}"

    httpd.shutdown()
    httpd.server_close()


MEMORY_FIXTURE = {
    "id": "mem_1",
    "namespace": "default",
    "type": "semantic",
    "kind": "note",
    "status": "active",
    "content": "Ada prefers dark mode.",
    "title": "Preference",
    "summary": None,
    "userId": "u1",
    "agentId": None,
    "sessionId": None,
    "sourceId": None,
    "metadata": {"source": "slack"},
    "tags": ["people"],
    "importance": 0.8,
    "confidence": 1.0,
    "embedding": None,
    "embeddingModel": "local-hash-v1-384",
    "tokens": 6,
    "accessCount": 2,
    "lastAccessedAt": None,
    "createdAt": "2026-01-01T00:00:00.000Z",
    "updatedAt": "2026-01-01T00:00:00.000Z",
    "expiresAt": None,
    "archivedAt": None,
    "supersededBy": None,
    "contentHash": "abc123",
    "version": 1,
}


def test_store_sends_camelcase_and_parses_response(server):
    _, base_url = server
    StubHandler.responses["/api/v1/memories"] = (
        201,
        {"data": {"memory": MEMORY_FIXTURE, "deduplicated": False, "entitiesExtracted": 2}, "error": None},
    )

    client = MemoryDB(api_key="test-key", base_url=base_url)
    memory = client.store(
        content="Ada prefers dark mode.",
        type="semantic",
        tags=["people"],
        user_id="u1",
        ttl_seconds=3600,
    )

    assert isinstance(memory, Memory)
    assert memory.id == "mem_1"
    assert memory.user_id == "u1"
    assert memory.metadata == {"source": "slack"}

    sent = StubHandler.requests[-1]
    assert sent["method"] == "POST"
    # snake_case kwargs must reach the API as camelCase fields.
    assert sent["body"]["userId"] == "u1"
    assert sent["body"]["ttlSeconds"] == 3600
    assert "user_id" not in sent["body"]


def test_authorization_header_is_sent(server):
    _, base_url = server
    StubHandler.responses["/api/v1/stats"] = (200, {"data": {"total": 0}, "error": None})

    MemoryDB(api_key="secret-key", base_url=base_url, namespace="tenant-a").stats()

    headers = StubHandler.requests[-1]["headers"]
    assert headers["authorization"] == "Bearer secret-key"
    assert headers["x-namespace"] == "tenant-a"


def test_none_values_are_omitted_from_the_body(server):
    _, base_url = server
    StubHandler.responses["/api/v1/memories"] = (
        201,
        {"data": {"memory": MEMORY_FIXTURE}, "error": None},
    )

    MemoryDB(base_url=base_url).store(content="hello")

    body = StubHandler.requests[-1]["body"]
    # Unset optional fields must not be sent, so server defaults apply.
    assert "title" not in body
    assert "importance" not in body
    assert body["content"] == "hello"


def test_search_parses_hits_and_scores(server):
    _, base_url = server
    StubHandler.responses["/api/v1/search"] = (
        200,
        {
            "data": {
                "hits": [
                    {
                        "memory": MEMORY_FIXTURE,
                        "score": 0.87,
                        "rank": 1,
                        "citation": {
                            "memoryId": "mem_1",
                            "snippet": "Ada prefers dark mode.",
                            "createdAt": "2026-01-01T00:00:00.000Z",
                            "title": "Preference",
                            "sourceId": None,
                            "span": {"start": 0, "end": 22},
                        },
                        "scores": {
                            "vector": 0.7, "keyword": 0.9, "fusion": 0.8,
                            "recency": 1.0, "importance": 0.8, "confidence": 1.0, "final": 0.87,
                        },
                    }
                ],
                "total": 1,
                "mode": "hybrid",
                "query": "dark mode",
                "tookMs": 3.2,
            },
            "error": None,
        },
    )

    result = MemoryDB(base_url=base_url).search("dark mode", explain=True)

    assert result.total == 1
    assert len(result) == 1
    assert result.hits[0].score == 0.87
    assert result.hits[0].scores is not None
    assert result.hits[0].scores.keyword == 0.9
    assert result.hits[0].citation.memory_id == "mem_1"
    # SearchResult is iterable for ergonomics.
    assert [hit.rank for hit in result] == [1]


def test_retrieve_parses_context_and_citations(server):
    _, base_url = server
    StubHandler.responses["/api/v1/retrieve"] = (
        200,
        {
            "data": {
                "hits": [],
                "total": 0,
                "mode": "hybrid",
                "query": "q",
                "tookMs": 1.0,
                "context": "Relevant memories:\n\n[1] Preference",
                "citations": [
                    {"memoryId": "mem_1", "snippet": "s", "createdAt": "2026-01-01T00:00:00.000Z"}
                ],
                "tokensUsed": 42,
                "confidence": 0.66,
                "dropped": 3,
            },
            "error": None,
        },
    )

    result = MemoryDB(base_url=base_url).retrieve("q", token_budget=500)

    assert result.context.startswith("Relevant memories:")
    assert result.tokens_used == 42
    assert result.confidence == 0.66
    assert result.dropped == 3
    assert result.citations[0].memory_id == "mem_1"
    assert StubHandler.requests[-1]["body"]["tokenBudget"] == 500


def test_list_returns_a_page(server):
    _, base_url = server
    StubHandler.responses["/api/v1/memories"] = (
        200,
        {
            "data": {"items": [MEMORY_FIXTURE], "total": 5, "limit": 1, "offset": 0, "hasMore": True},
            "error": None,
        },
    )

    page = MemoryDB(base_url=base_url).list(limit=1, tags=["people", "prefs"])

    assert page.total == 5
    assert page.has_more is True
    assert len(page) == 1
    # Sequence params are flattened to a comma-separated query value.
    assert "tags=people%2Cprefs" in StubHandler.requests[-1]["query"]


def test_iterate_pages_until_exhausted(server):
    _, base_url = server
    pages = iter(
        [
            {"items": [MEMORY_FIXTURE], "total": 2, "limit": 1, "offset": 0, "hasMore": True},
            {"items": [MEMORY_FIXTURE], "total": 2, "limit": 1, "offset": 1, "hasMore": False},
        ]
    )

    class PagingHandler(StubHandler):
        def _handle(self) -> None:  # type: ignore[override]
            body = json.dumps({"data": next(pages), "error": None}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        # `do_GET` was bound to the parent's `_handle` when StubHandler was
        # defined, so overriding `_handle` alone would not take effect.
        do_GET = _handle  # noqa: N815

    httpd = HTTPServer(("127.0.0.1", 0), PagingHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        client = MemoryDB(base_url=f"http://127.0.0.1:{httpd.server_port}")
        assert len(list(client.iterate(batch_size=1))) == 2
    finally:
        httpd.shutdown()
        httpd.server_close()


@pytest.mark.parametrize(
    ("status", "code", "expected"),
    [
        (400, "validation_error", ValidationError),
        (401, "unauthorized", UnauthorizedError),
        (403, "forbidden", UnauthorizedError),
        (404, "not_found", NotFoundError),
        (429, "rate_limited", RateLimitError),
        (500, "internal_error", MemoryDBError),
    ],
)
def test_error_statuses_map_to_typed_exceptions(server, status, code, expected):
    _, base_url = server
    StubHandler.responses["/api/v1/stats"] = (
        status,
        {"error": {"code": code, "message": "boom"}, "requestId": "evt_1"},
    )

    # 5xx is retried, so allow no retries to keep the test fast and deterministic.
    client = MemoryDB(base_url=base_url, max_retries=0)
    with pytest.raises(expected) as excinfo:
        client.stats()

    assert excinfo.value.code == code
    assert excinfo.value.request_id == "evt_1"


def test_transient_failures_are_retried(server):
    _, base_url = server
    StubHandler.responses["/api/v1/stats"] = (200, {"data": {"total": 7}, "error": None})
    # Fail twice, then succeed.
    StubHandler.fail_counts["/api/v1/stats"] = 2

    stats = MemoryDB(base_url=base_url, max_retries=3).stats()

    assert stats.total == 7
    assert len(StubHandler.requests) == 3


def test_retries_are_bounded(server):
    _, base_url = server
    StubHandler.fail_counts["/api/v1/stats"] = 99

    with pytest.raises(MemoryDBError):
        MemoryDB(base_url=base_url, max_retries=1).stats()

    # One initial attempt plus one retry.
    assert len(StubHandler.requests) == 2


def test_delete_sends_hard_flag(server):
    _, base_url = server
    StubHandler.responses["/api/v1/memories/mem_1"] = (
        200,
        {"data": {"id": "mem_1", "deleted": True}, "error": None},
    )

    assert MemoryDB(base_url=base_url).delete("mem_1", hard=True) is True
    assert "hard=true" in StubHandler.requests[-1]["query"]


def test_stats_parses_nested_structures(server):
    _, base_url = server
    StubHandler.responses["/api/v1/stats"] = (
        200,
        {
            "data": {
                "total": 12, "active": 10, "archived": 2, "superseded": 0,
                "byType": {"semantic": 8, "episodic": 4},
                "byKind": {"note": 12},
                "totalTokens": 900, "avgImportance": 0.61,
                "growth": [{"date": "2026-01-01", "count": 3, "cumulative": 3}],
                "topTags": [{"tag": "infra", "count": 5}],
                "entityCount": 20, "relationCount": 33, "storageBytes": 4096,
                "namespace": "default",
                "embeddings": {"provider": "local", "model": "local-hash-v1-384", "dimensions": 384, "remote": False},
            },
            "error": None,
        },
    )

    stats = MemoryDB(base_url=base_url).stats()

    assert stats.total == 12
    assert stats.by_type["semantic"] == 8
    assert stats.entity_count == 20
    assert stats.embeddings["remote"] is False
    assert stats.growth[0]["cumulative"] == 3


def test_unknown_response_fields_are_ignored(server):
    """A newer server may add fields; the SDK must not break on them."""
    _, base_url = server
    future_memory = {**MEMORY_FIXTURE, "somethingNew": {"nested": True}}
    StubHandler.responses["/api/v1/memories/mem_1"] = (
        200,
        {"data": {"memory": future_memory}, "error": None},
    )

    memory = MemoryDB(base_url=base_url).get("mem_1")
    assert memory.id == "mem_1"
