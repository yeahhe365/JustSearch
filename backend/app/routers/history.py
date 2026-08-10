"""
History router – /api/history endpoints
"""

import logging
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Body, Query
from sqlalchemy import text as sql_text

from ..database import (
    list_chats, load_chat_history, save_chat_history,
    delete_chat, delete_all_chats, get_session,
    list_chat_groups, create_chat_group, update_chat_group,
    delete_chat_group, move_chat_to_group, set_chat_pinned,
    duplicate_chat, fork_chat_from,
    _format_utc_timestamp,
    export_history_package, import_history_package, normalize_route_safe_id,
)

logger = logging.getLogger(__name__)

router = APIRouter()


def _build_safe_fts_query(query: str) -> str:
    """Build an FTS5 query from arbitrary user text without exposing query syntax."""
    terms = [
        term.strip()
        for term in str(query or "").split()
        if term.strip()
    ]
    if not terms:
        terms = [str(query or "").strip()]

    phrases = []
    for term in terms:
        escaped = term.replace('"', '""')
        if escaped:
            phrases.append(f'"{escaped}"')
    return " ".join(phrases)


def _escape_markdown_link_text(value: object) -> str:
    text = str(value or "").replace("\r", " ").replace("\n", " ").strip()
    return (
        text
        .replace("\\", "\\\\")
        .replace("[", "\\[")
        .replace("]", "\\]")
    )


def _safe_markdown_url(value: object) -> str:
    raw = str(value or "").strip()
    if any(ch in raw for ch in (" ", "\t", "\r", "\n", "<", ">")):
        return ""
    parsed = urlparse(raw)
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.netloc:
        return ""
    return raw.replace(")", "%29")


def _format_source_markdown_item(source: object) -> str:
    source = source if isinstance(source, dict) else {}
    raw_url = source.get("url", "")
    title = source.get("title") or raw_url or "来源"
    text = _escape_markdown_link_text(title) or "来源"
    safe_url = _safe_markdown_url(raw_url)
    if not safe_url:
        return f"- {text}"
    return f"- [{text}]({safe_url})"


def _chat_to_markdown(chat_data: dict, msg_heading: str) -> list[str]:
    """Render a chat's messages as Markdown lines (user/assistant/sources).

    Shared by export_chat (single) and export_all_chats (batch); ``msg_heading``
    is the heading level for each message (``"##"`` for single export, ``"###"``
    for batch where a per-chat ``## <title>`` header already precedes).
    """
    lines: list[str] = []
    for msg in chat_data.get("messages", []):
        role = msg.get("role", "user")
        content = msg.get("content", "")
        if role == "user":
            lines.append(f"{msg_heading} 👤 用户\n\n{content}\n")
        elif role == "assistant":
            lines.append(f"{msg_heading} 🤖 助手\n\n{content}\n")
            sources = msg.get("sources", [])
            if sources:
                lines.append("### 参考资料\n")
                for src in sources:
                    lines.append(_format_source_markdown_item(src))
                lines.append("")
    return lines


def _require_route_safe_id(value: object, field_name: str) -> str:
    normalized = normalize_route_safe_id(value)
    if not normalized:
        raise HTTPException(status_code=400, detail=f"{field_name} 格式无效")
    return normalized


def _body_text(body: object, key: str, default: str = "") -> str:
    if not isinstance(body, dict):
        return default
    value = body.get(key, default)
    if value is None:
        value = default
    return str(value).strip()


def _require_body_dict(body: object) -> dict:
    if isinstance(body, dict):
        return body
    raise HTTPException(status_code=400, detail="请求体必须是 JSON 对象")


@router.get("/api/history")
async def get_history_endpoint():
    return await list_chats()


@router.get("/api/history/search")
async def search_history_endpoint(q: str = Query(..., min_length=1, max_length=200)):
    """Full-text search across all chat messages using FTS5."""
    fts_query = _build_safe_fts_query(q)
    async with await get_session() as session:
        try:
            chats = []
            offset = 0
            batch_size = 100
            while len(chats) < 20:
                result = await session.execute(
                    sql_text(
                        "SELECT DISTINCT cs.id, cs.title, cs.group_id, cs.updated_at "
                        "FROM chat_messages_fts fts "
                        "JOIN chat_sessions cs ON cs.id = fts.session_id "
                        "WHERE chat_messages_fts MATCH :query "
                        "ORDER BY cs.updated_at DESC LIMIT :limit OFFSET :offset"
                    ),
                    {"query": fts_query, "limit": batch_size, "offset": offset},
                )
                rows = result.fetchall()
                if not rows:
                    break
                for row in rows:
                    session_id = normalize_route_safe_id(row[0])
                    if not session_id:
                        continue
                    chats.append({
                        "id": session_id,
                        "title": row[1],
                        "group_id": normalize_route_safe_id(row[2]) if row[2] else None,
                        "timestamp": _format_utc_timestamp(row[3]),
                    })
                    if len(chats) >= 20:
                        break
                offset += len(rows)
            return chats
        except Exception as e:
            logger.warning("FTS search failed, falling back to title search: %s", e)
            # Fallback: search by title only
            all_chats = await list_chats(limit=100000)
            q_lower = q.lower()
            return [
                c for c in all_chats
                if q_lower in (c.get("title", "").lower())
            ][:20]


@router.get("/api/history/groups")
async def get_chat_groups_endpoint():
    return await list_chat_groups()


@router.post("/api/history/groups")
async def create_chat_group_endpoint(body: object = Body(default=None)):
    title = _body_text(body, "title", "新分组") or "新分组"
    return await create_chat_group(title)


@router.patch("/api/history/groups/{group_id}")
async def update_chat_group_endpoint(group_id: str, body: object = Body(default=None)):
    group_id = _require_route_safe_id(group_id, "group_id")
    body = _require_body_dict(body)
    title = body.get("title")
    is_expanded = body.get("is_expanded")
    group = await update_chat_group(
        group_id,
        title=str(title) if title is not None else None,
        is_expanded=is_expanded if isinstance(is_expanded, bool) else None,
    )
    if group is None:
        raise HTTPException(status_code=404, detail="Group not found")
    return group


@router.delete("/api/history/groups/{group_id}")
async def delete_chat_group_endpoint(group_id: str):
    group_id = _require_route_safe_id(group_id, "group_id")
    if not await delete_chat_group(group_id):
        raise HTTPException(status_code=404, detail="Group not found")
    return {"status": "ok"}


@router.patch("/api/history/{session_id}/group")
async def move_chat_to_group_endpoint(session_id: str, body: object = Body(default=None)):
    session_id = _require_route_safe_id(session_id, "session_id")
    body = _require_body_dict(body)
    group_id = body.get("group_id")
    if group_id == "":
        group_id = None
    if group_id is not None:
        group_id = _require_route_safe_id(group_id, "group_id")
    moved = await move_chat_to_group(session_id, group_id)
    if not moved:
        raise HTTPException(status_code=404, detail="Chat or group not found")
    return {"status": "ok", "group_id": group_id}


@router.get("/api/history/export/all")
async def export_all_chats(format: str = "markdown"):
    """批量导出所有对话为一个文件。"""
    from fastapi.responses import Response
    import json
    import datetime as _dt

    date_str = _dt.datetime.now().strftime("%Y%m%d")
    requested_format = format.lower()

    if requested_format == "json":
        export_data = await export_history_package()
        content = json.dumps(export_data, ensure_ascii=False, indent=2)
        return Response(
            content=content,
            media_type="application/json; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="justsearch-export-{date_str}.json"'},
        )

    # Markdown export
    all_chats = await list_chats(limit=100000)
    if not all_chats:
        raise HTTPException(status_code=404, detail="没有可导出的对话")

    md_lines = [f"# JustSearch 对话导出\n", f"导出时间: {_dt.datetime.now().strftime('%Y-%m-%d %H:%M')}\n"]
    for chat_summary in all_chats:
        chat_data = await load_chat_history(chat_summary["id"])
        if not chat_data:
            continue
        title = chat_data.get("title", "对话")
        md_lines.append(f"\n---\n\n## {title}\n")
        md_lines.extend(_chat_to_markdown(chat_data, "###"))

    return Response(
        content="\n".join(md_lines),
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="justsearch-export-{date_str}.md"'},
    )


@router.post("/api/history/import")
async def import_history_endpoint(body: object = Body(...)):
    """导入聊天记录 JSON 包。重复的会话和分组会跳过，不覆盖现有数据。"""
    try:
        summary = await import_history_package(body)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"status": "ok", **summary}


@router.get("/api/history/{session_id}")
async def get_chat_endpoint(session_id: str):
    session_id = _require_route_safe_id(session_id, "session_id")
    history = await load_chat_history(session_id)
    if not history:
        raise HTTPException(status_code=404, detail="Chat not found")
    return history


@router.delete("/api/history/{session_id}")
async def delete_chat_endpoint(session_id: str):
    session_id = _require_route_safe_id(session_id, "session_id")
    if not await delete_chat(session_id):
        raise HTTPException(status_code=404, detail="Chat not found")
    return {"status": "ok"}


@router.patch("/api/history/{session_id}")
async def rename_chat_endpoint(session_id: str, body: object = Body(default=None)):
    session_id = _require_route_safe_id(session_id, "session_id")
    body = _require_body_dict(body)
    new_title = _body_text(body, "title")
    if not new_title:
        raise HTTPException(status_code=400, detail="Title cannot be empty")
    history_data = await load_chat_history(session_id)
    if not history_data:
        raise HTTPException(status_code=404, detail="Chat not found")
    await save_chat_history(session_id, history_data.get("messages", []), title=new_title)
    return {"status": "ok", "title": new_title}


@router.patch("/api/history/{session_id}/pin")
async def pin_chat_endpoint(session_id: str, body: object = Body(default=None)):
    """Toggle a chat's pinned flag. Does not change updated_at (no date-bucket jump)."""
    session_id = _require_route_safe_id(session_id, "session_id")
    body = _require_body_dict(body)
    is_pinned = body.get("is_pinned")
    if not isinstance(is_pinned, bool):
        raise HTTPException(status_code=400, detail="is_pinned must be a boolean")
    summary = await set_chat_pinned(session_id, is_pinned)
    if summary is None:
        raise HTTPException(status_code=404, detail="Chat not found")
    return {"status": "ok", **summary}


@router.post("/api/history/{session_id}/duplicate")
async def duplicate_chat_endpoint(session_id: str):
    """Deep-copy a chat into a new independent session. Does not switch to it."""
    session_id = _require_route_safe_id(session_id, "session_id")
    summary = await duplicate_chat(session_id)
    if summary is None:
        raise HTTPException(status_code=404, detail="Chat not found")
    return {"status": "ok", **summary}


@router.post("/api/history/{session_id}/fork")
async def fork_chat_endpoint(session_id: str, body: object = Body(default=None)):
    """Create a new session from the prefix up to and including a message index."""
    session_id = _require_route_safe_id(session_id, "session_id")
    body = _require_body_dict(body)
    upto = body.get("upto_message_index")
    try:
        upto_index = int(upto)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="upto_message_index must be an integer")
    summary = await fork_chat_from(session_id, upto_index)
    if summary is None:
        raise HTTPException(status_code=404, detail="Chat not found")
    return {"status": "ok", **summary}


@router.get("/api/history/{session_id}/export")
async def export_chat(session_id: str, format: str = "markdown"):
    """导出单个对话。支持 markdown (默认) 和 json 格式。"""
    from ..database import load_chat_history
    from fastapi.responses import Response
    import datetime as _dt

    session_id = _require_route_safe_id(session_id, "session_id")
    data = await load_chat_history(session_id)
    if not data:
        raise HTTPException(status_code=404, detail="对话不存在")

    messages = data.get("messages", [])
    title = data.get("title", "对话导出")
    date_str = _dt.datetime.now().strftime("%Y%m%d")

    if format.lower() == "json":
        # JSON export — full data
        import json
        content = json.dumps(data, ensure_ascii=False, indent=2)
        return Response(
            content=content,
            media_type="application/json; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="chat-{session_id[:8]}-{date_str}.json"'},
        )

    # Markdown export (default)
    md_lines = [f"# {title}\n"]
    md_lines.extend(_chat_to_markdown(data, "##"))

    return Response(
        content="\n".join(md_lines),
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="chat-{session_id[:8]}-{date_str}.md"'},
    )


@router.delete("/api/history")
async def delete_all_chats_endpoint():
    await delete_all_chats()
    return {"status": "ok"}
