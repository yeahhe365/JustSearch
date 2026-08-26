"""One-time import of legacy JSON chats/settings into SQLite.

幂等设计（idempotent）：
- 每个会话 JSON 只在其对应的 ChatSession 尚不存在时导入；会话已存在则整体
  跳过（绝不触碰其中的消息），避免每次重启都用旧快照覆盖数据库中更新的消息。
- 源文件在“该文件自身”导入成功后立即删除；删除失败仅记录日志——由于跳过已存在
  会话，重复执行完全无害，因此不再有目录级的“全部成功才 rmtree”逻辑。
- settings.json 同理：只插入数据库中尚不存在的键，绝不覆盖已有值。
"""

import glob
import json
import os
from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import Any

from sqlalchemy import select


def _legacy_chat_session_id(data: dict, fpath: str) -> str | None:
    # Imported lazily: database.py imports this module at top level, so a
    # top-level import here would create a circular import.
    from .database import normalize_route_safe_id

    data_id = normalize_route_safe_id(data.get("id"))
    if data_id:
        return data_id
    return normalize_route_safe_id(os.path.splitext(os.path.basename(fpath))[0])


def _remove_migrated_source_file(fpath: str, logger) -> None:
    """Delete a source file whose import succeeded; a failed removal is harmless."""
    try:
        os.remove(fpath)
    except OSError as e:
        logger.warning("Could not remove migrated legacy file %s: %s", fpath, e)


async def migrate_legacy_data(
    get_session: Callable[[], Awaitable[Any]],
    ChatSession,
    ChatMessage,
    Settings,
    chats_dir: str,
    settings_file: str,
    logger,
):
    """Import legacy JSON chats/settings into SQLite, then remove each source file.

    Idempotent: sessions/settings already present in the DB are skipped, so
    re-running this (even with leftover source files) never overwrites newer
    database content.
    """
    await _migrate_chats_dir(get_session, ChatSession, ChatMessage, chats_dir, logger)
    await _migrate_settings_file(get_session, Settings, settings_file, logger)


async def _migrate_chats_dir(
    get_session: Callable[[], Awaitable[Any]],
    ChatSession,
    ChatMessage,
    chats_dir: str,
    logger,
):
    # 延迟导入避免与 database.py 的顶层循环依赖。
    from .database import _parse_imported_timestamp, _utc_now

    if not os.path.isdir(chats_dir):
        return

    json_files = glob.glob(os.path.join(chats_dir, "*.json"))
    if not json_files:
        return

    logger.info("Migrating %d chat JSON files from %s ...", len(json_files), chats_dir)

    async with await get_session() as session:
        for fpath in json_files:
            try:
                with open(fpath, "r", encoding="utf-8") as f:
                    data = json.load(f)

                session_id = _legacy_chat_session_id(data, fpath)
                if not session_id:
                    logger.warning("Skipping legacy chat with route-unsafe id: %s", fpath)
                    continue

                # 幂等关键点：会话已存在 → 整个文件视为已迁移，跳过导入，
                # 绝不删除/重写该会话的任何消息（否则旧快照会覆盖新数据）。
                existing = (
                    await session.execute(
                        select(ChatSession).where(ChatSession.id == session_id)
                    )
                ).scalar_one_or_none()
                if existing is not None:
                    logger.info("Legacy chat %s already imported; skipping file %s", session_id, fpath)
                    _remove_migrated_source_file(fpath, logger)
                    continue

                title = data.get("title", "新对话")
                timestamp_str = data.get("timestamp")
                # 统一走 database 的时间戳解析（ISO/Z/毫秒 epoch → naive UTC）。
                # 此前的裸 fromisoformat 遇到毫秒时间戳会抛 TypeError，文件被
                # 留在磁盘上每次启动重试且永远失败；带时区的时间戳也会被
                # SQLite binder 丢掉偏移，破坏 naive-UTC 约定。
                ts = _parse_imported_timestamp(timestamp_str, fallback=_utc_now())

                # 仅全新会话才插入 session + messages。
                session.add(
                    ChatSession(
                        id=session_id,
                        title=title,
                        created_at=ts,
                        updated_at=ts,
                    )
                )

                for msg in data.get("messages", []):
                    session.add(
                        ChatMessage(
                            session_id=session_id,
                            role=msg.get("role", "user"),
                            content=msg.get("content", ""),
                            logs=msg.get("logs") if isinstance(msg.get("logs"), list) else [],
                            sources=(
                                msg.get("sources")
                                if isinstance(msg.get("sources"), list)
                                else []
                            ),
                            stats=(
                                msg.get("stats")
                                if isinstance(msg.get("stats"), dict)
                                else {}
                            ),
                        )
                    )
                await session.commit()
                # 该文件自身已成功入库：立即删除源文件（失败无害）。
                _remove_migrated_source_file(fpath, logger)
            except Exception as e:
                logger.error("Failed to migrate %s: %s", fpath, e)
                await session.rollback()
                # 失败文件保留在磁盘上，下次启动重试；已成功的文件不受影响。

    # 注：不再有目录级 rmtree —— 每个文件在自身导入成功后已被单独删除。


async def _migrate_settings_file(
    get_session: Callable[[], Awaitable[Any]],
    Settings,
    settings_file: str,
    logger,
):
    """Import legacy settings.json without ever overwriting existing DB values."""
    if not os.path.isfile(settings_file):
        return

    logger.info("Migrating settings.json ...")
    try:
        with open(settings_file, "r", encoding="utf-8") as f:
            data = json.load(f)

        async with await get_session() as session:
            for key, value in data.items():
                if isinstance(value, (dict, list, bool)):
                    str_value = json.dumps(value, ensure_ascii=False)
                else:
                    str_value = str(value) if value is not None else ""

                existing = (
                    await session.execute(select(Settings).where(Settings.key == key))
                ).scalar_one_or_none()
                # 幂等关键点：键已存在 → 保持数据库中的值（可能比旧 JSON 更新），
                # 只补齐缺失的键。
                if existing is None:
                    session.add(Settings(key=key, value=str_value))

            await session.commit()

        try:
            os.remove(settings_file)
        except OSError as e:
            logger.warning("Could not remove migrated settings.json %s: %s", settings_file, e)
        else:
            logger.info("Migrated settings.json and removed file")
    except Exception as e:
        logger.error("Failed to migrate settings.json: %s", e)
