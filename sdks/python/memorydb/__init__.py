"""
Official Python SDK for MemoryDB AI.

Long-term memory infrastructure for AI agents: store conversations, documents,
and knowledge, then retrieve exactly what matters with citations.

Both a synchronous and an asyncio client are provided with identical surfaces.
Only the standard library is required; ``httpx`` is used automatically when it
is installed, which enables HTTP/2 and connection pooling.

    from memorydb import MemoryDB

    memory = MemoryDB(api_key="mdb_live_...")
    memory.store(content="Ada prefers dark mode.", type="semantic")

    result = memory.retrieve(query="What are Ada's preferences?")
    print(result.context)
"""

from .client import AsyncMemoryDB, MemoryDB
from .errors import (
    MemoryDBError,
    NotFoundError,
    RateLimitError,
    ValidationError,
    UnauthorizedError,
)
from .models import (
    Citation,
    ConsolidationReport,
    Entity,
    ImportResult,
    KnowledgeGraph,
    Memory,
    MemoryStats,
    Page,
    RetrieveResult,
    SearchHit,
    SearchResult,
)

__version__ = "0.1.0"

__all__ = [
    "MemoryDB",
    "AsyncMemoryDB",
    "Memory",
    "SearchResult",
    "SearchHit",
    "RetrieveResult",
    "Citation",
    "Entity",
    "KnowledgeGraph",
    "MemoryStats",
    "ConsolidationReport",
    "ImportResult",
    "Page",
    "MemoryDBError",
    "NotFoundError",
    "RateLimitError",
    "ValidationError",
    "UnauthorizedError",
    "__version__",
]
