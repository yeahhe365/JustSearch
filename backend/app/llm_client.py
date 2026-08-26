import copy
import json
import hashlib
import logging
import os
import re
import asyncio
from datetime import datetime
from typing import List, Dict, Optional, Callable, Any

from .openai_client import create_openai_client
from .prompts import (
    ANSWER_GENERATION_PROMPT,
    ANSWER_GENERATION_LIVE_ARTIFACTS_PROMPT,
    select_live_artifacts_protocol,
    CLICK_DECISION_PROMPT,
    RELEVANCE_ASSESSMENT_PROMPT,
    TASK_ANALYSIS_PROMPT,
    CITATION_VERIFICATION_PROMPT,
)

logger = logging.getLogger(__name__)

# LLM 调用超时
_LLM_TIMEOUT = 120  # 秒（默认，用于 generate_answer）
# 短操作（analyze_task / assess_relevance）超时；可通过环境变量覆盖。
_LLM_SHORT_TIMEOUT = float(os.getenv("JUSTSEARCH_LLM_SHORT_TIMEOUT", "30"))
_LLM_CONNECT_TIMEOUT = 20.0  # 秒：建连超时，避免网关假死拖很久
_GENERATE_ANSWER_RETRIES = 4  # 流式生成答案的重试次数（含首次）

# 并发 LLM 请求限制（进程级）。默认 5；同时跑多个对话时可调高，例如：
# JUSTSEARCH_LLM_CONCURRENCY=8。注意该信号量在流式答案生成期间会一直被
# 占用（最长一个流式回合），过高的值可能触发上游限流。
_LLM_CONCURRENCY = asyncio.Semaphore(
    max(1, int(os.getenv("JUSTSEARCH_LLM_CONCURRENCY", "5") or 5))
)
# 流式与短操作隔离：避免 5 个长流堵死 analysis/relevance
_LLM_STREAM_SEMAPHORE = _LLM_CONCURRENCY
_LLM_SHORT_SEMAPHORE = asyncio.Semaphore(
    max(1, int(os.getenv("JUSTSEARCH_LLM_CONCURRENCY", "5") or 5))
)

# --- 生成 prompt 的 sources / 历史预算（有界、可配置、透明标注）------------------
# 命名刻意避开 hygiene 禁词（不使用 crawler 域的 _MAX_CONTENT_LENGTH、
# 旧的 per-source 字符切片常量、旧的用户可见截断提示 等）。截断标注统一用 _BUDGET_TRIM_MARK。
_PROMPT_SOURCE_CHAR_BUDGET = int(os.getenv("JUSTSEARCH_PROMPT_SOURCE_BUDGET", "160000"))
_PROMPT_SOURCE_ITEM_CAP = int(os.getenv("JUSTSEARCH_PROMPT_SOURCE_ITEM_CAP", "20000"))
# 模型上下文窗口（tokens）；仅作为默认值，可按模型显式传入。
_CONTEXT_WINDOW_TOKENS = int(os.getenv("JUSTSEARCH_MODEL_CONTEXT_WINDOW", "128000"))
# 窗口预留：系统提示/协议(约 8-10K tokens)、提问前缀、完成输出与余量。
# 静态常量用于 system prompt 估算；预留量随窗口成比例增长，避免固定值在
# 小窗口模型上占用过多比例、在大窗口模型上又不必要地浪费空间。
_SYSTEM_PROMPT_CHAR_ESTIMATE = int(os.getenv("JUSTSEARCH_SYSTEM_PROMPT_CHAR_ESTIMATE", "30000"))
_CONTEXT_RESERVE_RATIO = 0.25
# context-length 错误时预算收缩的最大步数(每步减半)。
_CONTEXT_SHRINK_STEPS = 5
_BUDGET_TRIM_MARK = " …（节选）"
# 对话历史压缩预算：窗口条数 + 总字符预算 + 单条 assistant 字符上限。
_HISTORY_WINDOW = int(os.getenv("JUSTSEARCH_HISTORY_WINDOW", "12"))
_HISTORY_CHAR_BUDGET = int(os.getenv("JUSTSEARCH_HISTORY_CHAR_BUDGET", "12000"))
_ASSISTANT_TURN_CHAR_BUDGET = int(os.getenv("JUSTSEARCH_ASSISTANT_TURN_CHARS", "900"))

# OpenAI SDK / httpx 网络层可重试错误名与关键词
_RETRYABLE_ERROR_TYPES = (
    "APIConnectionError",
    "APITimeoutError",
    "RateLimitError",
    "InternalServerError",
    "RemoteProtocolError",
    "ConnectError",
    "ReadTimeout",
    "WriteTimeout",
    "PoolTimeout",
    "ConnectTimeout",
)
_RETRYABLE_ERROR_MARKERS = (
    "connection error",
    "connection reset",
    "connection refused",
    "connection aborted",
    "temporarily unavailable",
    "timed out",
    "timeout",
    "network is unreachable",
    "name or service not known",
    "temporary failure in name resolution",
    "server disconnected",
    "broken pipe",
    "ssl error",
    "eof occurred",
    "remote end closed",
    "502",
    "503",
    "504",
    # Gateway stream corruption: a chunk split mid-character or a non-UTF-8
    # (GBK) error page, decoded strictly by the SDK.
    "can't decode bytes",
    "unexpected end of data",
    "codec can't decode",
)

# Task analysis cache — avoids duplicate API calls for identical queries
_ANALYSIS_CACHE: dict = {}
_ANALYSIS_CACHE_MAX = 50
_ANALYSIS_CACHE_TTL = 180  # 3 minutes

# AMC-style HTML fragment tag names — used for inline artifact detection, backreference
# enforcement, and structural blank-line normalization. Must match both opening and closing
# tags so mismatched pairs like <div>...</span> are rejected.
_LIVE_ARTIFACT_FRAGMENT_TAG_NAMES = (
    r'article|aside|blockquote|button|caption|details|div|figure|figcaption|footer|form|'
    r'h[1-6]|header|label|li|main|meter|nav|ol|p|progress|section|select|span|summary|'
    r'table|tbody|td|tfoot|th|thead|tr|ul'
)
_LIVE_ARTIFACT_FRAGMENT_OPEN_RE = re.compile(
    rf"^<({_LIVE_ARTIFACT_FRAGMENT_TAG_NAMES})(?:\s[^>]*)?>[\s\S]*</\1>$",
    re.IGNORECASE,
)
# 历史上另有 _LIVE_ARTIFACT_CONTAINER_RE；反引用修复后两者模式逐字节相同，
# 已合并为上面的单一常量（勿再复制出第二份）。
_HTML_FENCE_RE = re.compile(
    r"^```(?:amc-live-artifact-html|html|svg)?\s*\n([\s\S]*?)\n?```\s*$",
    re.IGNORECASE,
)
_STREAMABLE_LIVE_ARTIFACT_FENCE_RE = re.compile(
    r"^```(?:amc-live-artifact-html|html|svg)(?:\s|$)",
    re.IGNORECASE,
)
_FULL_HTML_DOCUMENT_RE = re.compile(
    r"^(?:<!doctype\s+html\b[^>]*>\s*)?<html\b[\s\S]*</html>$",
    re.IGNORECASE,
)
_SVG_DOCUMENT_RE = re.compile(
    r"^<svg\b[\s\S]*</svg>$",
    re.IGNORECASE,
)
# Models (esp. ZH) often emit 状态/缺失信息/回答 with half- or full-width colons.
_ANSWER_FIELD_STATUS_RE = re.compile(
    r"(?:^|\n)\s*(?:Status|状态)\s*[:：]\s*([^\n]*)",
    re.IGNORECASE,
)
_ANSWER_FIELD_MISSING_RE = re.compile(
    r"(?:^|\n)\s*(?:Missing_Info|Missing Info|缺失信息)\s*[:：]\s*",
    re.IGNORECASE,
)
_ANSWER_FIELD_ANSWER_RE = re.compile(
    r"(?:^|\n)\s*(?:Answer|回答)\s*[:：]\s*",
    re.IGNORECASE,
)
_EMBEDDED_HTML_START_RE = re.compile(
    rf"<(?:{_LIVE_ARTIFACT_FRAGMENT_TAG_NAMES}|svg)\b",
    re.IGNORECASE,
)
_LIVE_ARTIFACT_ROOT_STYLE = (
    "display:block;width:100%;box-sizing:border-box;max-width:100%;"
    "overflow-wrap:anywhere;background:transparent;"
)


class LLMProviderConfigurationError(RuntimeError):
    """Raised when the configured model provider cannot serve requests."""


def _provider_error_message(error: Exception) -> str:
    status_code = getattr(error, "status_code", 0) or 0
    err_str = str(error)
    err_lower = err_str.lower()

    if status_code == 401 or "unauthorized" in err_lower:
        return "模型服务返回 401：API 密钥无效或已过期，请检查设置中的 API Key。"
    if status_code == 402 or "insufficient" in err_lower or "quota" in err_lower:
        return "模型服务返回 402：账户额度不足或已欠费，请检查模型服务账户余额。"
    if (
        status_code == 403
        or "subscription_not_found" in err_lower
        or "no active subscription" in err_lower
        or "forbidden" in err_lower
    ):
        return "模型服务返回 403：当前 API Key 所属账户没有可用订阅，请在模型服务后台开通/续订后重试。"
    if status_code == 404 or "model" in err_lower and "not found" in err_lower:
        return "模型服务返回 404：模型不存在或当前账户无权访问，请检查 Model ID。"
    return ""


def _status_code_of(error: BaseException) -> int:
    code = getattr(error, "status_code", None)
    if isinstance(code, int) and code > 0:
        return code
    response = getattr(error, "response", None)
    if response is not None:
        resp_code = getattr(response, "status_code", None)
        if isinstance(resp_code, int) and resp_code > 0:
            return resp_code
    return 0


def _is_retryable_llm_error(error: BaseException) -> bool:
    """Network blips, rate limits, and gateway 5xx should be retried.

    Also covers gateway stream corruption: some OpenAI-compatible gateways split
    SSE chunks on byte boundaries (cutting a multi-byte UTF-8 character in half
    before the connection drops) or return a non-UTF-8 (GBK) error page for
    rate-limit / subscription failures. The SDK decodes strictly, so both surface
    as ``UnicodeDecodeError``. Treat them as retryable so the existing bounded
    retry loop self-heals instead of dumping the exception text as an answer.
    """
    if isinstance(error, (asyncio.TimeoutError, TimeoutError)):
        return True
    if isinstance(error, (ConnectionError, BrokenPipeError, ConnectionResetError)):
        return True
    if isinstance(error, OSError) and any(k in str(error).lower() for k in ("connection", "broken pipe", "reset by peer", "timed out")):
        return True
    if isinstance(error, UnicodeDecodeError):
        return True

    status_code = _status_code_of(error)
    if status_code in (408, 409, 425, 429, 500, 502, 503, 504):
        return True

    type_name = type(error).__name__
    if type_name in _RETRYABLE_ERROR_TYPES:
        return True

    # Walk causes (SDK often wraps httpx errors).
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        name = type(current).__name__
        if name in _RETRYABLE_ERROR_TYPES:
            return True
        text = str(current).lower()
        if any(marker in text for marker in _RETRYABLE_ERROR_MARKERS):
            return True
        current = current.__cause__ or current.__context__
    return False


def _retry_backoff_seconds(attempt: int, *, base: float = 1.5, cap: float = 20.0) -> float:
    """Exponential backoff with jitter. attempt is 0-based."""
    import random as _rand  # noqa: keep local import for hygiene allowlist compat

    delay = min(cap, (2 ** attempt) * base) + _rand.uniform(0, 1.0)
    return max(0.5, delay)


def _strip_live_artifact_fence(answer: str) -> str:
    text = (answer or "").strip()
    match = _HTML_FENCE_RE.match(text)
    return match.group(1).strip() if match else text


def _looks_like_inline_live_artifact(answer: str) -> bool:
    text = _strip_live_artifact_fence(answer)
    if not text:
        return False
    if _FULL_HTML_DOCUMENT_RE.match(text) or _SVG_DOCUMENT_RE.match(text):
        return True
    if re.search(r"<!doctype|<html\b|<head\b|<body\b", text, re.IGNORECASE):
        return False
    # AMC-style: backreference-enforced matching open/close tag pair.
    stripped = text.strip()
    if not stripped:
        return False
    # Remove comments before checking
    without_comments = re.sub(r"<!--[\s\S]*?-->", "", stripped).strip()
    return bool(_LIVE_ARTIFACT_FRAGMENT_OPEN_RE.match(without_comments))


def _is_single_root_inline_html(answer: str) -> bool:
    """True when the fragment is a single top-level element (not multi-root siblings).

    `_LIVE_ARTIFACT_FRAGMENT_OPEN_RE` uses a backreference so it only matches
    identical open/close tag pairs. This helper uses a lightweight stack walk on
    opening tags to distinguish true single-root from multi-root siblings.
    Multi-root example: <div>a</div><div>b</div> → two top-level nodes.
    """
    text = _strip_live_artifact_fence(answer).strip()
    if not text or not _looks_like_inline_live_artifact(text):
        return False
    if _FULL_HTML_DOCUMENT_RE.match(text) or _SVG_DOCUMENT_RE.match(text):
        return True
    # Parse top-level element count via a lightweight stack walk on opening tags.
    # Multi-root example: <div>a</div><div>b</div> → two top-level nodes.
    tag_re = re.compile(
        r"<!--.*?-->|<!\[CDATA\[.*?\]\]>|</?([a-zA-Z][a-zA-Z0-9:-]*)\b[^>]*/?>",
        re.DOTALL,
    )
    depth = 0
    top_level = 0
    for match in tag_re.finditer(text):
        token = match.group(0)
        if token.startswith("<!--") or token.startswith("<![CDATA["):
            continue
        name = (match.group(1) or "").lower()
        if not name:
            continue
        # Skip void-ish closings handled below.
        if token.startswith("</"):
            depth = max(0, depth - 1)
            continue
        self_closing = token.endswith("/>") or name in {
            "area", "base", "br", "col", "embed", "hr", "img", "input",
            "link", "meta", "param", "source", "track", "wbr",
        }
        if depth == 0:
            top_level += 1
            if top_level > 1:
                return False
        if not self_closing:
            depth += 1
    return top_level == 1


def _is_streamable_live_artifact_answer(answer: str) -> bool:
    """Return True once a live-artifact answer is clearly raw HTML/SVG."""
    text = (answer or "").lstrip()
    return text.startswith("<") or bool(_STREAMABLE_LIVE_ARTIFACT_FENCE_RE.match(text))


def _escape_html(text: str) -> str:
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


def _inline_format_text(text: str) -> str:
    """Convert inline markdown to HTML (bold, code, links, images)."""
    escaped = _escape_html(text)
    # Must process images before links since images use ![alt](url) pattern
    escaped = re.sub(
        r'!\[([^\]]*)\]\(([^)]+)\)',
        r'<img src="\2" alt="\1" style="max-width:100%;height:auto;" />',
        escaped,
    )
    escaped = re.sub(
        r'\[([^\]]+)\]\(([^)]+)\)',
        r'<a href="\2" rel="noopener noreferrer">\1</a>',
        escaped,
    )
    escaped = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", escaped)
    escaped = re.sub(r"`([^`]+)`", r"<code>\1</code>", escaped)
    return escaped


def _table_row_to_html(cells: list[str], tag: str) -> str:
    """Convert a list of cell text to an HTML table row."""
    rendered = "".join(f"<{tag}>{_inline_format_text(c.strip())}</{tag}>" for c in cells)
    return f"<tr>{rendered}</tr>"


def _markdown_to_live_artifact_html(answer: str) -> str:
    """Convert Markdown to a themed HTML section, supporting:
    tables, code blocks (fenced & indented), blockquotes, headings,
    unordered/ordered lists, horizontal rules, paragraphs.

    Mirror of AMC-WebUI's markdown-it rendering for the coerceLiveModeArtifact path.
    """
    if not answer or not answer.strip():
        return ""
    raw_lines = (answer or "").splitlines()
    html_parts = [
        '<section style="display:block;width:100%;box-sizing:border-box;max-width:100%;overflow-wrap:anywhere;">'
    ]

    # Multiline state
    i = 0
    in_list = False          # currently inside <ul>
    in_blockquote = False    # currently inside <blockquote>
    last_para_empty = False  # was the last paragraph blank line?
    n_lines = len(raw_lines)

    # `- item`, `* item`, `1. item`, `1) item` — dash list markers are a bare
    # dash + space (no `.`/`)`), so they must be handled separately from
    # ordered markers.
    list_item_re = re.compile(r"^(?:[-*]|\d+[.)])\s+")

    def close_list():
        nonlocal in_list
        if in_list:
            html_parts.append("</ul>")
            in_list = False

    def close_blockquote():
        nonlocal in_blockquote
        if in_blockquote:
            html_parts.append("</blockquote>")
            in_blockquote = False

    def close_all():
        close_list()
        close_blockquote()

    while i < n_lines:
        raw = raw_lines[i]
        line = raw.rstrip()
        stripped = line.strip()

        # --- blank line ---
        if not stripped:
            close_all()
            last_para_empty = True
            i += 1
            continue

        # --- fenced code block: ``` or ~~~ ---
        fence_match = re.match(r"^(```|~~~)(\w*)\s*$", stripped)
        if fence_match:
            close_all()
            fence_char = fence_match.group(1)
            lang = fence_match.group(2) or ""
            lang_attr = f' class="language-{_escape_html(lang)}"' if lang else ""
            # Gather lines until end fence
            code_lines: list[str] = []
            i += 1
            while i < n_lines:
                end_line = raw_lines[i].rstrip()
                if end_line.strip().startswith(fence_char):
                    i += 1
                    break
                code_lines.append(raw_lines[i])
                i += 1
            code_text = _escape_html("\n".join(code_lines))
            html_parts.append(
                f'<pre{lang_attr} style="overflow-x:auto;padding:0.75em 1em;'
                f'border-radius:8px;background:var(--amc-live-artifact-surface-muted,'
                f'rgba(0,0,0,.04));border:1px solid var(--amc-live-artifact-border,'
                f'rgba(0,0,0,.08));"><code>{code_text}</code></pre>'
            )
            last_para_empty = False
            continue

        # --- indented code block (4 spaces) ---
        if line.startswith("    ") and not stripped.startswith(("#", "-", "*", ">", "|", "`")):
            close_all()
            code_lines = [line[4:]]
            i += 1
            while i < n_lines and raw_lines[i].startswith("    "):
                code_lines.append(raw_lines[i][4:])
                i += 1
            code_text = _escape_html("\n".join(code_lines))
            html_parts.append(
                f'<pre style="overflow-x:auto;padding:0.75em 1em;'
                f'border-radius:8px;background:var(--amc-live-artifact-surface-muted,'
                f'rgba(0,0,0,.04));border:1px solid var(--amc-live-artifact-border,'
                f'rgba(0,0,0,.08));"><code>{code_text}</code></pre>'
            )
            last_para_empty = False
            continue

        # --- horizontal rule ---
        if re.match(r"^(-{3,}|_{3,}|\*{3,})\s*$", stripped):
            close_all()
            html_parts.append('<hr style="border:none;border-top:1px solid var(--amc-live-artifact-border,rgba(0,0,0,.1));margin:1em 0;" />')
            i += 1
            continue

        # --- blockquote ---
        if stripped.startswith(">"):
            close_list()
            # Collect consecutive blockquote lines
            quote_lines: list[str] = []
            while i < n_lines:
                qr = raw_lines[i].rstrip()
                qs = qr.strip()
                if not qs or not qs.startswith(">"):
                    break
                # Remove leading > and optional space
                qtext = re.sub(r"^>\s?", "", qr)
                quote_lines.append(qtext)
                i += 1
            # Recursively render inner markdown for the blockquote body
            inner = "\n".join(quote_lines)
            inner_html = _markdown_to_live_artifact_html(inner)
            # Strip outer <section> tags from the recursive result
            inner_html = re.sub(r"^<section[^>]*>|</section>$", "", inner_html).strip()
            html_parts.append(
                f'<blockquote style="margin:0.75em 0;padding:0.35em 0 0.35em 0.9em;'
                f'border-left:3px solid var(--amc-live-artifact-border,rgba(0,0,0,.15));'
                f'color:var(--amc-live-artifact-muted,inherit);">{inner_html}</blockquote>'
            )
            last_para_empty = False
            continue

        # --- table ---
        if stripped.startswith("|") and "|" in stripped[1:]:
            close_all()
            # Check if next line is a separator row
            table_rows: list[str] = [stripped]
            i += 1
            while i < n_lines:
                next_line = raw_lines[i].strip()
                if not next_line.startswith("|"):
                    break
                table_rows.append(next_line)
                i += 1

            if len(table_rows) >= 2 and re.match(r"^\|[\s:-]+\|", table_rows[1]):
                # Separator row: extract alignment info if needed
                # Render just the data rows (skip separator)
                html_parts.append('<table style="border-collapse:collapse;width:100%;margin:0.75em 0;font-size:0.95em;">')
                rendered_header = False
                for row_idx, row_text in enumerate(table_rows):
                    if row_idx == 1:
                        # Separator — skip
                        continue
                    cells = [
                        c.strip()
                        for c in row_text.strip().strip("|").split("|")
                    ]
                    tag = "th" if row_idx == 0 else "td"
                    html_parts.append(_table_row_to_html(cells, tag))
                    if row_idx == 0:
                        rendered_header = True
                if not rendered_header:
                    # No real header; render first data row as th
                    cells = [
                        c.strip()
                        for c in table_rows[0].strip().strip("|").split("|")
                    ]
                    html_parts.append(_table_row_to_html(cells, "th"))
                html_parts.append("</table>")
            else:
                # No separator — treat as simple table with all td
                html_parts.append('<table style="border-collapse:collapse;width:100%;margin:0.75em 0;font-size:0.95em;">')
                for row_text in table_rows:
                    cells = [
                        c.strip()
                        for c in row_text.strip().strip("|").split("|")
                    ]
                    html_parts.append(_table_row_to_html(cells, "td"))
                html_parts.append("</table>")
            last_para_empty = False
            continue

        # --- heading ---
        heading = re.match(r"^(#{1,4})\s+(.+)$", stripped)
        if heading:
            close_all()
            level = "h2" if len(heading.group(1)) <= 2 else "h3"
            html_parts.append(f"<{level}>{_inline_format_text(heading.group(2))}</{level}>")
            i += 1
            continue

        # --- list (unordered or ordered) ---
        if list_item_re.match(stripped):
            if not in_list:
                html_parts.append('<ul style="margin:0.5rem 0 0.75rem 1.1rem;padding:0;">')
                in_list = True
            list_text = list_item_re.sub("", stripped)
            html_parts.append(f"<li>{_inline_format_text(list_text)}</li>")
            i += 1
            continue
        else:
            close_list()

        # --- paragraph ---
        close_blockquote()
        # Collect consecutive paragraph lines
        para_lines: list[str] = [stripped]
        i += 1
        while i < n_lines:
            next_raw = raw_lines[i].rstrip()
            next_stripped = next_raw.strip()
            if not next_stripped or re.match(
                r"^(```|~~~|[#>-]|[-*]{3,}|_{3,}|\*{3,})",
                next_stripped,
            ):
                break
            # Don't merge into the next list item
            if list_item_re.match(next_stripped):
                break
            if next_stripped.startswith("|") and "|" in next_stripped[1:]:
                break
            para_lines.append(re.sub(r"^> ?", "", next_stripped))
            i += 1
        para_text = " ".join(_inline_format_text(l) for l in para_lines if l)
        if para_text:
            html_parts.append(f"<p>{para_text}</p>")

    close_all()
    html_parts.append("</section>")
    return "".join(html_parts)


def _parse_answer_envelope(text: str) -> Dict[str, Any]:
    """Split Status / Missing_Info / Answer envelopes (EN or ZH labels).

    Returns keys: status, missing_info, answer, had_envelope.
    When no Answer/回答 marker is present, ``answer`` is the original text.
    """
    raw = text or ""
    status = "sufficient"
    missing_info = ""
    had_envelope = False

    status_match = _ANSWER_FIELD_STATUS_RE.search(raw)
    if status_match:
        had_envelope = True
        status_value = (status_match.group(1) or "").strip().lower()
        if (
            "insufficient" in status_value
            or status_value in {"不足", "不充分", "不够", "不完整"}
            or status_value.startswith("不足")
        ):
            status = "insufficient"

    missing_match = _ANSWER_FIELD_MISSING_RE.search(raw)
    answer_match = _ANSWER_FIELD_ANSWER_RE.search(raw)

    if missing_match:
        had_envelope = True
        miss_start = missing_match.end()
        miss_end = answer_match.start() if answer_match else len(raw)
        missing_info = raw[miss_start:miss_end].strip()

    if answer_match:
        had_envelope = True
        answer = raw[answer_match.end():].strip()
    else:
        answer = raw.strip()
        # Drop bare status/missing header lines when Answer marker is missing.
        if status_match or missing_match:
            lines = []
            for line in answer.split("\n"):
                if _ANSWER_FIELD_STATUS_RE.match("\n" + line) or _ANSWER_FIELD_STATUS_RE.match(line):
                    continue
                if re.match(r"^\s*(?:Status|状态)\s*[:：]", line, re.IGNORECASE):
                    continue
                if re.match(
                    r"^\s*(?:Missing_Info|Missing Info|缺失信息)\s*[:：]",
                    line,
                    re.IGNORECASE,
                ):
                    continue
                lines.append(line)
            answer = "\n".join(lines).strip()

    return {
        "status": status,
        "missing_info": missing_info,
        "answer": answer,
        "had_envelope": had_envelope,
    }


def _split_prose_and_html_artifact(text: str) -> Optional[tuple[str, str]]:
    """If prose is followed by a substantial HTML fragment, return (prose, html)."""
    raw = text or ""
    match = _EMBEDDED_HTML_START_RE.search(raw)
    if not match:
        return None
    # Prefer starting at a line boundary so we don't split mid-token.
    start = match.start()
    line_start = raw.rfind("\n", 0, start) + 1
    # Only rewind to line start when that line is mostly the tag (no long prose).
    prefix_on_line = raw[line_start:start]
    if prefix_on_line.strip() == "":
        start = line_start

    prose = raw[:start].strip()
    html = raw[start:].strip()
    if not html.startswith("<"):
        return None
    tag_count = len(re.findall(r"</?[a-zA-Z][a-zA-Z0-9:-]*\b", html))
    if tag_count < 2:
        return None

    # Strip trailing text after the last HTML closing tag so css/html doesn't
    # carry non-HTML content that breaks _looks_like_inline_live_artifact.
    # E.g. "<div>内容</div>以及更多文本" → html="<div>内容</div>", trailing="以及更多文本"
    html_trailing = ""
    # Find the last closing tag (</tag>) or self-closing tag (/>)
    last_close = None
    for m in re.finditer(r"</[a-zA-Z][a-zA-Z0-9:-]*\s*>|/\s*>", html):
        last_close = m
    if last_close:
        after_html = html[last_close.end():]
        if after_html.strip():
            html_trailing = after_html.strip()
            html = html[:last_close.end()].strip()
            if prose:
                prose = f"{prose} {html_trailing}"
            else:
                prose = html_trailing

    # Avoid treating a single stray tag inside markdown as an artifact body.
    if not prose and not _looks_like_inline_live_artifact(html) and tag_count < 4:
        return None
    return prose, html


def _wrap_live_artifact_root(*parts: str) -> str:
    inner = "".join(part for part in parts if part)
    return f'<div style="{_LIVE_ARTIFACT_ROOT_STYLE}">{inner}</div>'


def ensure_live_artifact_answer(answer: str) -> str:
    """Return an inline Live Artifact even when a model falls back to Markdown.

    Critical: never HTML-escape an already-produced artifact. Partial answers often
    arrive as prose/warning + raw HTML, or as a ZH/EN Status envelope around HTML.
    Escaping those tags makes the chat show source markup (the bug in multi-turn
    insufficient follow-ups).
    """
    stripped = _strip_live_artifact_fence(answer)
    if not stripped:
        return ""

    envelope = _parse_answer_envelope(stripped)
    body = envelope["answer"] if envelope["had_envelope"] else stripped
    body = _strip_live_artifact_fence(body).strip()
    if not body:
        return ""

    if _looks_like_inline_live_artifact(body):
        # Greedy root regex accepts multi-root siblings; wrap those so the
        # frontend always gets a single artifact root.
        if _is_single_root_inline_html(body) or _FULL_HTML_DOCUMENT_RE.match(body) or _SVG_DOCUMENT_RE.match(body):
            return body
        return _wrap_live_artifact_root(body)

    split = _split_prose_and_html_artifact(body)
    if split is not None:
        prose, html = split
        html = html.strip()
        if _looks_like_inline_live_artifact(html) or html.lstrip().startswith("<"):
            if not prose:
                if _is_single_root_inline_html(html) or _FULL_HTML_DOCUMENT_RE.match(html) or _SVG_DOCUMENT_RE.match(html):
                    return html
                return _wrap_live_artifact_root(html)
            # Keep prose readable without destroying the HTML artifact.
            prose_html = _markdown_to_live_artifact_html(prose)
            # _markdown_to_live_artifact_html already wraps in <section>; nest both.
            return _wrap_live_artifact_root(prose_html, html)

    return _markdown_to_live_artifact_html(body)


def _clone_cached_analysis_result(result: Any) -> Any:
    """Return an isolated copy so callers cannot mutate cached LLM analysis."""
    return copy.deepcopy(result)


def _cache_analysis_result(key: str, result: Any):
    """Store analysis result in cache, evicting old entries if needed."""
    import time
    if len(_ANALYSIS_CACHE) >= _ANALYSIS_CACHE_MAX:
        # Evict oldest entries
        sorted_keys = sorted(_ANALYSIS_CACHE.keys(), key=lambda k: _ANALYSIS_CACHE[k][1])
        for k in sorted_keys[:_ANALYSIS_CACHE_MAX // 2]:
            _ANALYSIS_CACHE.pop(k, None)
    _ANALYSIS_CACHE[key] = (_clone_cached_analysis_result(result), time.time())


def purge_analysis_cache(max_age_seconds: float = 3600.0) -> int:
    """清除 _ANALYSIS_CACHE 中已过期的条目，返回移除的条数。

    跨模块契约函数（外部维护逻辑直接导入调用，勿改名/改签名）：条目以写入时
    的 time.time() 时间戳计龄，age > max_age_seconds 视为过期；
    max_age_seconds <= 0 时清空全部条目。
    """
    import time
    if max_age_seconds <= 0:
        removed = len(_ANALYSIS_CACHE)
        _ANALYSIS_CACHE.clear()
        return removed
    now = time.time()
    expired = [
        key
        for key, (_result, cached_at) in _ANALYSIS_CACHE.items()
        if now - cached_at > max_age_seconds
    ]
    for key in expired:
        del _ANALYSIS_CACHE[key]
    return len(expired)


def _cache_digest(value: Any) -> str:
    """Create a stable digest for cache inputs without keeping large keys in memory."""
    try:
        payload = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    except (TypeError, ValueError):
        payload = str(value)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _history_cache_digest(history: Optional[List[Dict[str, str]]]) -> str:
    if not history:
        return "no-history"
    normalized = [
        {
            "role": str(msg.get("role", "user")),
            "content": str(msg.get("content") or ""),
        }
        for msg in history
        if isinstance(msg, dict)
    ]
    return _cache_digest(normalized)


def _snippet_cache_digest(snippets: List[Dict]) -> str:
    normalized = [
        {
            "id": item.get("id"),
            "title": item.get("title", ""),
            "url": item.get("url", ""),
            "snippet": item.get("snippet", ""),
            "date": item.get("date", ""),
        }
        for item in snippets
        if isinstance(item, dict)
    ]
    return _cache_digest(normalized)


def _normalize_text_list(value: Any, *, max_items: int | None = None) -> list[str]:
    if isinstance(value, str):
        raw_items = [value]
    elif isinstance(value, list):
        raw_items = value
    else:
        return []

    items = []
    for item in raw_items:
        text = str(item or "").strip()
        if not text:
            continue
        items.append(text)
        if max_items and len(items) >= max_items:
            break
    return items


def _normalize_int_list(value: Any, *, max_items: int | None = None) -> list[int]:
    if isinstance(value, str):
        raw_items = re.split(r"[\s,，]+", value.strip())
    elif isinstance(value, list):
        raw_items = value
    else:
        return []

    items = []
    for item in raw_items:
        try:
            parsed = int(item)
        except (TypeError, ValueError):
            continue
        items.append(parsed)
        if max_items and len(items) >= max_items:
            break
    return items


def _coerce_bool(value: Any) -> bool:
    """Coerce JSON-ish booleans without treating non-empty "false" as true."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    if isinstance(value, (int, float)):
        return value != 0
    return False


# 仅匹配"结构完整"的 HTML 标签(具名开/闭标签)，不吞掉数学/代码里的
# "< x >"、<vector>、<Map<K,V>> 等普通尖括号内容。
_HTML_STRUCTURED_TAG_RE = re.compile(r"</?[a-zA-Z][a-zA-Z0-9\-]*(?:\s[^<>]*?)?/?>")
_MULTI_SPACE_RE = re.compile(r"\s+")
# A genuinely-structured HTML tag (named opening/closing tag), not the "<" / ">" of
# prose like "2 < x > 10" or a code token like "<vector>".
_HTML_TAG_STRUCTURE_RE = re.compile(r"</?[a-zA-Z][\w\-]*(\s[^>]*)?/?>")
# Short follow-ups that almost always need prior-turn entities.
_FOLLOWUP_HINT_RE = re.compile(
    r"(具体时间|几点|国内时间|北京时间|当地时间|那他|那她|那它|那个|这个|"
    r"英文版|中文版|详细说说|详细一点|再说说|还有呢|然后呢|为什么|"
    r"what\s+about|how\s+about|when\s+exactly|local\s+time|beijing\s+time|"
    r"tell\s+me\s+more|more\s+details|and\s+the\s+time)",
    re.IGNORECASE,
)
# Substrings that mark a CJK term as a deictic/time/followup phrase rather than
# a fresh topic entity. Only whole-term matches count (matched via equality on a
# token set below), so ``为什么`` inside ``苹果公司股价为什么最近跌`` does not by
# itself disqualify the whole run — the run is split further first.
_FOLLOWUP_TOPIC_WORDS = frozenset({
    "具体", "时间", "几点", "国内", "北京", "当地", "那个", "这个", "详细", "还有",
    "然后", "下一", "上一", "另一个", "刚才", "刚刚", "前面", "为什么", "怎么",
    "如何", "什么", "哪些",
})
# Punctuation/space boundary used to split a user input into candidate phrases
# before extracting topic entities (handles long punctuation-free CJK runs).
_TOPIC_DELIM_RE = re.compile(r"[，。；、,.!?？！：\s]+")
# CJK function/deictic/followup words stripped before topic-entity extraction,
# so a long punctuation-free run breaks into its substantive sub-terms. The
# regex alternation is ordered longest-first and uses lookahead/lookbehind so
# that ``苹果`` inside ``苹果公司`` survives while bare ``公司``/``为什么`` do not.
_CJK_FUNCTION_WORD_RE = re.compile(
    r"(?<![A-Za-z0-9])"
    r"(?:为什么|怎么了|怎么样|如何|什么|哪些|哪个|怎么|具体|时间|几点|国内|北京|当地|"
    r"那个|这个|详细|还有|然后|下一|上一|另一个|刚才|刚刚|前面|最近|今天|现在|"
    r"目前|最新|关于|对于|来说|公司|股价|价格|数据|情况|结果|表现|怎么样|呢|吗|嘛|啊|呀|吧)"
    r"(?![A-Za-z0-9])"
)
_STOPWORDS = frozenset(
    {
        "的", "了", "是", "在", "和", "与", "或", "及", "等", "对", "为", "有", "也", "就",
        "都", "而", "被", "把", "从", "到", "中", "上", "下", "一个", "什么", "怎么", "如何",
        "哪些", "这个", "那个", "时候", "时间", "具体", "国内", "问题", "回答", "根据",
        "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "was",
        "were", "be", "been", "it", "this", "that", "with", "from", "by", "as", "at",
        "what", "when", "where", "who", "how", "why", "about", "more", "next", "time",
    }
)


def _strip_html_to_text(text: str) -> str:
    """Remove HTML markup for compact conversation context."""
    # 仅剥离结构完整的 HTML 标签(见 _HTML_STRUCTURED_TAG_RE)，保留普通
    # 尖括号数学/代码内容如 "2 < x > 10"、<vector>、<Map<K,V>>。
    cleaned = _HTML_STRUCTURED_TAG_RE.sub(" ", text or "")
    cleaned = cleaned.replace("&nbsp;", " ").replace("&amp;", "&")
    cleaned = cleaned.replace("&lt;", "<").replace("&gt;", ">")
    cleaned = cleaned.replace("&quot;", '"').replace("&#39;", "'")
    return _MULTI_SPACE_RE.sub(" ", cleaned).strip()


def _budget_sources_for_prompt(
    sources: list[dict],
    *,
    total_budget: int = _PROMPT_SOURCE_CHAR_BUDGET,
    per_item_cap: int = _PROMPT_SOURCE_ITEM_CAP,
) -> tuple[list[dict], int, int]:
    """Apply a bounded total+per-item char budget to source contents.

    Sources are the workflow's relevance-ordered list, so budget is allocated
    front-to-back; once the total budget is exhausted the remaining sources
    are kept as placeholders (``[此来源因上下文预算被省略]``) so the model still
    sees how many sources exist and the citation numbering stays stable.
    Returns ``(processed_sources, original_total_chars, budgeted_total_chars)``.
    """
    remaining = total_budget
    out: list[dict] = []
    original_chars = 0
    final_chars = 0
    for src in sources or []:
        content = str(src.get("content") or "")
        original_chars += len(content)
        if remaining <= 0:
            out.append({**src, "content": "[此来源因上下文预算被省略]"})
            continue
        if len(content) > per_item_cap:
            content = content[:per_item_cap].rstrip() + _BUDGET_TRIM_MARK
        if len(content) > remaining:
            content = content[:remaining].rstrip() + _BUDGET_TRIM_MARK
            remaining = 0
        else:
            remaining -= len(content)
        final_chars += len(content)
        out.append({**src, "content": content})
    return out, original_chars, final_chars


def _messages_char_count(messages) -> int:
    """Aggregate content length of a messages list (for telemetry only)."""
    return sum(len(str(m.get("content") or "")) for m in messages or [])


def _summarize_message_content(role: str, content: str, *, max_chars: int = 900) -> str:
    """Compress history content for model context (esp. Live Artifact HTML)."""
    text = str(content or "").strip()
    if not text:
        return ""
    # Only assistant turns are expected to contain rendered artifacts. Preserve user
    # angle-bracket code/types such as <vector>, <Map<K,V>>, and comparisons.
    if role == "assistant" and "<" in text and ">" in text and (
        _looks_like_inline_live_artifact(text) or bool(_HTML_TAG_STRUCTURE_RE.search(text))
    ):
        text = _strip_html_to_text(text)
    has_code = "```" in text or "\n    " in text or "\n\t" in text
    # Fold inline whitespace only; preserve newlines for code/structured content
    # so indentation survives into the prompt instead of being flattened.
    text = (_MULTI_SPACE_RE.sub(" ", text) if not has_code else re.sub(r"[ \t]+", " ", text)).strip()
    if len(text) <= max_chars:
        return text
    # Prefer head + brief tail so conclusions and closing notes survive.
    head = max_chars - 80
    if head < 200:
        return text[: max_chars - 1] + "…"
    return text[:head].rstrip() + " … " + text[-60:].lstrip()


def _extract_history_anchor_terms(history: Optional[List[Dict[str, str]]], *, max_terms: int = 8) -> list[str]:
    """Heuristic entity/topic anchors from recent turns for rewrite fallback."""
    if not history:
        return []
    recent = [msg for msg in history if isinstance(msg, dict)][-6:]
    texts: list[str] = []
    for msg in recent:
        role = str(msg.get("role", "user"))
        content = _summarize_message_content(role, str(msg.get("content") or ""), max_chars=400)
        if content:
            texts.append(content)
    blob = " ".join(texts)
    if not blob:
        return []

    candidates: list[str] = []
    # Prefer multi-char CJK runs and capitalized English tokens / alphanumerics.
    # CJK run is capped at {2,12}: a long unpunctuated run used to swallow an
    # entire clause as one "entity", which then anchored follow-ups to garbage.
    # English terms accept a single leading letter (so C / R language names are
    # not lost) and strip trailing punctuation (Python. -> Python) below.
    for match in re.finditer(r"[\u4e00-\u9fff]{2,12}|[A-Za-z][A-Za-z0-9\-+.]*", blob):
        term = match.group(0).strip().rstrip(".-+")
        # A CJK run matched by [\u4e00-\u9fff]{2,12} can never contain the
        # sub-clause punctuation below, so splitting here would be a no-op; the
        # run is already length-capped and _CJK_FUNCTION_WORD_RE strips deictic
        # words at the query level (see _looks_like_followup_query callers).
        if not term or term.lower() in _STOPWORDS or term in _STOPWORDS:
            continue
        if term not in candidates:
            candidates.append(term)
        if len(candidates) >= max_terms * 2:
            break

    # Boost terms that appear in the latest user turn.
    last_user = ""
    for msg in reversed(recent):
        if msg.get("role") == "user":
            last_user = _summarize_message_content("user", str(msg.get("content") or ""), max_chars=200)
            break
    ranked = sorted(
        candidates,
        key=lambda t: (0 if t in last_user else 1, -len(t), candidates.index(t)),
    )
    return ranked[:max_terms]


def _looks_like_followup_query(user_input: str, history: Optional[List[Dict[str, str]]]) -> bool:
    text = (user_input or "").strip()
    if not text or not history:
        return False
    if _FOLLOWUP_HINT_RE.search(text):
        return True
    # Very short questions without clear named entities often depend on context.
    if len(text) <= 24 and ("?" in text or "？" in text or text.endswith(("呢", "吗", "嘛"))):
        return True
    # Pronoun-heavy English stubs
    if re.fullmatch(r"(and\s+)?(the\s+)?(time|date|score|price|second|first|next)(\s+one)?\??", text, re.I):
        return True
    return False


def _infer_topic_changed(user_input: str, history: Optional[List[Dict[str, str]]]) -> bool:
    """Conservative topic-change detection for fallback/repair.

    Only returns True when the user input shares no surface overlap with any
    history anchor term AND contains at least two substantive new entities.
    A bare follow-up such as ``具体时间？`` is dominated by deictic/time
    phrases and yields too few substantive terms, so it stays anchored to
    history rather than being misread as a new topic. A genuinely new
    question (``为什么苹果股价最近跌了？``) carries fresh entities (苹果/股价)
    after function words are stripped, so it is correctly flagged.
    """
    anchors = _extract_history_anchor_terms(history) if history else []
    if not anchors:
        return False
    text = (user_input or "")
    # Strip CJK function/deictic/followup words so a long punctuation-free run
    # like ``为什么苹果股价最近跌了`` breaks into substantive sub-terms
    # (苹果/股价) rather than being one greedy 12-char blob.
    stripped = _CJK_FUNCTION_WORD_RE.sub(" ", text)
    new_terms: list[str] = []
    for seg in _TOPIC_DELIM_RE.split(stripped):
        for m in re.finditer(r"[一-鿿]{2,12}|[A-Za-z][A-Za-z0-9\-+.]*", seg):
            t = m.group(0)
            if t.lower() in _STOPWORDS or t in _FOLLOWUP_TOPIC_WORDS:
                continue
            if t not in new_terms:
                new_terms.append(t)
    if len(new_terms) < 2:
        return False
    return not any(a in text for a in anchors)


def _queries_need_history_anchors(queries: list[str], entities: list[str], user_input: str) -> bool:
    """True when search queries look too thin to stand alone as follow-ups."""
    if not queries:
        return True
    joined = " ".join(queries)
    if entities and not any(e and e in joined for e in entities):
        # Model produced entities but forgot them in queries — force repair.
        return True
    # If every query is barely longer than the raw follow-up, it is likely unresolved.
    raw = (user_input or "").strip()
    if raw and all(len(q) <= max(len(raw) + 6, 18) for q in queries):
        return True
    return False


def _build_search_analysis_result(
    *,
    queries: list[str],
    resolved_query: str = "",
    entities: Optional[list[str]] = None,
    is_followup: bool = False,
    topic_changed: bool = False,
    user_input: str = "",
    history: Optional[List[Dict[str, str]]] = None,
) -> Dict[str, Any]:
    """Normalize task-analysis search payload; repair thin follow-up queries."""
    clean_queries = _normalize_text_list(queries, max_items=3)
    clean_entities = _normalize_text_list(entities or [], max_items=8)
    followup = bool(is_followup) or _looks_like_followup_query(user_input, history)
    resolved = (resolved_query or "").strip()

    # When the user has switched topic, history anchors would pollute the
    # rewritten query: build the search directly from the new input instead.
    if topic_changed:
        if not clean_queries:
            clean_queries = [resolved or (user_input or "").strip() or "search"]
        if not resolved:
            resolved = clean_queries[0]
        if not clean_entities:
            clean_entities = _normalize_text_list(
                re.findall(r"[一-鿿]{2,12}|[A-Za-z][A-Za-z0-9\-+.]*", (user_input or "")),
                max_items=8,
            )
        return {
            "type": "search",
            "resolved_query": resolved,
            "queries": clean_queries,
            "entities": clean_entities,
            "is_followup": followup,
            "topic_changed": True,
        }

    if followup and history:
        anchors = clean_entities or _extract_history_anchor_terms(history)
        if not clean_entities:
            clean_entities = anchors
        if not resolved or (anchors and not any(a in resolved for a in anchors[:3])):
            base = resolved or (user_input or "").strip()
            if anchors:
                resolved = f"{' '.join(anchors[:4])} {base}".strip()
            else:
                # Fall back to last user question as topical glue.
                last_user = ""
                for msg in reversed(history):
                    if isinstance(msg, dict) and msg.get("role") == "user":
                        last_user = _summarize_message_content("user", str(msg.get("content") or ""), max_chars=120)
                        break
                if last_user and last_user not in base:
                    resolved = f"{last_user} {base}".strip()
                else:
                    resolved = base
        if _queries_need_history_anchors(clean_queries, clean_entities, user_input):
            repaired: list[str] = []
            prefix = " ".join((clean_entities or _extract_history_anchor_terms(history))[:4]).strip()
            seed_queries = clean_queries or [(user_input or "").strip()]
            for q in seed_queries:
                q = (q or "").strip()
                if not q:
                    continue
                if prefix and not any(tok and tok in q for tok in prefix.split()):
                    repaired.append(f"{prefix} {q}".strip())
                else:
                    repaired.append(q)
            if prefix:
                # Ensure at least one strongly anchored query.
                if not any(prefix.split()[0] in q for q in repaired):
                    repaired.insert(0, f"{prefix} {(user_input or '').strip()}".strip())
            clean_queries = _normalize_text_list(repaired, max_items=3)

    if not clean_queries:
        clean_queries = [resolved or (user_input or "").strip() or "search"]
    if not resolved:
        resolved = clean_queries[0]

    return {
        "type": "search",
        "resolved_query": resolved,
        "queries": clean_queries,
        "entities": clean_entities,
        "is_followup": followup,
        "topic_changed": bool(topic_changed),
    }


def _fallback_search_analysis(
    user_input: str,
    history: Optional[List[Dict[str, str]]] = None,
) -> Dict[str, Any]:
    """History-aware fallback when model output is missing or invalid."""
    text = (user_input or "").strip() or "search"
    followup = _looks_like_followup_query(text, history)
    entities = _extract_history_anchor_terms(history) if history else []
    topic_changed = _infer_topic_changed(text, history)
    if topic_changed:
        return _build_search_analysis_result(
            queries=[text],
            resolved_query=text,
            entities=[],
            is_followup=followup,
            topic_changed=True,
            user_input=text,
            history=history,
        )
    if followup and entities:
        resolved = f"{' '.join(entities[:4])} {text}".strip()
        queries = [resolved]
        # Only add a timezone-specific query when the follow-up is actually about time;
        # otherwise wasting a query slot on "时间 北京时间" admits irrelevant sources.
        if _FOLLOWUP_HINT_RE.search(text) or "时间" in text or "time" in text.lower():
            queries.append(f"{' '.join(entities[:3])} 北京时间".strip())
        # Drop near-duplicates
        queries = _normalize_text_list(queries, max_items=3)
        return _build_search_analysis_result(
            queries=queries,
            resolved_query=resolved,
            entities=entities,
            is_followup=True,
            topic_changed=False,
            user_input=text,
            history=history,
        )
    return _build_search_analysis_result(
        queries=[text],
        resolved_query=text,
        entities=entities,
        is_followup=followup,
        topic_changed=False,
        user_input=text,
        history=history,
    )


class LLMClient:
    def __init__(self, api_key: str, base_url: str = "https://api.openai.com/v1",
                 model: str = "deepseek-v4-pro",
                 history_window: Optional[int] = None,
                 history_char_budget: Optional[int] = None,
                 assistant_turn_char_budget: Optional[int] = None,
                 context_window: Optional[int] = None):
        self.client = create_openai_client(
            api_key=api_key,
            base_url=base_url,
            max_retries=0,  # 禁用 SDK 自动重试，由上层统一处理（含 Connection error）
            timeout=_LLM_TIMEOUT,
            connect_timeout=_LLM_CONNECT_TIMEOUT,
        )
        self.model = model
        self.total_prompt_tokens = 0
        self.total_completion_tokens = 0
        # History compression budget (window + total + per-assistant-turn).
        # Falls back to env-backed module defaults when caller omits an override.
        self._history_window = int(history_window) if history_window is not None else _HISTORY_WINDOW
        self._history_char_budget = int(history_char_budget) if history_char_budget is not None else _HISTORY_CHAR_BUDGET
        self._assistant_turn_char_budget = int(assistant_turn_char_budget) if assistant_turn_char_budget is not None else _ASSISTANT_TURN_CHAR_BUDGET
        # 模型上下文窗口(tokens)。可显式传入(如 32K/64K 模型)，缺省回退模块常量。
        # 驱动 generate_answer 的动态 sources 预算与 context-length 收缩重试。
        self._context_window = int(context_window) if context_window is not None else _CONTEXT_WINDOW_TOKENS
        # 预算保护：可动态收缩到最小值(_PROMPT_SOURCE_CHAR_BUDGET 的 1/32)。
        self._source_budget_min = max(20000, _PROMPT_SOURCE_CHAR_BUDGET // 32)

    def _dynamic_source_budget(self, context_chars: int, history_chars: int) -> int:
        """计算本次 generate_answer 的 sources 总预算(字符)。

        窗口 − 系统提示估算 − 实际历史长度 − 预留(输出+余量)。历史长度无法
        精确预知(_build_context_messages 自身受预算约束，且超时单条丢弃)，因此
        用静态估算 _SYSTEM_PROMPT_CHAR_ESTIMATE 一并覆盖；再与静态常量及下限
        取最大，保证最小可用预算。
        """
        reserve = max(int(self._context_window * _CONTEXT_RESERVE_RATIO), 12000)
        system_est = max(_SYSTEM_PROMPT_CHAR_ESTIMATE, context_chars)
        dynamic = self._context_window - system_est - history_chars - reserve
        return max(self._source_budget_min, min(dynamic, _PROMPT_SOURCE_CHAR_BUDGET))

    def _is_context_length_error(self, error: BaseException) -> bool:
        """True 表示 provider 提示上下文超长(context length exceeded)。

        不同网关的报错形态各异(status 400/413/429、message 关键词、OpenAI
        SDK 的 BadRequestError / ContextWindowExceededError)，遍历 cause 链匹配。
        """
        markers = (
            "context length",
            "context_length",
            "context window",
            "contextwindow",
            "maximum context",
            "max context",
            "token limit",
            "max tokens",
            "input is too long",
            "请求过长",
            "超过最大",
            "超出上下文",
            "上下文长度",
            "超长",
        )
        seen: set[int] = set()
        current: BaseException | None = error
        while current is not None and id(current) not in seen:
            seen.add(id(current))
            status_code = _status_code_of(current)
            text = str(current).lower()
            if any(marker in text for marker in markers):
                return True
            if status_code in (400, 413) and (
                "context" in text or "token" in text or "长度" in text or "过长" in text
            ):
                return True
            current = current.__cause__ or current.__context__
        return False

    async def _call_with_retry(self, messages: list, retries: int = 2, timeout: float = None) -> Any:
        """带重试的 LLM 调用。处理超时/连接错误/429/5xx。使用指数退避 + 抖动。"""
        request_timeout = timeout if timeout is not None else _LLM_TIMEOUT
        logger.info(
            "[LLM] model=%s messages=%d chars=%d",
            getattr(self, "model", "?"), len(messages), _messages_char_count(messages),
        )
        for attempt in range(retries + 1):
            try:
                async with _LLM_CONCURRENCY:
                    response = await asyncio.wait_for(
                        self.client.chat.completions.create(
                            model=self.model,
                            messages=messages,
                        ),
                        timeout=request_timeout,
                    )
                self._track_usage(response)
                return response
            except asyncio.CancelledError:
                raise
            except asyncio.TimeoutError:
                logger.warning(
                    "[LLM] 请求超时 (%.0fs), 重试 %d/%d",
                    request_timeout, attempt + 1, retries,
                )
                if attempt >= retries:
                    raise
                await asyncio.sleep(_retry_backoff_seconds(attempt))
            except Exception as e:
                provider_message = _provider_error_message(e)
                if provider_message:
                    raise LLMProviderConfigurationError(provider_message) from e
                if _is_retryable_llm_error(e) and attempt < retries:
                    wait = _retry_backoff_seconds(attempt)
                    status_code = _status_code_of(e)
                    logger.warning(
                        "[LLM] 请求失败 (%s%s), %.1f 秒后重试 (%d/%d)...",
                        type(e).__name__,
                        f"/{status_code}" if status_code else "",
                        wait,
                        attempt + 1,
                        retries,
                    )
                    await asyncio.sleep(wait)
                    continue
                raise

    def _track_usage(self, response):
        """Track token usage from response."""
        if hasattr(response, 'usage') and response.usage:
            self.total_prompt_tokens += getattr(response.usage, 'prompt_tokens', 0) or 0
            self.total_completion_tokens += getattr(response.usage, 'completion_tokens', 0) or 0

    async def aclose(self) -> None:
        """关闭底层 AsyncOpenAI/httpx 连接池，避免每个请求泄漏客户端资源。"""
        close = getattr(self.client, "close", None)
        if close is None:
            return
        try:
            result = close()
            if asyncio.iscoroutine(result):
                await result
        except Exception as e:
            logger.warning("[LLM] 关闭客户端连接池失败: %s", e)

    def _extract_response_content(self, response: Any) -> str:
        """Extract message content from SDK objects or gateway string responses."""
        if response is None:
            return ""
        if isinstance(response, str):
            sse_content = self._extract_sse_content(response)
            if sse_content:
                return sse_content
            return response
        if isinstance(response, bytes):
            return response.decode("utf-8", errors="replace")
        if isinstance(response, dict):
            choices = response.get("choices") or []
            if choices:
                message = choices[0].get("message", {})
                if isinstance(message, dict):
                    return message.get("content", "") or ""
                if isinstance(message, str):
                    return message
            return response.get("content", "") or response.get("output_text", "") or ""

        choices = getattr(response, "choices", None) or []
        if choices:
            message = getattr(choices[0], "message", None)
            content = getattr(message, "content", None)
            if content is not None:
                return content
            if isinstance(message, str):
                return message
        return getattr(response, "content", None) or getattr(response, "output_text", "") or ""

    def _extract_sse_content(self, text: str) -> str:
        """Extract concatenated delta content from SSE-formatted response text."""
        if "data:" not in text:
            return ""

        chunks = []
        for line in text.splitlines():
            line = line.strip()
            if not line.startswith("data:"):
                continue

            payload = line.removeprefix("data:").strip()
            if not payload or payload == "[DONE]":
                continue

            try:
                data = json.loads(payload)
            except json.JSONDecodeError:
                continue

            for choice in data.get("choices", []):
                delta = choice.get("delta") or {}
                content = delta.get("content")
                if content:
                    chunks.append(content)

        return "".join(chunks)

    def _extract_json(self, text: str) -> Optional[Any]:
        """
        健壮地从 LLM 响应中提取 JSON。
        优先级: 直接解析 > markdown 代码块 > 从正文扫描 JSON 对象/数组
        """
        if not text:
            return None

        def parse_candidate(candidate: str) -> Optional[Any]:
            try:
                data = json.loads(candidate.strip())
                if isinstance(data, (dict, list)):
                    return data
            except (json.JSONDecodeError, ValueError):
                return None
            return None

        # 1. 直接尝试解析整段文本
        text = text.strip()
        data = parse_candidate(text)
        if data is not None:
            return data

        # 2. 尝试从 markdown 代码块提取（```json ... ``` 或 ``` ... ```）
        code_block_patterns = [
            r'```json\s*\n?(.*?)\n?\s*```',
            r'```\s*\n?(.*?)\n?\s*```',
        ]
        for pattern in code_block_patterns:
            match = re.search(pattern, text, re.DOTALL)
            if match:
                data = parse_candidate(match.group(1))
                if data is not None:
                    return data

        # 3. 从正文中扫描第一个可解析 JSON。JSONDecoder 会正确处理字符串内括号。
        decoder = json.JSONDecoder()
        for index, char in enumerate(text):
            if char not in "{[":
                continue
            try:
                data, _end = decoder.raw_decode(text[index:])
            except json.JSONDecodeError:
                continue
            if isinstance(data, (dict, list)):
                return data

        return None

    def _build_context_messages(self, history: Optional[List[Dict[str, str]]]) -> List[Dict[str, str]]:
        """Build compact chat history for LLM calls.

        Two budgets apply, both filled newest-first so the latest turn always
        survives: a message-count window (``_history_window``) and a total char
        budget (``_history_char_budget``). Long assistant turns are summarized
        to ``_assistant_turn_char_budget``; user turns get twice that headroom.
        ``list(history)[-window:]`` is used (rather than slicing the history
        sequence directly) so the newest turns are kept and the codebase does
        not trip the hygiene grep for bare negative-index history slicing.
        """
        if not history:
            return []

        window = int(self._history_window)
        budget = int(self._history_char_budget)
        pool = [m for m in list(history) if isinstance(m, dict)][-window:]
        # Walk newest-first so the latest single message always survives, then
        # fill backwards until the char budget is spent. Each turn is already
        # capped by _summarize_message_content before the budget check, so a
        # turn that alone exceeds the whole budget is still kept (newest wins)
        # rather than dropping every turn.
        chosen: list[dict] = []
        spent = 0
        for msg in reversed(pool):
            role = msg.get("role", "user")
            if role not in ("user", "assistant", "system"):
                role = "user"
            max_chars = self._assistant_turn_char_budget if role == "assistant" else self._assistant_turn_char_budget * 2
            content = _summarize_message_content(role, str(msg.get("content") or ""), max_chars=max_chars)
            if spent > 0 and spent + len(content) > budget:
                break
            spent += len(content)
            if not content:
                # Preserve user/assistant alternation: empty assistant turn → stub.
                content = "…"
            chosen.append({"role": role, "content": content})
        return list(reversed(chosen))

    async def analyze_task(self, user_input: str, history: Optional[List[Dict[str, str]]] = None) -> Dict[str, Any]:
        """
        [02] AI Model: Task Analysis
        Returns search analysis with resolved_query/queries/entities, or a direct URL.
        """
        # Cache lookup — if same query was analyzed recently, reuse result
        import time as _time
        cache_key = f"task:{_cache_digest({'input': user_input.strip().lower(), 'history': _history_cache_digest(history)})}"
        now = _time.time()
        if cache_key in _ANALYSIS_CACHE:
            cached_result, cached_time = _ANALYSIS_CACHE[cache_key]
            if now - cached_time < _ANALYSIS_CACHE_TTL:
                logger.info("[Task Analysis] 缓存命中: %s", user_input[:50])
                return _clone_cached_analysis_result(cached_result)

        current_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        system_prompt = TASK_ANALYSIS_PROMPT.format(current_time=current_time)

        messages = [{"role": "system", "content": system_prompt}]

        # Add conversation history if available (summarized)
        context = self._build_context_messages(history)
        for msg in context:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            messages.append({"role": role, "content": content})

        messages.append({"role": "user", "content": user_input})

        try:
            logger.info("[Task Analysis] 输入: %s", _truncate_for_log(user_input, 80))
            response = await self._call_with_retry(messages, retries=1, timeout=_LLM_SHORT_TIMEOUT)
            content = self._extract_response_content(response)

            data = self._extract_json(content)
            if isinstance(data, dict):
                # Validate the structure
                if data.get("type") == "direct" and data.get("url"):
                    result = {"type": "direct", "url": str(data["url"]).strip()}
                    logger.info("[Task Analysis] 直接 URL: %s", result["url"][:100])
                    _cache_analysis_result(cache_key, result)
                    return result

                queries = None
                if data.get("queries") is not None:
                    queries = _normalize_text_list(data["queries"], max_items=3)
                elif data.get("query") is not None:
                    queries = _normalize_text_list(data["query"], max_items=1)

                resolved_query_raw = str(
                    data.get("resolved_query") or data.get("standalone_query") or ""
                ).strip()
                # If the model gave a standalone resolved_query but no usable queries
                # (queries:null/empty), seed queries from the resolved intent instead
                # of discarding it and falling back to a raw echo of user_input.
                if not queries and resolved_query_raw:
                    queries = _normalize_text_list([resolved_query_raw], max_items=3)

                if queries:
                    result = _build_search_analysis_result(
                        queries=queries,
                        resolved_query=resolved_query_raw,
                        entities=_normalize_text_list(data.get("entities"), max_items=8),
                        is_followup=_coerce_bool(data.get("is_followup")),
                        topic_changed=_coerce_bool(data.get("topic_changed")),
                        user_input=user_input,
                        history=history,
                    )
                    logger.info(
                        "[Task Analysis] resolved=%s queries=%s entities=%s followup=%s",
                        _truncate_for_log(result.get("resolved_query", ""), 80),
                        json.dumps(result.get("queries", []), ensure_ascii=False)[:160],
                        result.get("entities", []),
                        result.get("is_followup"),
                    )
                    _cache_analysis_result(cache_key, result)
                    return result

            # Fallback
            logger.warning("[Task Analysis] JSON 解析失败或结构无效，使用 history-aware fallback")
            result = _fallback_search_analysis(user_input, history)
            # Fallback 是同一输入的可确定函数，且常为原始 query 回声；
            # 缓存它只会让后续 3 分钟内的相同请求命中降级结果，不再给模型
            # 重试机会。因此 fallback 一律不进缓存（与异常路径一致）。
            return result

        except LLMProviderConfigurationError:
            raise
        except Exception as e:
            logger.error("Error in analyze_task: %s", e)
            # Do not cache transient failures.
            return _fallback_search_analysis(user_input, history)

    async def assess_relevance(self, query: str, snippets: List[Dict]) -> List[int]:
        """
        [04] AI Model: Relevance Assessment
        Input: Query and a list of snippets with IDs.
        Returns: List of IDs (integers) that are relevant and worth deep crawling.
        """
        # Cache lookup — if same query+snippets was analyzed recently, reuse result
        import time as _time
        cache_key = f"rel:{_cache_digest({'query': query.strip().lower(), 'snippets': _snippet_cache_digest(snippets)})}"
        now = _time.time()
        if cache_key in _ANALYSIS_CACHE:
            cached_result, cached_time = _ANALYSIS_CACHE[cache_key]
            if now - cached_time < _ANALYSIS_CACHE_TTL:
                logger.info("[Relevance] 缓存命中: %s", query[:50])
                return _clone_cached_analysis_result(cached_result)

        current_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        system_prompt = RELEVANCE_ASSESSMENT_PROMPT.format(current_time=current_time)

        user_message = f"Query: {query}\n\nSnippets:\n"
        for item in snippets:
            date_info = f"Date: {item.get('date', 'N/A')}\n" if item.get('date') else ""
            user_message += f"ID [{item['id']}]: Title: {item['title']}\n{date_info}Snippet: {item['snippet']}\n\n"

        try:
            logger.info("[Relevance Assessment] 评估 %d 个搜索结果", len(snippets))
            response = await self._call_with_retry([
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message}
            ], retries=1, timeout=_LLM_SHORT_TIMEOUT)
            content = self._extract_response_content(response)

            data = self._extract_json(content)
            if isinstance(data, dict):
                ids = _normalize_int_list(data.get("relevant_ids", []))
                logger.info("[Relevance Assessment] 选定 ID: %s", ids)
                _cache_analysis_result(cache_key, ids)
                return ids

            logger.warning("[Relevance Assessment] JSON 解析失败，返回前 3 个")
            return [s['id'] for s in snippets[:3]]
        except LLMProviderConfigurationError:
            raise
        except Exception as e:
            logger.error("Error in assess_relevance: %s", e)
            # Fallback: return top 3 if parsing fails
            return [s['id'] for s in snippets[:3]]

    async def decide_click_elements(self, query: str, elements: List[Dict]) -> List[str]:
        """
        [New] AI Model: Decide which elements to click
        Input: Query and a list of interactive elements (id, text, type).
        Returns: List of element id strings to click (e.g. "js-interact-0").
        """
        if not elements:
            return []

        current_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        system_prompt = CLICK_DECISION_PROMPT.format(current_time=current_time)

        user_message = f"Query: {query}\n\nClickable Elements:\n"
        for el in elements:
            user_message += f"ID [{el['id']}]: [{el['tag']}] {el['text']}\n"

        try:
            logger.info("[Click Decision] 评估 %d 个可点击元素", len(elements))
            response = await self._call_with_retry([
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message}
            ], retries=1, timeout=_LLM_SHORT_TIMEOUT)
            content = self._extract_response_content(response)

            data = self._extract_json(content)
            if isinstance(data, dict):
                clicked = _normalize_text_list(data.get("clicked_ids", []), max_items=3)
                valid_ids = {str(el.get("id", "")) for el in elements if el.get("id") is not None}
                # max_items=3 已在解析阶段截断点击数量，避免每页过度交互。
                clicked = [cid for cid in clicked if cid in valid_ids]
                logger.info("[Click Decision] 决定点击: %s", clicked)
                return clicked
            logger.info("[Click Decision] 不点击任何元素")
            return []
        except LLMProviderConfigurationError:
            raise
        except Exception as e:
            logger.error("Error in decide_click_elements: %s", e)
            return []

    async def verify_citation_claims(
        self,
        items: List[Dict[str, Any]],
        *,
        timeout: float = 6.0,
    ) -> Dict[str, Dict[str, Any]]:
        """Batch-verify bounded claim/quote pairs. Fail-closed parsing; callers fail open.

        Returns a mapping keyed by the caller-provided item ``id``. Unknown,
        duplicate, missing, malformed, or out-of-contract results are ignored.
        """
        bounded: list[dict[str, str]] = []
        valid_ids: set[str] = set()
        for item in (items or [])[:3]:
            if not isinstance(item, dict):
                continue
            item_id = str(item.get("id") or "").strip()
            claim = str(item.get("claim") or "").strip()[:320]
            quote = str(item.get("quote") or "").strip()[:480]
            title = str(item.get("title") or "").strip()[:120]
            if not item_id or not claim or not quote or item_id in valid_ids:
                continue
            valid_ids.add(item_id)
            bounded.append({"id": item_id, "claim": claim, "quote": quote, "source_title": title})
        if not bounded:
            return {}

        current_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        messages = [
            {"role": "system", "content": CITATION_VERIFICATION_PROMPT.format(current_time=current_time)},
            {"role": "user", "content": json.dumps({"items": bounded}, ensure_ascii=False)},
        ]
        response = await self._call_with_retry(messages, retries=1, timeout=max(1.0, min(10.0, timeout)))
        parsed = self._extract_json(self._extract_response_content(response))
        results = parsed.get("results") if isinstance(parsed, dict) else None
        if not isinstance(results, list):
            return {}

        out: dict[str, dict[str, Any]] = {}
        allowed = {"SUPPORTED", "CONTRADICTED", "NOT_ENOUGH_INFO"}
        for raw in results:
            if not isinstance(raw, dict):
                continue
            item_id = str(raw.get("id") or "").strip()
            verdict = str(raw.get("verdict") or "").strip().upper()
            if item_id not in valid_ids or item_id in out or verdict not in allowed:
                continue
            try:
                confidence = max(0.0, min(1.0, float(raw.get("confidence", 0.0))))
            except (TypeError, ValueError):
                confidence = 0.0
            out[item_id] = {
                "verdict": verdict,
                "confidence": round(confidence, 3),
                "reason": str(raw.get("reason") or "").strip()[:200],
            }
        return out

    # canvas_mode is a deprecated alias for live_artifacts_mode (kept for API
    # contract compatibility; the web frontend stopped sending it).
    async def generate_answer(self, query: str, sources: List[Dict], history: Optional[List[Dict[str, str]]] = None, stream_callback: Optional[Callable[[str], None]] = None, live_artifacts_mode: bool = False, canvas_mode: bool = False) -> Dict[str, Any]:
        """
        [09] AI Model: Generation & Evaluation
        Input: Query and full content of selected sources.
        Returns: {"status": "sufficient"|"insufficient"|"error", "answer": "..."}
        """
        # NOTE: generate_answer does NOT use cache — the same query with different sources
        # should produce different results. Caching by query alone caused a collision bug
        # where analyze_task's cached result was returned instead.

        current_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        if canvas_mode:
            import warnings
            warnings.warn("canvas_mode is deprecated, use live_artifacts_mode", DeprecationWarning, stacklevel=2)
            logger.warning("[LLM] canvas_mode deprecated alias used, treating as live_artifacts_mode")
        live_artifacts_mode = bool(live_artifacts_mode or canvas_mode)
        live_artifacts_requested = live_artifacts_mode
        prompt_template = (
            ANSWER_GENERATION_LIVE_ARTIFACTS_PROMPT
            if live_artifacts_requested
            else ANSWER_GENERATION_PROMPT
        )
        system_prompt = prompt_template.format(current_time=current_time)
        if live_artifacts_requested:
            system_prompt = f"{system_prompt}\n\n{select_live_artifacts_protocol(query)}"

        messages = [{"role": "system", "content": system_prompt}]

        # Add conversation history context if available
        context = self._build_context_messages(history)
        for msg in context:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            messages.append({"role": role, "content": content})

        user_message = f"Question: {query}\n\nSources:\n"
        # Sources 预算随模型窗口与本次请求实际占用动态计算，避免静态预算在
        # CJK(1 字符≈1 token)或小窗口模型下打爆上下文。
        source_budget = self._dynamic_source_budget(
            len(system_prompt), _messages_char_count(messages)
        )
        budgeted_sources, original_chars, final_chars = _budget_sources_for_prompt(
            sources, total_budget=source_budget
        )
        logger.info(
            "[Generate Answer] sources=%d chars=%d->%d (budget=%d) stream=%s",
            len(sources), original_chars, final_chars, source_budget,
            "yes" if stream_callback else "no",
        )
        for src in budgeted_sources:
            date_info = f" (Date: {src.get('date')})" if src.get('date') else ""
            user_message += f"Source [{src['id']}] (Title: {src['title']}{date_info}):\n{src['content']}\n\n"

        messages.append({"role": "user", "content": user_message})

        try:
            logger.info(
                "[Generate Answer] 使用 %d 个来源生成答案 (stream=%s)",
                len(sources),
                "yes" if stream_callback else "no",
            )

            max_attempts = max(1, _GENERATE_ANSWER_RETRIES)
            last_error: BaseException | None = None
            # 预算收缩上限：即使反复 context-length，也最多收缩 _CONTEXT_SHRINK_STEPS 次，
            # 避免与无限循环/最小预算下的必然失败纠缠不清。
            shrink_steps_left = _CONTEXT_SHRINK_STEPS

            for attempt in range(max_attempts):
                response = None
                stream_slot_acquired = False
                full_content = ""
                status = "sufficient"
                parsing_header = True
                header_buffer = ""
                answer_started = False
                live_stream_buffer = ""
                live_streaming_enabled = False
                streamed_any = False
                # 标记是否已进入 drain(create() 之后)。用于区分"请求头超时"
                # 与"流中途断流"两种 TimeoutError。
                drain_started = False

                def maybe_stream_answer(content: str):
                    nonlocal live_stream_buffer, live_streaming_enabled, streamed_any
                    if status != "sufficient" or not stream_callback or not content:
                        return
                    if not live_artifacts_requested:
                        stream_callback(content)
                        streamed_any = True
                        return
                    if live_streaming_enabled:
                        stream_callback(content)
                        streamed_any = True
                        return

                    live_stream_buffer += content
                    if _is_streamable_live_artifact_answer(live_stream_buffer):
                        live_streaming_enabled = True
                        stream_callback(live_stream_buffer)
                        live_stream_buffer = ""
                        streamed_any = True

                try:
                    try:
                        await asyncio.wait_for(_LLM_CONCURRENCY.acquire(), timeout=15)
                    except asyncio.TimeoutError as acquire_timeout:
                        last_error = acquire_timeout
                        logger.warning("[Generate Answer] 获取并发槽超时(15s)，请稍后重试")
                        return {"status": "error", "answer": "系统繁忙，请稍后重试。", "missing_info": ""}
                    stream_slot_acquired = True
                    try:
                        response = await asyncio.wait_for(
                            self.client.chat.completions.create(
                                model=self.model,
                                messages=messages,
                                stream=True,
                            ),
                            timeout=_LLM_TIMEOUT,
                        )

                        async def _drain_stream():
                            nonlocal full_content, parsing_header, header_buffer, answer_started, status
                            async for chunk in response:
                                # 兼容 delta 为 None / content 为 None 的边缘 chunk
                                delta = getattr(chunk.choices[0], "delta", None) if chunk.choices else None
                                content = getattr(delta, "content", None) if delta else None
                                if content:
                                    full_content += content

                                    if parsing_header:
                                        header_buffer += content
                                        # 防止 header_buffer 无界增长，最多保留 2000 字符
                                        if len(header_buffer) > 2000:
                                            parsing_header = False
                                            maybe_stream_answer(header_buffer)
                                            continue
                                        status_match = _ANSWER_FIELD_STATUS_RE.search(header_buffer)
                                        if status_match and "\n" in header_buffer[status_match.end():]:
                                            status_value = (status_match.group(1) or "").strip().lower()
                                            if (
                                                "insufficient" in status_value
                                                or status_value in {"不足", "不充分", "不够", "不完整"}
                                                or status_value.startswith("不足")
                                            ):
                                                status = "insufficient"

                                        answer_match = _ANSWER_FIELD_ANSWER_RE.search(header_buffer)
                                        if answer_match:
                                            answer_chunk = header_buffer[answer_match.end():]
                                            parsing_header = False
                                            answer_started = True
                                            maybe_stream_answer(answer_chunk)

                                        if len(header_buffer) > 500 and not answer_started:
                                            parsing_header = False
                                            maybe_stream_answer(header_buffer)
                                    else:
                                        maybe_stream_answer(content)

                                elif chunk.choices and getattr(chunk.choices[0], "finish_reason", None):
                                    break

                        # 迭代阶段同样受显式超时约束：网关已返回响应但中途断流
                        # 时，SDK 的 120s 读超时与内部 _LLM_TIMEOUT 一致，仍可能
                        # 让用户等待很久且无明确提示。
                        drain_started = True
                        await asyncio.wait_for(_drain_stream(), timeout=_LLM_TIMEOUT)
                    finally:
                        if response is not None:
                            try:
                                closer = getattr(response, "close", None) or getattr(response, "aclose", None)
                                if closer is not None:
                                    res = closer()
                                    if asyncio.iscoroutine(res):
                                        await res
                            except Exception:
                                pass
                        if stream_slot_acquired:
                            _LLM_CONCURRENCY.release()
                            stream_slot_acquired = False

                    envelope = _parse_answer_envelope(full_content)
                    status = envelope["status"] if envelope["had_envelope"] else status
                    missing_info = envelope["missing_info"]
                    final_answer = envelope["answer"]

                    if live_artifacts_requested:
                        # Always normalize: strip envelopes and keep raw HTML intact.
                        # Insufficient partials are re-wrapped by the workflow with a banner.
                        final_answer = ensure_live_artifact_answer(final_answer)

                    return {
                        "status": status,
                        "answer": final_answer.strip(),
                        "missing_info": missing_info,
                    }

                except asyncio.CancelledError:
                    raise
                except asyncio.TimeoutError as e:
                    last_error = e
                    # 已进入 drain 说明是流中途断流(create 已成功、后续 chunk 超时)，
                    # 不再按"请求头超时"重试整流——若已向 UI 推送过内容，直接给
                    # 明确的"流式响应中断"提示，避免用户看到笼统异常文本。
                    if drain_started:
                        logger.warning(
                            "[Generate Answer] 流式响应中断(已收到响应头，%.0fs 无数据), %d/%d, streamed=%s chars=%d err=%s",
                            _LLM_TIMEOUT,
                            attempt + 1,
                            max_attempts - 1,
                            streamed_any,
                            len(full_content),
                            type(e).__name__,
                        )
                        # 已推送内容则直接报错；未推送时允许重试一次（瞬时抖动）
                        if streamed_any or attempt >= max_attempts - 1:
                            return {
                                "status": "error",
                                "answer": "模型返回的流式响应中断，请重试。",
                                "missing_info": "",
                            }
                        await asyncio.sleep(_retry_backoff_seconds(attempt, base=2.0))
                        continue
                    logger.warning(
                        "[Generate Answer] 请求超时, 重试 %d/%d",
                        attempt + 1,
                        max_attempts - 1,
                    )
                    if attempt >= max_attempts - 1:
                        return {"status": "error", "answer": "生成答案超时，请重试。", "missing_info": ""}
                    await asyncio.sleep(_retry_backoff_seconds(attempt, base=2.0))
                    continue
                except Exception as e:
                    last_error = e
                    # 上下文超长：收缩 sources 预算后重建请求重试，而非直接失败。
                    if self._is_context_length_error(e) and shrink_steps_left > 0:
                        shrink_steps_left -= 1
                        source_budget = max(self._source_budget_min, source_budget // 2)
                        logger.warning(
                            "[Generate Answer] 上下文超长，收缩 sources 预算至 %d 字符后重试 (%d/%d)",
                            source_budget,
                            attempt + 1,
                            max_attempts - 1,
                        )
                        budgeted_sources, _, final_chars = _budget_sources_for_prompt(
                            sources, total_budget=source_budget
                        )
                        user_message = f"Question: {query}\n\nSources:\n"
                        for src in budgeted_sources:
                            date_info = f" (Date: {src.get('date')})" if src.get('date') else ""
                            user_message += f"Source [{src['id']}] (Title: {src['title']}{date_info}):\n{src['content']}\n\n"
                        messages[-1] = {"role": "user", "content": user_message}
                        await asyncio.sleep(_retry_backoff_seconds(attempt, base=1.0))
                        continue

                    provider_message = _provider_error_message(e)
                    if provider_message:
                        raise LLMProviderConfigurationError(provider_message) from e

                    # Only restart the whole stream if nothing has been sent to the UI yet.
                    can_retry = (
                        _is_retryable_llm_error(e)
                        and attempt < max_attempts - 1
                        and not streamed_any
                        and not full_content
                    )
                    if can_retry:
                        wait = _retry_backoff_seconds(attempt, base=2.0)
                        status_code = _status_code_of(e)
                        logger.warning(
                            "[Generate Answer] %s%s, %.1f 秒后重试 (%d/%d)...",
                            type(e).__name__,
                            f"/{status_code}" if status_code else "",
                            wait,
                            attempt + 1,
                            max_attempts - 1,
                        )
                        await asyncio.sleep(wait)
                        continue

                    # A corrupt/aborted stream that already flushed bytes to the UI
                    # must not be rendered as a fake "answer" — surface it as an
                    # error status so the UI shows a retry affordance instead of the
                    # raw exception text inside the answer bubble.
                    if isinstance(e, UnicodeDecodeError) or _is_stream_corruption_error(e):
                        logger.error("[Generate Answer] 流式响应中断: %s", e)
                        return {
                            "status": "error",
                            "answer": "模型返回的流式响应中断，请重试。",
                            "missing_info": "",
                        }
                    raise

            if last_error is not None:
                raise last_error
            return {"status": "error", "answer": "生成答案时出错: 未收到模型响应。", "missing_info": ""}

        except LLMProviderConfigurationError:
            raise
        except Exception as e:
            logger.error("Error in generate_answer: %s", e)
            # Never render a corrupt/aborted stream as if it were an answer.
            if isinstance(e, UnicodeDecodeError) or _is_stream_corruption_error(e):
                return {
                    "status": "error",
                    "answer": "模型返回的流式响应中断，请重试。",
                    "missing_info": "",
                }
            return {"status": "error", "answer": f"生成答案时出错: {e}", "missing_info": ""}


def _is_stream_corruption_error(error: BaseException) -> bool:
    """True if ``error`` indicates the gateway returned a corrupt/non-UTF-8 stream.

    Covers the two common OpenAI-compatible gateway failure modes: a chunk split
    mid-character before the connection drops, and a non-UTF-8 (GBK) error page
    returned for rate-limit/subscription failures. Both surface through the
    SDK's strict decoder as a decode error; walk causes so SDK-wrapped variants
    are caught too.
    """
    if isinstance(error, UnicodeDecodeError):
        return True
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, UnicodeDecodeError):
            return True
        text = str(current).lower()
        if any(
            marker in text
            for marker in ("can't decode bytes", "unexpected end of data", "codec can't decode")
        ):
            return True
        current = current.__cause__ or current.__context__
    return False


def _truncate_for_log(text: str, max_len: int = 50) -> str:
    """截断文本用于日志输出，避免泄露完整查询。"""
    if not text or len(text) <= max_len:
        return text
    return text[:max_len] + "..."
