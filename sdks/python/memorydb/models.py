"""
Typed response models.

Plain dataclasses rather than Pydantic: the SDK stays dependency-free, import
time stays near zero, and the models remain trivially usable from any Python
3.9+ project. Each model is constructed with ``from_dict`` so unknown fields
added by a newer server are ignored rather than raising — forward compatibility
matters more here than strict validation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Generic, TypeVar

T = TypeVar("T")


def _get(data: dict[str, Any], key: str, default: Any = None) -> Any:
    value = data.get(key, default)
    return default if value is None else value


@dataclass
class Memory:
    """A stored memory."""

    id: str
    namespace: str
    type: str
    kind: str
    status: str
    content: str
    created_at: str
    updated_at: str
    content_hash: str
    title: str | None = None
    summary: str | None = None
    user_id: str | None = None
    agent_id: str | None = None
    session_id: str | None = None
    source_id: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    tags: list[str] = field(default_factory=list)
    importance: float = 0.5
    confidence: float = 1.0
    embedding: list[float] | None = None
    embedding_model: str | None = None
    tokens: int = 0
    access_count: int = 0
    last_accessed_at: str | None = None
    expires_at: str | None = None
    archived_at: str | None = None
    superseded_by: str | None = None
    version: int = 1

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Memory:
        return cls(
            id=data["id"],
            namespace=data["namespace"],
            type=data["type"],
            kind=data["kind"],
            status=data.get("status", "active"),
            content=data["content"],
            created_at=data["createdAt"],
            updated_at=data["updatedAt"],
            content_hash=data.get("contentHash", ""),
            title=data.get("title"),
            summary=data.get("summary"),
            user_id=data.get("userId"),
            agent_id=data.get("agentId"),
            session_id=data.get("sessionId"),
            source_id=data.get("sourceId"),
            metadata=_get(data, "metadata", {}),
            tags=_get(data, "tags", []),
            importance=_get(data, "importance", 0.5),
            confidence=_get(data, "confidence", 1.0),
            embedding=data.get("embedding"),
            embedding_model=data.get("embeddingModel"),
            tokens=_get(data, "tokens", 0),
            access_count=_get(data, "accessCount", 0),
            last_accessed_at=data.get("lastAccessedAt"),
            expires_at=data.get("expiresAt"),
            archived_at=data.get("archivedAt"),
            superseded_by=data.get("supersededBy"),
            version=_get(data, "version", 1),
        )


@dataclass
class Citation:
    """A resolvable pointer back to the memory that supported an answer."""

    memory_id: str
    snippet: str
    created_at: str
    title: str | None = None
    source_id: str | None = None
    span: dict[str, int] | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Citation:
        return cls(
            memory_id=data["memoryId"],
            snippet=_get(data, "snippet", ""),
            created_at=_get(data, "createdAt", ""),
            title=data.get("title"),
            source_id=data.get("sourceId"),
            span=data.get("span"),
        )


@dataclass
class ScoreBreakdown:
    """Per-signal contributions to a hit's final score."""

    vector: float = 0.0
    keyword: float = 0.0
    fusion: float = 0.0
    recency: float = 0.0
    importance: float = 0.0
    confidence: float = 0.0
    final: float = 0.0

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ScoreBreakdown:
        return cls(**{k: float(data.get(k, 0.0)) for k in cls.__dataclass_fields__})


@dataclass
class SearchHit:
    memory: Memory
    score: float
    rank: int
    citation: Citation
    scores: ScoreBreakdown | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> SearchHit:
        return cls(
            memory=Memory.from_dict(data["memory"]),
            score=float(data["score"]),
            rank=int(data["rank"]),
            citation=Citation.from_dict(data["citation"]),
            scores=ScoreBreakdown.from_dict(data["scores"]) if data.get("scores") else None,
        )


@dataclass
class SearchResult:
    hits: list[SearchHit]
    total: int
    mode: str
    query: str
    took_ms: float

    def __iter__(self):
        return iter(self.hits)

    def __len__(self) -> int:
        return len(self.hits)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> SearchResult:
        return cls(
            hits=[SearchHit.from_dict(hit) for hit in _get(data, "hits", [])],
            total=int(_get(data, "total", 0)),
            mode=_get(data, "mode", "hybrid"),
            query=_get(data, "query", ""),
            took_ms=float(_get(data, "tookMs", 0.0)),
        )


@dataclass
class RetrieveResult(SearchResult):
    """Search results shaped for direct use as model context."""

    context: str = ""
    citations: list[Citation] = field(default_factory=list)
    tokens_used: int = 0
    confidence: float = 0.0
    dropped: int = 0

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> RetrieveResult:
        return cls(
            hits=[SearchHit.from_dict(hit) for hit in _get(data, "hits", [])],
            total=int(_get(data, "total", 0)),
            mode=_get(data, "mode", "hybrid"),
            query=_get(data, "query", ""),
            took_ms=float(_get(data, "tookMs", 0.0)),
            context=_get(data, "context", ""),
            citations=[Citation.from_dict(c) for c in _get(data, "citations", [])],
            tokens_used=int(_get(data, "tokensUsed", 0)),
            confidence=float(_get(data, "confidence", 0.0)),
            dropped=int(_get(data, "dropped", 0)),
        )


@dataclass
class Entity:
    id: str
    namespace: str
    type: str
    name: str
    normalized_name: str
    aliases: list[str] = field(default_factory=list)
    description: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    mention_count: int = 0
    salience: float = 0.0
    first_seen_at: str = ""
    last_seen_at: str = ""
    degree: int = 0

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Entity:
        return cls(
            id=data["id"],
            namespace=data["namespace"],
            type=data["type"],
            name=data["name"],
            normalized_name=_get(data, "normalizedName", ""),
            aliases=_get(data, "aliases", []),
            description=data.get("description"),
            metadata=_get(data, "metadata", {}),
            mention_count=int(_get(data, "mentionCount", 0)),
            salience=float(_get(data, "salience", 0.0)),
            first_seen_at=_get(data, "firstSeenAt", ""),
            last_seen_at=_get(data, "lastSeenAt", ""),
            degree=int(_get(data, "degree", 0)),
        )


@dataclass
class GraphEdge:
    id: str
    source_id: str
    target_id: str
    source_name: str
    target_name: str
    type: str
    weight: float
    confidence: float
    memory_ids: list[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> GraphEdge:
        return cls(
            id=data["id"],
            source_id=data["sourceId"],
            target_id=data["targetId"],
            source_name=_get(data, "sourceName", ""),
            target_name=_get(data, "targetName", ""),
            type=data["type"],
            weight=float(_get(data, "weight", 0.0)),
            confidence=float(_get(data, "confidence", 0.0)),
            memory_ids=_get(data, "memoryIds", []),
        )


@dataclass
class KnowledgeGraph:
    nodes: list[Entity]
    edges: list[GraphEdge]
    stats: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> KnowledgeGraph:
        return cls(
            nodes=[Entity.from_dict(n) for n in _get(data, "nodes", [])],
            edges=[GraphEdge.from_dict(e) for e in _get(data, "edges", [])],
            stats=_get(data, "stats", {}),
        )


@dataclass
class MemoryStats:
    total: int
    active: int
    archived: int
    superseded: int
    by_type: dict[str, int]
    by_kind: dict[str, int]
    total_tokens: int
    avg_importance: float
    growth: list[dict[str, Any]]
    top_tags: list[dict[str, Any]]
    entity_count: int
    relation_count: int
    storage_bytes: int
    namespace: str = ""
    embeddings: dict[str, Any] = field(default_factory=dict)
    oldest_memory_at: str | None = None
    newest_memory_at: str | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> MemoryStats:
        return cls(
            total=int(_get(data, "total", 0)),
            active=int(_get(data, "active", 0)),
            archived=int(_get(data, "archived", 0)),
            superseded=int(_get(data, "superseded", 0)),
            by_type=_get(data, "byType", {}),
            by_kind=_get(data, "byKind", {}),
            total_tokens=int(_get(data, "totalTokens", 0)),
            avg_importance=float(_get(data, "avgImportance", 0.0)),
            growth=_get(data, "growth", []),
            top_tags=_get(data, "topTags", []),
            entity_count=int(_get(data, "entityCount", 0)),
            relation_count=int(_get(data, "relationCount", 0)),
            storage_bytes=int(_get(data, "storageBytes", 0)),
            namespace=_get(data, "namespace", ""),
            embeddings=_get(data, "embeddings", {}),
            oldest_memory_at=data.get("oldestMemoryAt"),
            newest_memory_at=data.get("newestMemoryAt"),
        )


@dataclass
class ConsolidationReport:
    scanned: int
    duplicates_merged: int
    memories_summarized: int
    summaries_created: int
    archived: int
    expired: int
    clusters: list[dict[str, Any]]
    tokens_reclaimed: int
    took_ms: float
    dry_run: bool
    warnings: list[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ConsolidationReport:
        return cls(
            scanned=int(_get(data, "scanned", 0)),
            duplicates_merged=int(_get(data, "duplicatesMerged", 0)),
            memories_summarized=int(_get(data, "memoriesSummarized", 0)),
            summaries_created=int(_get(data, "summariesCreated", 0)),
            archived=int(_get(data, "archived", 0)),
            expired=int(_get(data, "expired", 0)),
            clusters=_get(data, "clusters", []),
            tokens_reclaimed=int(_get(data, "tokensReclaimed", 0)),
            took_ms=float(_get(data, "tookMs", 0.0)),
            dry_run=bool(_get(data, "dryRun", False)),
            warnings=_get(data, "warnings", []),
        )


@dataclass
class ImportResult:
    imported: int
    deduplicated: int
    failed: int
    total: int
    dry_run: bool
    errors: list[dict[str, Any]] = field(default_factory=list)
    took_ms: float = 0.0

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ImportResult:
        return cls(
            imported=int(_get(data, "imported", 0)),
            deduplicated=int(_get(data, "deduplicated", 0)),
            failed=int(_get(data, "failed", 0)),
            total=int(_get(data, "total", 0)),
            dry_run=bool(_get(data, "dryRun", False)),
            errors=_get(data, "errors", []),
            took_ms=float(_get(data, "tookMs", 0.0)),
        )


@dataclass
class Page(Generic[T]):
    """One page of results, with enough state to fetch the next."""

    items: list[T]
    total: int
    limit: int
    offset: int
    has_more: bool

    def __iter__(self):
        return iter(self.items)

    def __len__(self) -> int:
        return len(self.items)

    @classmethod
    def from_dict(cls, data: dict[str, Any], item_factory) -> Page[T]:
        return cls(
            items=[item_factory(item) for item in _get(data, "items", [])],
            total=int(_get(data, "total", 0)),
            limit=int(_get(data, "limit", 0)),
            offset=int(_get(data, "offset", 0)),
            has_more=bool(_get(data, "hasMore", False)),
        )
