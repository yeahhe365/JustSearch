"""
Structured logging utilities for JustSearch.
Provides request ID tracking for correlating logs across a single search flow.
"""

import logging
import contextvars
import re

# Request-scoped correlation ID
_request_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="-")

# 控制字符（含换行/制表）：调用方会把原始用户输入写进日志（如 chat 路由记录
# query 前 80 字符），不折叠的话攻击者可注入伪造的多行日志。
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")


def set_request_id(request_id: str) -> None:
    """Set the request ID for the current async context."""
    _request_id_var.set(request_id)


def get_request_id() -> str:
    """Get the current request ID."""
    return _request_id_var.get()


class RequestIdFilter(logging.Filter):
    """Logging filter that injects request_id and sanitizes control chars."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = get_request_id()  # type: ignore[attr-defined]
        try:
            message = record.getMessage()
        except Exception:
            return True  # 格式化本身出错时交给 handler 的常规报错路径。
        if _CONTROL_CHARS_RE.search(message):
            # 先插值成完整消息再折叠控制字符，防止日志伪造（log forging）。
            record.msg = _CONTROL_CHARS_RE.sub(" ", message)
            record.args = None
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
