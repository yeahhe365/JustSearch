"""
Structured logging utilities for JustSearch.
Provides request ID tracking for correlating logs across a single search flow.
"""

import logging
import contextvars

# Request-scoped correlation ID
_request_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="-")


def set_request_id(request_id: str) -> None:
    """Set the request ID for the current async context."""
    _request_id_var.set(request_id)


def get_request_id() -> str:
    """Get the current request ID."""
    return _request_id_var.get()


class RequestIdFilter(logging.Filter):
    """Logging filter that injects request_id into log records."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = get_request_id()  # type: ignore[attr-defined]
        return True


def setup_logging(level: int = logging.INFO) -> None:
    """Configure structured logging with request ID support."""
    handler = logging.StreamHandler()
    handler.addFilter(RequestIdFilter())
    formatter = logging.Formatter(
        "%(asctime)s [%(levelname)s] [%(request_id)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    handler.setFormatter(formatter)

    root = logging.getLogger()
    root.setLevel(level)
    # Remove existing handlers to avoid duplicates
    root.handlers.clear()
    root.addHandler(handler)
