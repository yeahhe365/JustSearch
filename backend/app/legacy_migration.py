import glob
import json
import os
import shutil
from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import Any

from sqlalchemy import delete, select


def _legacy_chat_session_id(data: dict, fpath: str) -> str | None:
    # Imported lazily: database.py imports this module at top level, so a
    # top-level import here would create a circular import.
    from .database import normalize_route_safe_id

    data_id = normalize_route_safe_id(data.get("id"))
    if data_id:
        return data_id
    return normalize_route_safe_id(os.path.splitext(os.path.basename(fpath))[0])


async def migrate_legacy_data(
    get_session: Callable[[], Awaitable[Any]],
    ChatSession,
    ChatMessage,
    Settings,
    chats_dir: str,
    settings_file: str,
    logger,
):
    """Import legacy JSON chats/settings into SQLite, then remove old files."""
    await _migrate_chats_dir(get_session, ChatSession, ChatMessage, chats_dir, logger)
    await _migrate_settings_file(get_session, Settings, settings_file, logger)


async def _migrate_chats_dir(
    get_session: Callable[[], Awaitable[Any]],
    ChatSession,
    ChatMessage,
    chats_dir: str,
    logger,
):
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
                title = data.get("title", "新对话")
                timestamp_str = data.get("timestamp")
                ts = datetime.fromisoformat(timestamp_str) if timestamp_str else datetime.now()

                existing = (
                    await session.execute(
                        select(ChatSession).where(ChatSession.id == session_id)
                    )
                ).scalar_one_or_none()
                if existing is None:
                    session.add(
                        ChatSession(
                            id=session_id,
                            title=title,
                            created_at=ts,
                            updated_at=ts,
                        )
                    )

                await session.execute(
                    delete(ChatMessage).where(ChatMessage.session_id == session_id)
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
            except Exception as e:
                logger.error("Failed to migrate %s: %s", fpath, e)

        await session.commit()

    try:
        shutil.rmtree(chats_dir, ignore_errors=True)
        logger.info("Removed legacy chats/ directory")
    except Exception as e:
        logger.warning("Could not remove chats/ directory: %s", e)


async def _migrate_settings_file(
    get_session: Callable[[], Awaitable[Any]],
    Settings,
    settings_file: str,
    logger,
):
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
                if existing:
                    existing.value = str_value
                else:
                    session.add(Settings(key=key, value=str_value))

            await session.commit()

        os.remove(settings_file)
        logger.info("Migrated settings.json and removed file")
    except Exception as e:
        logger.error("Failed to migrate settings.json: %s", e)
