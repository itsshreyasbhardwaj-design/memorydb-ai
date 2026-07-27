"""Typed exception hierarchy mirroring the API's error codes."""

from __future__ import annotations

from typing import Any


class MemoryDBError(Exception):
    """Base class for every MemoryDB failure.

    Carries the HTTP status, the server's machine-readable ``code``, and the
    request id, so failures can be logged and correlated without parsing text.
    """

    def __init__(
        self,
        message: str,
        *,
        status: int = 0,
        code: str = "internal_error",
        details: Any = None,
        request_id: str | None = None,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code
        self.details = details
        self.request_id = request_id
        self.retryable = retryable

    def __str__(self) -> str:
        suffix = f" (request_id={self.request_id})" if self.request_id else ""
        return f"[{self.code}] {self.message}{suffix}"


class ValidationError(MemoryDBError):
    """The request failed server-side validation (HTTP 400)."""


class UnauthorizedError(MemoryDBError):
    """Authentication is missing or invalid (HTTP 401/403)."""


class NotFoundError(MemoryDBError):
    """The requested resource does not exist (HTTP 404)."""


class RateLimitError(MemoryDBError):
    """Rate limit exceeded (HTTP 429).

    ``retry_after`` is the server-advised wait in seconds.
    """

    def __init__(self, message: str, *, retry_after: float = 1.0, **kwargs: Any) -> None:
        super().__init__(message, retryable=True, **kwargs)
        self.retry_after = retry_after


class ConnectionError(MemoryDBError):  # noqa: A001 - deliberately shadows the builtin name
    """The request never reached the server, or timed out."""


def error_from_response(status: int, payload: dict[str, Any]) -> MemoryDBError:
    """Build the most specific exception for an error response."""
    error = payload.get("error") or {}
    code = error.get("code", "internal_error")
    message = error.get("message", f"HTTP {status}")
    request_id = payload.get("requestId")
    details = error.get("details")

    common = {
        "status": status,
        "code": code,
        "details": details,
        "request_id": request_id,
    }

    if status == 400:
        return ValidationError(message, **common)
    if status in (401, 403):
        return UnauthorizedError(message, **common)
    if status == 404:
        return NotFoundError(message, **common)
    if status == 429:
        retry_after = 1.0
        if isinstance(details, dict):
            retry_after = float(details.get("retryAfterSeconds", 1.0))
        return RateLimitError(message, retry_after=retry_after, **common)

    return MemoryDBError(message, retryable=error.get("retryable", status >= 500), **common)
