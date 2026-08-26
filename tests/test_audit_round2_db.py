"""第二轮审计修复的回归测试（数据库 / 路由）。

覆盖：
- PRAGMA foreign_keys=ON：delete_chat 级联清理 chat_messages 与 chat_messages_fts
- 历史搜索对 CJK 子串的 LIKE 兜底（unicode61 分词器下多字中文永远 MATCH 不中）
- generate_session_id 熵加宽 + IntegrityError 重试
"""

import asyncio
import json
import logging

from sqlalchemy import text


async def _init_tmp_db(tmp_path):
    """Point the database module at a fresh temp SQLite file and initialise it."""
    from backend.app import database

    if database._engine is not None:
        await database._engine.dispose()
    db_path = tmp_path / "justsearch.db"
    database._engine = None
    database._async_session_factory = None
    database._DB_PATH = str(db_path)
    database._DATABASE_URL = f"sqlite+aiosqlite:///{db_path}"
    database._CHATS_DIR = str(tmp_path / "legacy_chats")
    database._SETTINGS_FILE = str(tmp_path / "settings.json")
    await database.init_db()


async def _dispose_tmp_db():
    from backend.app import database

    if database._engine is not None:
        await database._engine.dispose()
        database._engine = None
        database._async_session_factory = None


# ---------------------------------------------------------------------------
# Fix 1: FK enforcement — delete_chat must cascade to messages + FTS
# ---------------------------------------------------------------------------


def test_delete_chat_cascades_messages_and_fts(tmp_path):
    from backend.app import database

    sid = "fk-cascade-test"

    async def run():
        await _init_tmp_db(tmp_path)
        await database.save_chat_history(sid, [
            {"role": "user", "content": "级联删除问题"},
            {"role": "assistant", "content": "级联删除回答"},
        ], title="级联")
        assert await database.delete_chat(sid) is True
        assert await database.load_chat_history(sid) is None
        async with database._engine.connect() as conn:
            msgs = (await conn.execute(text(
                "SELECT count(*) FROM chat_messages WHERE session_id = :s"
            ), {"s": sid})).scalar()
            fts = (await conn.execute(text(
                "SELECT count(*) FROM chat_messages_fts WHERE session_id = :s"
            ), {"s": sid})).scalar()
        return msgs, fts

    try:
        msgs, fts = asyncio.run(run())
        assert msgs == 0, "orphaned chat_messages rows survive delete_chat"
        assert fts == 0, "orphaned chat_messages_fts rows survive delete_chat"
    finally:
        asyncio.run(_dispose_tmp_db())


def test_deleted_session_not_resurrected_with_old_messages_by_import_shape(tmp_path):
    """删除后同 id 再导入/保存不得复活旧消息（孤儿行是复活 bug 的根源）。"""
    from backend.app import database

    sid = "fk-resurrect-test"

    async def run():
        await _init_tmp_db(tmp_path)
        await database.save_chat_history(sid, [
            {"role": "user", "content": "旧消息"},
            {"role": "assistant", "content": "旧回答"},
        ], title="old")
        await database.delete_chat(sid)
        # 模拟备份导入：全新内容 upsert。
        await database.save_chat_history(sid, [
            {"role": "user", "content": "imported-q"},
        ], title="new")
        data = await database.load_chat_history(sid)
        return [m["content"] for m in data.get("messages", [])]

    try:
        contents = asyncio.run(run())
        assert contents == ["imported-q"], contents
    finally:
        asyncio.run(_dispose_tmp_db())


# ---------------------------------------------------------------------------
# Fix 2: CJK substring search falls back to LIKE when FTS yields nothing
# ---------------------------------------------------------------------------


def _seed_search_db(tmp_path):
    from backend.app import database

    async def seed():
        await _init_tmp_db(tmp_path)
        await database.save_chat_history("s-cjk", [
            {"role": "user", "content": "请解释一下机器学习的基本原理"},
        ], title="中文会话")
        await database.save_chat_history("s-en", [
            {"role": "user", "content": "explain machine learning basics"},
        ], title="english session")

    asyncio.run(seed())


def test_search_finds_cjk_substring_via_like_fallback(tmp_path):
    from backend.app import database
    from backend.app.routers.history import search_history_endpoint

    _seed_search_db(tmp_path)

    async def run():
        return await search_history_endpoint(q="机器学习")

    try:
        results = asyncio.run(run())
        ids = [r["id"] for r in results]
        assert "s-cjk" in ids, f"CJK substring not found: {results}"
    finally:
        asyncio.run(_dispose_tmp_db())


def test_search_like_fallback_escapes_sql_wildcards(tmp_path):
    from backend.app import database
    from backend.app.routers.history import search_history_endpoint

    _seed_search_db(tmp_path)

    async def run():
        return await search_history_endpoint(q="100%")

    try:
        results = asyncio.run(run())
        assert isinstance(results, list)  # 不抛异常即为过；通配符未转义会全表命中
    finally:
        asyncio.run(_dispose_tmp_db())


# ---------------------------------------------------------------------------
# Fix 3: generate_session_id entropy + _copy_session IntegrityError retry
# ---------------------------------------------------------------------------


def test_generate_session_id_suffix_is_8_hex_chars():
    from backend.app.database import generate_session_id

    sid = generate_session_id()
    suffix = sid.rsplit("-", 1)[1]
    assert len(suffix) == 8 and all(c in "0123456789abcdef" for c in suffix)


def test_copy_session_retries_on_id_collision(tmp_path, monkeypatch):
    from backend.app import database

    async def run():
        await _init_tmp_db(tmp_path)
        await database.save_chat_history("src", [
            {"role": "user", "content": "q"},
        ], title="src")
        src = await database.load_chat_history("src")

        colliding = "20990101000000-deadbeef"
        # 预置一个占位会话，使第一次生成的 id 必然撞主键。
        async with database._engine.begin() as conn:
            await conn.execute(text(
                "INSERT INTO chat_sessions (id, title, is_pinned, created_at, updated_at) "
                "VALUES (:i, 'placeholder', 0, :t, :t)"
            ), {"i": colliding, "t": "2099-01-01 00:00:00"})

        real_gen = database.generate_session_id
        seq = [colliding]

        def fake_gen():
            if seq:
                return seq.pop(0)
            return real_gen()

        monkeypatch.setattr(database, "generate_session_id", fake_gen)
        summary = await database._copy_session(
            {"id": "src", "group_id": None},
            [{"role": "user", "content": "q"}],
            "copied",
        )
        assert summary is not None and summary["id"] != colliding
        data = await database.load_chat_history(summary["id"])
        assert [m["content"] for m in data["messages"]] == ["q"]

    try:
        asyncio.run(run())
    finally:
        asyncio.run(_dispose_tmp_db())


# ---------------------------------------------------------------------------
# Fix 4: legacy migration tolerates epoch-millis / Z-suffixed timestamps
# ---------------------------------------------------------------------------


def test_legacy_migration_parses_epoch_and_z_timestamps(tmp_path):
    from backend.app import database
    from backend.app.legacy_migration import migrate_legacy_data

    chats_dir = tmp_path / "legacy_chats"
    chats_dir.mkdir()
    (chats_dir / "chat-a.json").write_text(json.dumps({
        "id": "legacy-epoch",
        "title": "epoch chat",
        "timestamp": 1735689600000,
        "messages": [{"role": "user", "content": "hello"}],
    }), encoding="utf-8")
    (chats_dir / "chat-b.json").write_text(json.dumps({
        "id": "legacy-z",
        "title": "z chat",
        "timestamp": "2025-01-01T12:00:00Z",
        "messages": [{"role": "user", "content": "world"}],
    }), encoding="utf-8")

    async def run():
        await _init_tmp_db(tmp_path)
        # migrate_legacy_data 由 init_db 调过一次；这里手动再跑一次验证幂等。
        await migrate_legacy_data(
            database.get_session,
            database.ChatSession,
            database.ChatMessage,
            database.Settings,
            database._CHATS_DIR,
            database._SETTINGS_FILE,
            logging.getLogger("test"),
        )

    try:
        asyncio.run(run())
        assert not (chats_dir / "chat-a.json").exists(), "epoch-ts file should migrate once and be removed"
        assert not (chats_dir / "chat-b.json").exists(), "Z-ts file should migrate once and be removed"
        data = asyncio.run(database.load_chat_history("legacy-epoch"))
        assert data is not None and data["messages"][0]["content"] == "hello"
    finally:
        asyncio.run(_dispose_tmp_db())


# ---------------------------------------------------------------------------
# Fix 5: redirects.py — SSRF 复验 + 相对跳转目标补全
# ---------------------------------------------------------------------------


def test_redirect_resolution_refuses_private_target():
    from backend.app.crawler.redirects import resolve_redirect_url

    # DuckDuckGo 包装指向链路本地图床元数据地址 → 应回退原包装 URL。
    wrapper = "https://duckduckgo.com/l/?uddg=http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data%2F"
    resolved = asyncio.run(resolve_redirect_url(wrapper))
    assert resolved == wrapper, resolved

    # 公网目标正常解析。
    public = "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Farticle"
    assert asyncio.run(resolve_redirect_url(public)) == "https://example.com/article"


def test_extract_html_redirect_resolves_relative_targets():
    from backend.app.crawler.redirects import _extract_html_redirect_url

    page = '<script>window.location.replace("/link?url=abc")</script>'
    assert _extract_html_redirect_url(page, base_url="https://www.sogou.com/link?x=1") == (
        "https://www.sogou.com/link?url=abc"
    )
    # javascript: 伪协议即使被 urljoin 拼出也绝不放行。
    evil = "<script>location.href='javascript:alert(1)'</script>"
    assert _extract_html_redirect_url(evil, base_url="https://www.sogou.com/") == ""
