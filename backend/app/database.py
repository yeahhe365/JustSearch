"""
SQLite + SQLAlchemy async database module for JustSearch.
Replaces JSON file-based chat and settings storage.
"""

import json
import logging
import os
import re
import asyncio
import copy
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional, List, Dict, Any

from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy import Boolean, Column, String, Text, DateTime, Integer, ForeignKey, JSON, select, delete, update, text
from sqlalchemy.orm import DeclarativeBase, relationship
from sqlalchemy.sql import func

from .legacy_migration import migrate_legacy_data

logger = logging.getLogger(__name__)

_ROUTE_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")


def _utc_now() -> datetime:
    """Return a naive UTC datetime for SQLite storage."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _format_utc_timestamp(value) -> str:
    if not value:
        return ""
    if isinstance(value, str):
        value = value.strip()
        if value.endswith("Z"):
            value = value[:-1] + '+00:00'
        try:
            value = datetime.fromisoformat(value)
        except ValueError:
            return value
    if not isinstance(value, datetime):
        return str(value)
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    else:
        value = value.astimezone(timezone.utc)
    return value.isoformat().replace('+00:00', 'Z')


def _parse_imported_timestamp(value, fallback: Optional[datetime] = None) -> datetime:
    """Parse imported ISO or millisecond timestamps into naive UTC datetimes."""
    if value is None or value == "":
        return fallback or _utc_now()

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        timestamp = float(value)
        if timestamp > 10_000_000_000:
            timestamp = timestamp / 1000
        try:
            return datetime.fromtimestamp(timestamp, timezone.utc).replace(tzinfo=None)
        except (OverflowError, OSError, ValueError):
            return fallback or _utc_now()

    if isinstance(value, str):
        raw = value.strip()
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        try:
            parsed = datetime.fromisoformat(raw)
            if parsed.tzinfo is None:
                return parsed
            return parsed.astimezone(timezone.utc).replace(tzinfo=None)
        except ValueError:
            return fallback or _utc_now()

    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value
        return value.astimezone(timezone.utc).replace(tzinfo=None)

    return fallback or _utc_now()

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_DATA_DIR = os.path.join(_PROJECT_ROOT, "data")
_DB_PATH = os.path.join(_DATA_DIR, "justsearch.db")
_DATABASE_URL = f"sqlite+aiosqlite:///{_DB_PATH}"

# Legacy paths (for migration)
_CHATS_DIR = os.path.join(_PROJECT_ROOT, "chats")
_SETTINGS_FILE = os.path.join(_PROJECT_ROOT, "settings.json")

# ---------------------------------------------------------------------------
# SQLAlchemy base & engine
# ---------------------------------------------------------------------------


class Base(DeclarativeBase):
    pass


_engine = None
_async_session_factory: Optional[async_sessionmaker[AsyncSession]] = None


async def get_session() -> AsyncSession:
    """Return a new async database session."""
    if _async_session_factory is None:
        raise RuntimeError("Database not initialised – call init_db() first")
    return _async_session_factory()


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class ChatGroup(Base):
    __tablename__ = "chat_groups"

    id = Column(String, primary_key=True)
    title = Column(String, nullable=False)
    is_expanded = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, default=func.now(), index=True)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now(), index=True)


class ChatSession(Base):
    __tablename__ = "chat_sessions"

    id = Column(String, primary_key=True)
    title = Column(String, default="新对话")
    group_id = Column(String, ForeignKey("chat_groups.id", ondelete="SET NULL"), nullable=True, index=True)
    is_pinned = Column(Boolean, default=False, nullable=False, index=True)
    created_at = Column(DateTime, default=func.now(), index=True)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now(), index=True)

    messages = relationship(
        "ChatMessage",
        back_populates="session",
        cascade="all, delete-orphan",
        order_by=lambda: (ChatMessage.created_at, ChatMessage.id),
    )


class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String, ForeignKey("chat_sessions.id", ondelete="CASCADE"), nullable=False, index=True)
    role = Column(String, nullable=False)
    content = Column(Text, default="")
    logs = Column(JSON, default=list)
    sources = Column(JSON, default=list)
    stats = Column(JSON, default=dict)
    # Citation evidence: claim → quote mappings for [n] markers (research credibility).
    citations = Column(JSON, default=list)
    created_at = Column(DateTime, default=func.now())

    session = relationship("ChatSession", back_populates="messages")


def _message_from_dict(msg, session_id, *, created_at=None):
    """Build a ChatMessage row from a message dict, normalizing JSON field types.

    Shared by save/duplicate/fork/import so every path keeps the same
    isinstance normalization (logs/sources/stats/citations can arrive as
    ``None`` or wrong types from older exports and must not crash the insert).
    """
    return ChatMessage(
        session_id=session_id,
        role=str(msg.get("role", "user")),
        content=str(msg.get("content", "")),
        logs=msg.get("logs") if isinstance(msg.get("logs"), list) else [],
        sources=msg.get("sources") if isinstance(msg.get("sources"), list) else [],
        stats=msg.get("stats") if isinstance(msg.get("stats"), dict) else {},
        citations=msg.get("citations") if isinstance(msg.get("citations"), list) else [],
        created_at=created_at if created_at is not None else _utc_now(),
    )


class Settings(Base):
    __tablename__ = "settings"

    id = Column(Integer, primary_key=True, autoincrement=True)
    key = Column(String, unique=True, nullable=False)
    value = Column(Text, default="")


# ---------------------------------------------------------------------------
# Initialisation & migration
# ---------------------------------------------------------------------------


async def init_db():
    """Create the data directory, engine, tables and run legacy migration."""
    global _engine, _async_session_factory

    os.makedirs(_DATA_DIR, exist_ok=True)

    _engine = create_async_engine(
        _DATABASE_URL,
        echo=False,
        pool_pre_ping=True,
        pool_size=5,
        max_overflow=10,
        pool_recycle=1800,  # Recycle connections after 30 minutes
        connect_args={"check_same_thread": False},
    )
    _async_session_factory = async_sessionmaker(_engine, expire_on_commit=False)

    # Enable WAL mode for better concurrent read/write performance
    async with _engine.begin() as conn:
        await conn.execute(text("PRAGMA journal_mode=WAL"))
        await conn.execute(text("PRAGMA synchronous=NORMAL"))
        await conn.execute(text("PRAGMA cache_size=-64000"))  # 64MB cache
        await conn.run_sync(Base.metadata.create_all)

    # Ensure missing columns are added (create_all only creates new tables)
    async with _engine.begin() as conn:
        result = await conn.execute(text("PRAGMA table_info('chat_sessions')"))
        session_cols = {row[1] for row in result}
        if "group_id" not in session_cols:
            await conn.execute(text(
                "ALTER TABLE chat_sessions ADD COLUMN group_id VARCHAR"
            ))
            logger.info("Added missing 'group_id' column to chat_sessions")
        if "is_pinned" not in session_cols:
            await conn.execute(text(
                "ALTER TABLE chat_sessions ADD COLUMN is_pinned BOOLEAN DEFAULT 0"
            ))
            logger.info("Added missing 'is_pinned' column to chat_sessions")

        result = await conn.execute(text("PRAGMA table_info('chat_messages')"))
        existing_cols = {row[1] for row in result}
        if "stats" not in existing_cols:
            await conn.execute(text(
                "ALTER TABLE chat_messages ADD COLUMN stats JSON DEFAULT '{}'"
            ))
            logger.info("Added missing 'stats' column to chat_messages")
        if "citations" not in existing_cols:
            await conn.execute(text(
                "ALTER TABLE chat_messages ADD COLUMN citations JSON DEFAULT '[]'"
            ))
            logger.info("Added missing 'citations' column to chat_messages")

        # Ensure performance indexes exist
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_chat_messages_session_created "
            "ON chat_messages (session_id, created_at)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_chat_sessions_updated "
            "ON chat_sessions (updated_at)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_chat_sessions_group_updated "
            "ON chat_sessions (group_id, updated_at)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_chat_sessions_pinned "
            "ON chat_sessions (is_pinned)"
        ))
        # Full-text search index for chat content search
        await conn.execute(text(
            "CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts "
            "USING fts5(session_id, content, tokenize='unicode61')"
        ))
        await conn.execute(text(
            "CREATE TRIGGER IF NOT EXISTS chat_messages_ai AFTER INSERT ON chat_messages "
            "BEGIN "
            "INSERT INTO chat_messages_fts(rowid, session_id, content) "
            "VALUES (new.id, new.session_id, new.content); "
            "END"
        ))
        await conn.execute(text(
            "CREATE TRIGGER IF NOT EXISTS chat_messages_ad AFTER DELETE ON chat_messages "
            "BEGIN "
            "DELETE FROM chat_messages_fts WHERE rowid = old.id; "
            "END"
        ))
        await conn.execute(text(
            "CREATE TRIGGER IF NOT EXISTS chat_messages_au AFTER UPDATE ON chat_messages "
            "BEGIN "
            "DELETE FROM chat_messages_fts WHERE rowid = old.id; "
            "INSERT INTO chat_messages_fts(rowid, session_id, content) "
            "VALUES (new.id, new.session_id, new.content); "
            "END"
        ))
        # Incremental: only backfill when FTS is empty. Runtime triggers keep it in sync;
        # wiping + full rebuild on every startup is unnecessary and slow for large DBs.
        fts_count = (
            await conn.execute(text("SELECT count(*) FROM chat_messages_fts"))
        ).scalar_one()
        if fts_count == 0:
            await conn.execute(text(
                "INSERT INTO chat_messages_fts(rowid, session_id, content) "
                "SELECT id, session_id, content FROM chat_messages"
            ))

    logger.info("Database initialised at %s", _DB_PATH)

    # One-time migration from legacy JSON files
    await migrate_legacy_data(
        get_session,
        ChatSession,
        ChatMessage,
        Settings,
        _CHATS_DIR,
        _SETTINGS_FILE,
        logger,
    )

    # Auto-cleanup: remove sessions older than 90 days with no messages
    await _cleanup_old_sessions()


async def _cleanup_old_sessions(max_age_days: int = 90):
    """Remove empty sessions older than max_age_days."""
    try:
        # updated_at is stored as naive UTC (_utc_now), so the cutoff must be
        # UTC too — using local naive time shifts the window by the local TZ
        # offset (e.g. UTC+8 would delete sessions "updated" up to 8h ago).
        cutoff = _utc_now() - timedelta(days=max_age_days)
        async with await get_session() as session:
            result = await session.execute(
                delete(ChatSession)
                .where(ChatSession.updated_at < cutoff)
                .where(
                    ~select(ChatMessage.id)
                    .where(ChatMessage.session_id == ChatSession.id)
                    .exists()
                )
            )
            if result.rowcount > 0:
                await session.commit()
                logger.info("Cleaned up %d empty sessions older than %d days", result.rowcount, max_age_days)
    except Exception as e:
        logger.warning("Session cleanup failed: %s", e)


# ---------------------------------------------------------------------------
# Chat helpers
# ---------------------------------------------------------------------------


def _session_id_from_legacy_path(value: str) -> Optional[str]:
    """Extract a session id only from direct legacy chat JSON paths."""
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        path = os.path.abspath(raw)
        chats_dir = os.path.abspath(_CHATS_DIR)
        if os.path.dirname(path) != chats_dir:
            return None
        if os.path.splitext(path)[1].lower() != ".json":
            return None
    except (OSError, ValueError):
        return None
    return normalize_route_safe_id(os.path.splitext(os.path.basename(path))[0])


def _normalize_chat_history_lookup_id(session_id_or_path: str) -> Optional[str]:
    legacy_id = _session_id_from_legacy_path(session_id_or_path)
    if legacy_id:
        return legacy_id
    return normalize_route_safe_id(session_id_or_path)


async def load_chat_history(session_id_or_path: str) -> Optional[Dict[str, Any]]:
    """
    Load chat history by session_id (or legacy file path for compatibility).
    Returns dict with keys: id, title, timestamp, messages  – same shape as old JSON.
    """
    session_id = _normalize_chat_history_lookup_id(session_id_or_path)
    if not session_id:
        return None

    async with await get_session() as session:
        sess = (await session.execute(
            select(ChatSession).where(ChatSession.id == session_id)
        )).scalar_one_or_none()

        if sess is None:
            return None

        msgs = (await session.execute(
            select(ChatMessage).where(ChatMessage.session_id == session_id)
            .order_by(ChatMessage.created_at, ChatMessage.id)
        )).scalars().all()

        messages = []
        for m in msgs:
            msg_dict: Dict[str, Any] = {"role": m.role, "content": m.content}
            if m.logs:
                msg_dict["logs"] = m.logs
            if m.sources:
                # Never ship full crawl bodies to the client; keep snippet/excerpt only.
                try:
                    from .citation_evidence import client_source_payload
                    msg_dict["sources"] = client_source_payload(m.sources)
                except Exception:
                    msg_dict["sources"] = m.sources
            if m.stats:
                msg_dict["stats"] = m.stats
            citations = getattr(m, "citations", None)
            if citations:
                msg_dict["citations"] = citations
            if m.created_at:
                msg_dict["timestamp"] = _format_utc_timestamp(m.created_at)
            messages.append(msg_dict)

        return {
            "id": sess.id,
            "title": sess.title,
            "group_id": sess.group_id,
            "is_pinned": bool(sess.is_pinned),
            "timestamp": _format_utc_timestamp(sess.updated_at),
            "messages": messages,
        }


async def save_chat_history(session_id: str, messages: list, title: Optional[str] = None):
    """
    Incrementally append new messages to an existing session.
    Detects which messages are new by comparing against what's already stored.
    Falls back to full upsert for new sessions.
    Uses optimistic concurrency control with a version check on the session row.
    """
    if not messages:
        return

    async with await get_session() as session:
        # Use a transaction with SERIALIZABLE isolation (SQLite default).
        # Lock the session row to prevent concurrent modifications.
        sess = (await session.execute(
            select(ChatSession).where(ChatSession.id == session_id)
        )).scalar_one_or_none()

        now = _utc_now()

        if sess is None:
            if not title:
                first_content = messages[0].get("content", "") if messages else ""
                title = _extract_title(first_content)
            sess = ChatSession(id=session_id, title=title, created_at=now, updated_at=now)
            session.add(sess)
            # New session – insert all messages
            for msg in messages:
                session.add(_message_from_dict(msg, session_id))
            await session.commit()
            return

        if title:
            sess.title = title
        sess.updated_at = now

        # 前缀校验：客户端传来的 messages 应与 DB 已存消息的前缀一致。
        # 按 count 增量追加在并发/陈旧客户端下会静默丢新消息（count 比客户端
        # 数组大时 new_msgs 为空或错位）。比较最后一条已存消息与客户端对应
        # 位置的消息的 (role, content)，不一致说明视图已过期，直接返回不再
        # 追加——新消息不会丢，客户端下次拉取完整历史即可拿到最新状态。
        #
        # 使用行级锁防止并发修改：在 SQLite 中通过 BEGIN IMMEDIATE 事务实现。
        # 这里我们重新获取会话以确保在事务内读取最新状态。
        existing_rows = (await session.execute(
            select(ChatMessage).where(ChatMessage.session_id == session_id)
            .order_by(ChatMessage.created_at, ChatMessage.id)
        )).scalars().all()
        existing_count = len(existing_rows)

        if existing_count > len(messages):
            logger.warning(
                "save_chat_history: DB 已有 %d 条消息而客户端仅提供 %d 条，"
                "前缀不匹配，跳过追加 (session=%s)",
                existing_count, len(messages), session_id,
            )
            return
        if existing_count > 0:
            db_last = existing_rows[-1]
            client_at_last = messages[existing_count - 1]
            if str(db_last.role) != str(client_at_last.get("role", "")) or (
                db_last.content or ""
            ) != str(client_at_last.get("content", "") or ""):
                logger.warning(
                    "save_chat_history: 第 %d 条消息前缀不匹配(role/content 不一致)，"
                    "跳过追加以避免并发下静默丢消息 (session=%s)",
                    existing_count, session_id,
                )
                return

        new_msgs = messages[existing_count:]
        if new_msgs:
            for msg in new_msgs:
                session.add(_message_from_dict(msg, session_id))

        await session.commit()


async def list_chats(limit: int = 100, offset: int = 0) -> List[Dict[str, Any]]:
    """Return list of chat summaries (id, title, timestamp), newest first. Supports pagination."""
    try:
        limit = int(limit)
        offset = int(offset)
    except (TypeError, ValueError):
        limit = 100
        offset = 0
    limit = max(0, limit)
    offset = max(0, offset)
    if limit == 0:
        return []

    target_count = offset + limit
    scan_offset = 0
    batch_size = min(max(target_count, 100), 1000)
    chats = []

    async with await get_session() as session:
        while len(chats) < target_count:
            result = await session.execute(
                select(ChatSession)
                .order_by(ChatSession.is_pinned.desc(), ChatSession.updated_at.desc())
                .limit(batch_size)
                .offset(scan_offset)
            )
            sessions = result.scalars().all()
            if not sessions:
                break

            for s in sessions:
                session_id = normalize_route_safe_id(s.id)
                if not session_id:
                    continue
                chats.append({
                    "id": session_id,
                    "title": s.title,
                    "group_id": normalize_route_safe_id(s.group_id) if s.group_id else None,
                    "is_pinned": bool(s.is_pinned),
                    "timestamp": _format_utc_timestamp(s.updated_at),
                })

            scan_offset += len(sessions)

    return chats[offset:target_count]


def _group_to_dict(group: ChatGroup) -> Dict[str, Any]:
    group_id = normalize_route_safe_id(group.id)
    if not group_id:
        return {}
    return {
        "id": group_id,
        "title": group.title,
        "is_expanded": bool(group.is_expanded),
        "timestamp": _format_utc_timestamp(group.updated_at),
    }


async def list_chat_groups() -> List[Dict[str, Any]]:
    """Return user-defined chat groups, newest first."""
    async with await get_session() as session:
        result = await session.execute(
            select(ChatGroup).order_by(ChatGroup.updated_at.desc())
        )
        groups = result.scalars().all()
        return [
            group_dict
            for group in groups
            if (group_dict := _group_to_dict(group))
        ]


async def create_chat_group(title: str) -> Dict[str, Any]:
    title = title.strip() or "新分组"
    now = _utc_now()
    group = ChatGroup(
        id=f"group-{int(now.timestamp() * 1000)}-{uuid.uuid4().hex[:8]}",
        title=title,
        is_expanded=True,
        created_at=now,
        updated_at=now,
    )
    async with await get_session() as session:
        session.add(group)
        await session.commit()
        await session.refresh(group)
        return _group_to_dict(group)


async def update_chat_group(
    group_id: str,
    title: Optional[str] = None,
    is_expanded: Optional[bool] = None,
) -> Optional[Dict[str, Any]]:
    async with await get_session() as session:
        group = (await session.execute(
            select(ChatGroup).where(ChatGroup.id == group_id)
        )).scalar_one_or_none()
        if group is None:
            return None

        if title is not None and title.strip():
            group.title = title.strip()
        if is_expanded is not None:
            group.is_expanded = bool(is_expanded)
        group.updated_at = _utc_now()

        await session.commit()
        await session.refresh(group)
        return _group_to_dict(group)


async def delete_chat_group(group_id: str) -> bool:
    async with await get_session() as session:
        group = (await session.execute(
            select(ChatGroup).where(ChatGroup.id == group_id)
        )).scalar_one_or_none()
        if group is None:
            return False

        await session.execute(
            update(ChatSession)
            .where(ChatSession.group_id == group_id)
            .values(group_id=None)
        )
        await session.delete(group)
        await session.commit()
        return True


async def move_chat_to_group(session_id: str, group_id: Optional[str]) -> bool:
    async with await get_session() as session:
        sess = (await session.execute(
            select(ChatSession).where(ChatSession.id == session_id)
        )).scalar_one_or_none()
        if sess is None:
            return False

        if group_id is not None:
            group = (await session.execute(
                select(ChatGroup).where(ChatGroup.id == group_id)
            )).scalar_one_or_none()
            if group is None:
                return False

        sess.group_id = group_id
        await session.commit()
        return True


async def set_chat_pinned(session_id: str, is_pinned: bool) -> Optional[Dict[str, Any]]:
    """Toggle a chat's pinned flag without bumping ``updated_at``.

    Pinning must not move a chat into the "today" date bucket — it only reorders
    it ahead of unpinned peers (``list_chats`` sorts ``is_pinned DESC, updated_at
    DESC``), mirroring AMC's pinned-ungrouped section. The ORM ``onupdate`` on
    ``updated_at`` fires on any UPDATE, so we use a Core ``update()`` (which does
    not apply ORM flush-time onupdate defaults) to leave the timestamp untouched.
    """
    is_pinned = bool(is_pinned)
    async with await get_session() as session:
        # Pin the chat WITHOUT bumping updated_at. The ORM/Core onupdate on
        # updated_at fires on every UPDATE, so we preserve the existing value
        # by explicitly setting updated_at = updated_at (a no-op assignment that
        # prevents the server-side onupdate from replacing it). This keeps the
        # chat in its original date bucket; only is_pinned changes.
        result = await session.execute(
            update(ChatSession)
            .where(ChatSession.id == session_id)
            .values(is_pinned=is_pinned, updated_at=ChatSession.updated_at)
        )
        if (result.rowcount or 0) == 0:
            await session.rollback()
            return None
        await session.commit()

        result = await session.execute(
            select(ChatSession.id, ChatSession.title, ChatSession.group_id,
                   ChatSession.is_pinned, ChatSession.updated_at)
            .where(ChatSession.id == session_id)
        )
        row = result.first()
        if row is None:
            return None
        sid, title, group_id, pinned_flag, updated_at = row
        return {
            "id": normalize_route_safe_id(sid),
            "title": title,
            "group_id": normalize_route_safe_id(group_id) if group_id else None,
            "is_pinned": bool(pinned_flag),
            "timestamp": _format_utc_timestamp(updated_at),
        }


async def delete_chat(session_id: str) -> bool:
    async with await get_session() as session:
        result = await session.execute(
            delete(ChatSession).where(ChatSession.id == session_id)
        )
        await session.commit()
        return (result.rowcount or 0) > 0


async def _new_session_id() -> str:
    """Generate a route-safe session id matching chat.py's format."""
    return datetime.now().strftime("%Y%m%d%H%M%S") + "-" + uuid.uuid4().hex[:4]


def _session_summary_from_row(row) -> Dict[str, Any]:
    sid, title, group_id, pinned_flag, updated_at = row
    return {
        "id": normalize_route_safe_id(sid),
        "title": title,
        "group_id": normalize_route_safe_id(group_id) if group_id else None,
        "is_pinned": bool(pinned_flag),
        "timestamp": _format_utc_timestamp(updated_at),
    }


async def _copy_session(
    source: dict,
    messages: list,
    title: str,
) -> Optional[Dict[str, Any]]:
    """Create a new independent session from ``source``, copying ``messages``.

    Shared by duplicate_chat (copies all messages) and fork_chat_from (copies
    a prefix). The new session gets a fresh id, inherits the source's group_id,
    and starts unpinned.
    """
    now = _utc_now()
    new_id = await _new_session_id()
    async with await get_session() as session:
        sess = ChatSession(
            id=new_id,
            title=title,
            group_id=source.get("group_id"),
            is_pinned=False,
            created_at=now,
            updated_at=now,
        )
        session.add(sess)
        for msg in messages:
            session.add(_message_from_dict(msg, new_id, created_at=now))
        await session.commit()

        row = (await session.execute(
            select(ChatSession.id, ChatSession.title, ChatSession.group_id,
                   ChatSession.is_pinned, ChatSession.updated_at)
            .where(ChatSession.id == new_id)
        )).first()
        if row is None:
            return None
        return _session_summary_from_row(row)


async def duplicate_chat(session_id: str, new_title: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Deep-copy a chat into a new independent session.

    The duplicate gets a fresh session_id and message rows (message ids are
    auto-increment so no id remapping is needed), inherits the source's
    group_id, starts unpinned, and is titled ``"<source>（副本）"`` unless
    ``new_title`` overrides. Mirrors AMC's handleDuplicateSession.
    """
    source = await load_chat_history(session_id)
    if not source:
        return None
    messages = source.get("messages", [])
    title = (new_title or f"{source.get('title') or '新对话'}（副本）").strip()
    return await _copy_session(source, messages, title)


async def fork_chat_from(
    session_id: str,
    upto_message_index: int,
    new_title: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Create a new session containing the prefix of ``session_id`` up to and
    including message ``upto_message_index`` (0-based). The source session is
    left untouched. Mirrors AMC's handleForkMessage.
    """
    source = await load_chat_history(session_id)
    if not source:
        return None
    messages = source.get("messages", [])
    try:
        idx = int(upto_message_index)
    except (TypeError, ValueError):
        return None
    if idx < 0:
        idx = 0
    if idx >= len(messages):
        idx = len(messages) - 1
    prefix = messages[: idx + 1]
    if not prefix:
        return None
    title = (new_title or f"{source.get('title') or '新对话'}（分叉）").strip()
    return await _copy_session(source, prefix, title)


async def delete_message(
    session_id: str,
    message_index: int,
    expected_content: Optional[str] = None,
):
    """Delete a single message by its index (0-based) within a session.

    ``expected_content`` is a concurrency guard: when provided and the message
    at ``message_index`` has different content, the delete is refused (returns
    False) instead of removing a message that drifted under concurrent edits.
    """
    async with await get_session() as session:
        sess = (await session.execute(
            select(ChatSession).where(ChatSession.id == session_id)
        )).scalar_one_or_none()
        if sess is None:
            return False

        msgs = (await session.execute(
            select(ChatMessage).where(ChatMessage.session_id == session_id)
            .order_by(ChatMessage.created_at, ChatMessage.id)
        )).scalars().all()

        if message_index < 0 or message_index >= len(msgs):
            return False

        target = msgs[message_index]
        if expected_content is not None and (target.content or "") != str(expected_content):
            logger.warning(
                "delete_message: 下标 %d 处的消息内容与客户端不一致，拒绝删除 (session=%s)",
                message_index, session_id,
            )
            return False

        await session.delete(target)
        sess.updated_at = _utc_now()
        await session.commit()
        return True


async def replace_messages_from(
    session_id: str,
    from_index: int,
    new_messages: List[Dict[str, Any]],
    title: Optional[str] = None,
    expected_prefix: Optional[List[Dict[str, Any]]] = None,
) -> bool:
    """Atomically replace ``from_index`` and onward with ``new_messages``.

    Deletes the tail and inserts the new turn inside a single transaction, so
    a workflow failure after the truncate no longer permanently loses history:
    callers now truncate in-memory only and call this on the success path. If
    the workflow fails, nothing is committed and the tail stays intact.
    Returns True when the session exists.

    ``expected_prefix`` is the caller's view of the messages before
    ``from_index`` (used as a concurrency check): when it is provided and does
    not match the stored prefix, the delete is refused (returns False) instead
    of truncating at an index that drifted under concurrent edits.

    Uses optimistic concurrency control with prefix validation within the
    same transaction to prevent concurrent modifications.
    """
    if from_index is None or not new_messages:
        return False
    try:
        from_index = int(from_index)
    except (TypeError, ValueError):
        return False
    if from_index < 0:
        from_index = 0

    async with await get_session() as session:
        sess = (await session.execute(
            select(ChatSession).where(ChatSession.id == session_id)
        )).scalar_one_or_none()
        if sess is None:
            return False

        # All reads and writes happen in the same transaction.
        # SQLite's WAL mode with SERIALIZABLE isolation ensures consistency.
        msgs = (await session.execute(
            select(ChatMessage).where(ChatMessage.session_id == session_id)
            .order_by(ChatMessage.created_at, ChatMessage.id)
        )).scalars().all()

        if expected_prefix is not None:
            prefix = msgs[:from_index]
            if len(prefix) != len(expected_prefix):
                logger.warning(
                    "replace_messages_from: 前缀长度不匹配(DB=%d, 客户端=%d)，"
                    "拒绝截断 (session=%s, from_index=%d)",
                    len(prefix), len(expected_prefix), session_id, from_index,
                )
                return False
            for db_msg, client_msg in zip(prefix, expected_prefix):
                if str(db_msg.role) != str(client_msg.get("role", "")) or (
                    db_msg.content or ""
                ) != str(client_msg.get("content", "") or ""):
                    logger.warning(
                        "replace_messages_from: 前缀内容不匹配，拒绝截断 (session=%s, from_index=%d)",
                        session_id, from_index,
                    )
                    return False

        if from_index > len(msgs):
            from_index = len(msgs)
        for m in msgs[from_index:]:
            await session.delete(m)
        for msg in new_messages:
            session.add(_message_from_dict(msg, session_id))
        if title:
            sess.title = title
        sess.updated_at = _utc_now()
        await session.commit()
    return True


async def delete_all_chats():
    async with await get_session() as session:
        await session.execute(delete(ChatMessage))
        await session.execute(delete(ChatSession))
        await session.execute(delete(ChatGroup))
        await session.commit()


async def export_history_package() -> Dict[str, Any]:
    """Return a portable JSON package containing all chats and chat groups."""
    groups = await list_chat_groups()
    summaries = await list_chats(limit=100000)
    history = []
    for summary in summaries:
        chat = await load_chat_history(summary["id"])
        if chat:
            history.append(chat)
    return {
        "type": "JustSearch-History",
        "version": 1,
        "history": history,
        "groups": groups,
    }


def _normalize_imported_group(group: dict) -> Optional[Dict[str, Any]]:
    group_id = normalize_route_safe_id(group.get("id", ""))
    if not group_id:
        return None
    timestamp = _parse_imported_timestamp(group.get("timestamp"))
    return {
        "id": group_id,
        "title": str(group.get("title", "")).strip() or "导入分组",
        "is_expanded": group.get("is_expanded") if isinstance(group.get("is_expanded"), bool) else True,
        "created_at": timestamp,
        "updated_at": timestamp,
    }


def _normalize_imported_message(message: dict, index: int, session_time: datetime) -> Dict[str, Any]:
    message_time = _parse_imported_timestamp(
        message.get("timestamp"),
        session_time + timedelta(microseconds=index),
    )
    role = str(message.get("role", "user")).strip() or "user"
    if role == "model":
        role = "assistant"
    if role not in {"user", "assistant", "system", "error"}:
        role = "assistant" if role in {"ai", "bot"} else "user"
    return {
        "role": role,
        "content": str(message.get("content", "")),
        "logs": message.get("logs") if isinstance(message.get("logs"), list) else [],
        "sources": message.get("sources") if isinstance(message.get("sources"), list) else [],
        "stats": message.get("stats") if isinstance(message.get("stats"), dict) else {},
        "citations": message.get("citations") if isinstance(message.get("citations"), list) else [],
        "created_at": message_time,
    }


def normalize_route_safe_id(value: Any) -> Optional[str]:
    if not isinstance(value, (str, int, float)) or isinstance(value, bool):
        return None
    normalized = str(value).strip()
    if not normalized:
        return None
    if not _ROUTE_SAFE_ID_RE.fullmatch(normalized):
        return None
    return normalized


def _normalize_optional_id(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, (str, int, float)) and not isinstance(value, bool):
        return normalize_route_safe_id(value)
    return None


def _normalize_imported_chat(chat: dict) -> Optional[Dict[str, Any]]:
    session_id = normalize_route_safe_id(chat.get("id", ""))
    messages = chat.get("messages")
    if not session_id or not isinstance(messages, list) or not messages:
        return None
    session_time = _parse_imported_timestamp(chat.get("timestamp"))
    normalized_messages = [
        _normalize_imported_message(message, index, session_time)
        for index, message in enumerate(messages)
        if isinstance(message, dict)
    ]
    if not normalized_messages:
        return None
    return {
        "id": session_id,
        "title": str(chat.get("title", "")).strip()
        or _extract_title(normalized_messages[0]["content"]),
        "group_id": _normalize_optional_id(chat.get("group_id") or chat.get("groupId")),
        "is_pinned": bool(chat.get("is_pinned")) if isinstance(chat.get("is_pinned"), bool) else False,
        "created_at": session_time,
        "updated_at": session_time,
        "messages": normalized_messages,
    }


def _normalize_history_import_payload(payload: dict) -> tuple[list[Dict[str, Any]], list[Dict[str, Any]]]:
    if not isinstance(payload, dict):
        raise ValueError("导入文件必须是 JSON 对象")

    package_type = payload.get("type")
    if package_type not in {"JustSearch-History", "AllModelChat-History"}:
        raise ValueError("导入文件类型不正确")

    raw_history = payload.get("history")
    if not isinstance(raw_history, list):
        raise ValueError("导入文件缺少 history 数组")

    groups = []
    for group in payload.get("groups") or []:
        if isinstance(group, dict):
            normalized = _normalize_imported_group(group)
            if normalized:
                groups.append(normalized)

    chats = []
    for chat in raw_history:
        if isinstance(chat, dict):
            normalized = _normalize_imported_chat(chat)
            if normalized and normalized["messages"]:
                chats.append(normalized)

    return chats, groups


async def import_history_package(payload: dict) -> Dict[str, int]:
    """Import a JustSearch/AMC history package, skipping existing IDs."""
    chats, groups = _normalize_history_import_payload(payload)
    imported_sessions = 0
    skipped_sessions = 0
    imported_groups = 0
    skipped_groups = 0

    async with await get_session() as session:
        existing_group_ids = {
            row[0]
            for row in (
                await session.execute(select(ChatGroup.id))
            ).all()
        }
        for group in groups:
            if group["id"] in existing_group_ids:
                skipped_groups += 1
                continue
            session.add(ChatGroup(**group))
            existing_group_ids.add(group["id"])
            imported_groups += 1

        existing_session_ids = {
            row[0]
            for row in (
                await session.execute(select(ChatSession.id))
            ).all()
        }
        for chat in chats:
            if chat["id"] in existing_session_ids:
                skipped_sessions += 1
                continue

            group_id = chat["group_id"] if chat["group_id"] in existing_group_ids else None
            session.add(ChatSession(
                id=chat["id"],
                title=chat["title"],
                group_id=group_id,
                is_pinned=bool(chat.get("is_pinned")),
                created_at=chat["created_at"],
                updated_at=chat["updated_at"],
            ))
            for message in chat["messages"]:
                session.add(_message_from_dict(
                    message,
                    chat["id"],
                    created_at=message["created_at"],
                ))
            existing_session_ids.add(chat["id"])
            imported_sessions += 1

        await session.commit()

    return {
        "imported_sessions": imported_sessions,
        "skipped_sessions": skipped_sessions,
        "imported_groups": imported_groups,
        "skipped_groups": skipped_groups,
    }


def get_chat_path(session_id: str) -> str:
    """
    Legacy compatibility: no longer returns a real file path.
    We return a sentinel that load_chat_history can parse.
    """
    return os.path.join(_CHATS_DIR, f"{session_id}.json")


# ---------------------------------------------------------------------------
# Settings helpers
# ---------------------------------------------------------------------------

DEFAULT_SETTINGS = {
    "theme": "light",
    "default_provider_id": "deepseek",
    "providers": [
        {
            "id": "deepseek",
            "name": "DeepSeek",
            "api_key": "",
            "base_url": "https://api.deepseek.com/v1",
            "model_id": "deepseek-v4-pro",
            "enabled": True,
        }
    ],
    "workflow_step_models": {
        "analysis": {"provider_id": "", "model_id": ""},
        "relevance": {"provider_id": "", "model_id": ""},
        "interaction": {"provider_id": "", "model_id": ""},
        "answer": {"provider_id": "", "model_id": ""},
    },
    "search_engine": "google",
    "max_results": "50",
    "max_iterations": "5",
    "interactive_search": "true",
    "live_artifacts_mode": False,
    # Optional semantic citation verification (off by default; adds 1 bounded LLM
    # call after answer generation). Existing settings without this key stay off.
    "citation_verification_enabled": False,
    # Bridge UX preferences (web UI only; extension WS address is configured in the Chrome popup).
    "bridge_require_before_send": True,
    "bridge_show_banner": True,
    "bridge_toast_on_change": True,
    "bridge_poll_interval_sec": 5,
    # Reading size for chat messages (mirrors AMC baseFontSize: 12–24, default 16).
    "base_font_size": 16,
    # Base size for Live Artifacts previews (mirrors AMC liveArtifactsCustomFontSize: 10–32, default 16).
    "live_artifacts_font_size": 16,
    # Completion feedback (mirrors AMC isCompletionNotificationEnabled / isCompletionSoundEnabled).
    # Desktop notification is only fired while the tab is hidden (document.hidden);
    # the sound is a short two-tone chime via WebAudio.
    "completion_notification_enabled": False,
    "completion_sound_enabled": False,
    # Conversation-history compression budget for LLM context.
    # window: max number of recent turns kept; char_budget: total char cap
    # (filled newest-first); assistant_turn_char_budget: per-assistant-turn cap.
    "history_window": 12,
    "history_char_budget": 12000,
    "assistant_turn_char_budget": 900,
}

_REMOVED_SETTINGS_KEYS = {"max_context_turns"}

_api_key_index = 0
_api_key_lock = asyncio.Lock()


def mask_api_key(api_key: str) -> str:
    if not api_key:
        return ""
    if len(api_key) <= 8:
        return "****"
    return api_key[:3] + "****" + api_key[-4:]


async def get_next_api_key(api_keys_str: str) -> str:
    global _api_key_index
    if not api_keys_str:
        return api_keys_str
    keys = [k.strip() for k in api_keys_str.split(",") if k.strip()]
    if not keys:
        return ""
    if len(keys) == 1:
        return keys[0]
    async with _api_key_lock:
        current_key = keys[_api_key_index % len(keys)]
        _api_key_index = (_api_key_index + 1) % len(keys)
    return current_key


def _extract_title(content: str) -> str:
    """Extract a smart title from the user's first message."""
    if not content:
        return "新对话"
    # Strip common question prefixes
    cleaned = re.sub(r'^(请问|你好|请问一下|我想问|帮我|请|能不能|可以|how\s+to|what\s+is|who\s+is|where\s+is|why\s+is|can\s+you|please\s+)\s*', '', content.strip(), flags=re.IGNORECASE)
    # Take the first sentence (up to sentence-ending punctuation)
    m = re.search(r'^(.+?[。？！\.!?])', cleaned)
    if m:
        sentence = m.group(1).strip()
    else:
        # Take up to first newline or comma separator
        sentence = re.split(r'[\n,，;；]', cleaned)[0].strip()
    # Limit to 50 chars
    if len(sentence) > 50:
        sentence = sentence[:50] + "…"
    return sentence or "新对话"


def _parse_setting_value(raw: str):
    """Try to parse a stored string value back to its original type."""
    if raw.lower() == "true":
        return True
    if raw.lower() == "false":
        return False
    try:
        return int(raw)
    except (ValueError, TypeError):
        pass
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        pass
    return raw


async def load_settings() -> dict:
    async with await get_session() as session:
        result = await session.execute(select(Settings))
        rows = result.scalars().all()

    settings = copy.deepcopy(DEFAULT_SETTINGS)
    stored_keys = set()
    for row in rows:
        if row.key in _REMOVED_SETTINGS_KEYS:
            continue
        stored_keys.add(row.key)
        settings[row.key] = _parse_setting_value(row.value)
    settings = _normalize_loaded_settings(
        settings,
        has_stored_providers="providers" in stored_keys,
    )
    return settings


async def save_settings(settings: dict) -> bool:
    try:
        async with await get_session() as session:
            for key, value in settings.items():
                if isinstance(value, bool):
                    str_value = json.dumps(value)
                elif isinstance(value, (dict, list)):
                    str_value = json.dumps(value, ensure_ascii=False)
                else:
                    str_value = str(value) if value is not None else ""

                # Use SQLite INSERT OR REPLACE for efficient upsert
                await session.execute(
                    text("INSERT OR REPLACE INTO settings (key, value) VALUES (:k, :v)"),
                    {"k": key, "v": str_value},
                )
            await session.commit()
        return True
    except Exception as e:
        logger.error("Error saving settings: %s", e)
        return False


def _normalize_loaded_settings(
    settings: dict,
    *,
    has_stored_providers: bool = True,
) -> dict:
    """Return settings in the current provider-list shape."""
    result = copy.deepcopy(settings)
    legacy_api_key = str(result.get("api_key", "") or "").strip()
    legacy_base_url = str(result.get("base_url", "") or "").strip()
    legacy_model_id = str(result.get("model_id", "") or "").strip()
    has_legacy_model_config = any((legacy_api_key, legacy_base_url, legacy_model_id))

    if (
        not has_stored_providers
        and has_legacy_model_config
    ):
        legacy_provider = {
            "id": result.get("default_provider_id") or DEFAULT_SETTINGS["default_provider_id"],
            "name": DEFAULT_SETTINGS["providers"][0]["name"],
            "api_key": legacy_api_key,
            "base_url": legacy_base_url or DEFAULT_SETTINGS["providers"][0]["base_url"],
            "model_id": legacy_model_id or DEFAULT_SETTINGS["providers"][0]["model_id"],
        }
        result["default_provider_id"] = legacy_provider["id"]
        result["providers"] = [legacy_provider]
        result["workflow_step_models"] = _normalize_loaded_workflow_step_models(
            result.get("workflow_step_models")
        )
        return result

    if isinstance(result.get("providers"), list) and result["providers"]:
        providers = [
            provider
            for provider in (
                _normalize_loaded_provider(provider)
                for provider in result["providers"]
            )
            if provider is not None
        ]
        if not providers:
            result.pop("providers", None)
            return _normalize_loaded_settings(result, has_stored_providers=False)

        first_provider = providers[0] if isinstance(providers[0], dict) else None
        if first_provider and _should_backfill_legacy_provider(first_provider, has_legacy_model_config):
            if legacy_api_key and not str(first_provider.get("api_key", "") or "").strip():
                first_provider["api_key"] = legacy_api_key
            if legacy_base_url:
                first_provider["base_url"] = legacy_base_url
            if legacy_model_id:
                first_provider["model_id"] = legacy_model_id
        result["providers"] = providers
        provider_ids = {provider["id"] for provider in providers}
        if str(result.get("default_provider_id", "") or "").strip() not in provider_ids:
            result["default_provider_id"] = providers[0]["id"]
        result["workflow_step_models"] = _normalize_loaded_workflow_step_models(
            result.get("workflow_step_models")
        )
        return result

    legacy_provider = copy.deepcopy(DEFAULT_SETTINGS["providers"][0])
    if has_legacy_model_config:
        legacy_provider["id"] = str(
            result.get("default_provider_id") or legacy_provider["id"]
        ).strip() or legacy_provider["id"]
        legacy_provider["api_key"] = legacy_api_key
        legacy_provider["base_url"] = legacy_base_url or legacy_provider["base_url"]
        legacy_provider["model_id"] = legacy_model_id or legacy_provider["model_id"]
    result["default_provider_id"] = legacy_provider["id"]
    result["providers"] = [legacy_provider]
    result["workflow_step_models"] = _normalize_loaded_workflow_step_models(
        result.get("workflow_step_models")
    )
    return result


def _normalize_loaded_provider(provider: Any) -> Optional[dict]:
    if not isinstance(provider, dict):
        return None
    provider_id = str(provider.get("id", "") or "").strip()
    if not provider_id:
        return None
    item = provider.copy()
    item["id"] = provider_id
    # Older stored providers have no enabled flag; treat them as enabled.
    item.setdefault("enabled", True)
    return item


def _should_backfill_legacy_provider(provider: dict, has_legacy_model_config: bool) -> bool:
    if not has_legacy_model_config:
        return False

    default_provider = DEFAULT_SETTINGS["providers"][0]
    return (
        str(provider.get("id", "") or "").strip() == default_provider["id"]
        and str(provider.get("api_key", "") or "").strip() == ""
        and str(provider.get("base_url", "") or "").strip() == default_provider["base_url"]
        and str(provider.get("model_id", "") or "").strip() == default_provider["model_id"]
    )


def _normalize_loaded_workflow_step_models(raw: Any) -> dict:
    defaults = copy.deepcopy(DEFAULT_SETTINGS["workflow_step_models"])
    if not isinstance(raw, dict):
        return defaults

    for step_id in defaults:
        item = raw.get(step_id)
        if not isinstance(item, dict):
            continue
        defaults[step_id] = {
            "provider_id": str(item.get("provider_id", "")).strip(),
            "model_id": str(item.get("model_id", "")).strip(),
        }
    return defaults
