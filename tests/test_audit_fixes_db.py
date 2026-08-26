"""Regression tests for the confirmed audit fixes (migration / auth / database / routers).

Covers:
- legacy_migration idempotent re-import (never overwrites newer DB rows)
- auth Host-header gating (DNS-rebinding hardening, Docker gateway kept working)
- per-session asyncio.Lock around save_chat_history read→append
- rename of empty sessions (update_chat_session_title)
- delete_message "missing" vs "mismatch" tri-state
"""

import asyncio
import json
import logging

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text


logger = logging.getLogger(__name__)


_ORIG_DB_STATE: dict = {}


async def _init_tmp_db(tmp_path):
    """Point the database module at a fresh temp SQLite file and initialise it."""
    from backend.app import database

    # 首次进入时快照模块全局，_dispose_tmp_db 恢复——否则 tmp 路径泄漏给
    # 同进程后续测试（顺序依赖地雷）。
    if not _ORIG_DB_STATE:
        _ORIG_DB_STATE.update({
            "engine": database._engine,
            "factory": database._async_session_factory,
            "DB_PATH": database._DB_PATH,
            "DATABASE_URL": database._DATABASE_URL,
            "CHATS_DIR": database._CHATS_DIR,
            "SETTINGS_FILE": database._SETTINGS_FILE,
        })

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
    if not _ORIG_DB_STATE:
        return
    database._engine = _ORIG_DB_STATE["engine"]
    database._async_session_factory = _ORIG_DB_STATE["factory"]
    database._DB_PATH = _ORIG_DB_STATE["DB_PATH"]
    database._DATABASE_URL = _ORIG_DB_STATE["DATABASE_URL"]
    database._CHATS_DIR = _ORIG_DB_STATE["CHATS_DIR"]
    database._SETTINGS_FILE = _ORIG_DB_STATE["SETTINGS_FILE"]


# ---------------------------------------------------------------------------
# Fix 1: legacy migration must be idempotent
# ---------------------------------------------------------------------------


def test_legacy_chat_migration_is_idempotent_and_skips_existing_sessions(tmp_path):
    """Corrupt file must not abort the rest; re-running must never clobber newer rows."""
    from backend.app import database
    from backend.app.legacy_migration import migrate_legacy_data

    async def run():
        await _init_tmp_db(tmp_path)

        legacy_dir = tmp_path / "legacy_chats"
        legacy_dir.mkdir()
        good_payload = {
            "id": "mig-session-1",
            "title": "Migrated One",
            "timestamp": "2024-01-01T10:00:00",
            "messages": [{"role": "user", "content": "legacy msg"}],
        }
        good_file = legacy_dir / "mig-session-1.json"
        good_file.write_text(json.dumps(good_payload, ensure_ascii=False), encoding="utf-8")
        corrupt_file = legacy_dir / "corrupt.json"
        corrupt_file.write_text("{not valid json", encoding="utf-8")

        await migrate_legacy_data(
            database.get_session,
            database.ChatSession,
            database.ChatMessage,
            database.Settings,
            str(legacy_dir),
            str(tmp_path / "settings.json"),
            logger,
        )

        # First file imported despite the corrupt sibling…
        history = await database.load_chat_history("mig-session-1")
        assert history is not None
        assert [m["content"] for m in history["messages"]] == ["legacy msg"]
        # …and the successfully imported source file was removed, corrupt one kept.
        assert not good_file.exists()
        assert corrupt_file.exists()

        # Newer message arrives in the DB AFTER the migration.
        async with await database.get_session() as session:
            session.add(
                database.ChatMessage(
                    session_id="mig-session-1",
                    role="assistant",
                    content="newer db msg",
                )
            )
            await session.commit()

        # Snapshot reappears (e.g. restore from backup) and migration runs again.
        good_file.write_text(json.dumps(good_payload, ensure_ascii=False), encoding="utf-8")
        await migrate_legacy_data(
            database.get_session,
            database.ChatSession,
            database.ChatMessage,
            database.Settings,
            str(legacy_dir),
            str(tmp_path / "settings.json"),
            logger,
        )

        history_again = await database.load_chat_history("mig-session-1")
        contents = [m["content"] for m in history_again["messages"]]
        assert contents == ["legacy msg", "newer db msg"], (
            "re-run must skip existing sessions entirely: no duplicates, no stale overwrite"
        )
        assert not good_file.exists(), "file whose session already exists counts as migrated"

        await _dispose_tmp_db()

    asyncio.run(run())


def test_legacy_settings_migration_never_overwrites_existing_keys(tmp_path):
    """Existing DB settings win; only missing keys are filled from the JSON file."""
    from backend.app import database
    from backend.app.legacy_migration import migrate_legacy_data

    async def run():
        await _init_tmp_db(tmp_path)
        await database.save_settings({"theme": "dark"})

        settings_file = tmp_path / "settings.json"
        settings_file.write_text(
            json.dumps({"theme": "light", "max_results": 42}, ensure_ascii=False),
            encoding="utf-8",
        )

        await migrate_legacy_data(
            database.get_session,
            database.ChatSession,
            database.ChatMessage,
            database.Settings,
            str(tmp_path / "legacy_chats"),
            str(settings_file),
            logger,
        )

        loaded = await database.load_settings()
        assert loaded["theme"] == "dark", "existing DB value must never be overwritten"
        assert loaded["max_results"] == 42, "missing key must be filled from the JSON file"
        assert not settings_file.exists(), "settings file removed after successful commit"

        await _dispose_tmp_db()

    asyncio.run(run())


# ---------------------------------------------------------------------------
# Fix 2: Host-header gate for token-free local access + bootstrap injection
# ---------------------------------------------------------------------------


def _build_auth_app():
    from backend.app.auth import AccessControlMiddleware

    app = FastAPI()
    app.add_middleware(AccessControlMiddleware, token_provider=lambda: "secret-token")

    @app.get("/api/ping")
    async def ping():
        return JSONResponse({"ok": True})

    return app


def test_access_control_blocks_trusted_ip_when_host_is_not_loopback():
    """Trusted gateway IP + non-loopback Host (DNS rebinding) ⇒ token required."""
    async def run():
        transport = httpx.ASGITransport(
            app=_build_auth_app(), client=("172.17.0.1", 4321)
        )
        async with httpx.AsyncClient(transport=transport, base_url="http://evil.com") as client:
            response = await client.get("/api/ping")

        assert response.status_code == 401

    asyncio.run(run())


def test_access_control_allows_docker_gateway_with_localhost_host(monkeypatch):
    """网关规则只在容器内生效：容器内放行，裸机要求 token。"""
    from backend.app import auth as auth_module

    async def run(in_container: bool):
        monkeypatch.setattr(auth_module, "_running_in_container", lambda: in_container)
        transport = httpx.ASGITransport(
            app=_build_auth_app(), client=("172.17.0.1", 4321)
        )
        async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as client:
            response = await client.get("/api/ping")
        return response.status_code

    assert asyncio.run(run(True)) == 200
    assert asyncio.run(run(False)) == 401


def test_access_control_allows_loopback_client_with_loopback_host():
    async def run():
        transport = httpx.ASGITransport(
            app=_build_auth_app(), client=("127.0.0.1", 4321)
        )
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8000") as client:
            response = await client.get("/api/ping")

        assert response.status_code == 200
        assert response.json() == {"ok": True}

    asyncio.run(run())


def test_bootstrap_token_gated_by_loopback_request_host(monkeypatch):
    """Real token is injected into the served HTML only when the Host is loopback too."""
    from backend.app import auth

    monkeypatch.setenv("JUSTSEARCH_AUTH_ENABLED", "true")
    monkeypatch.setattr(auth, "get_auth_token", lambda: "secret-token")
    # bootstrap 的网关放行分支同样受容器门禁：测试以容器内视角运行。
    monkeypatch.setattr(auth, "_running_in_container", lambda: True)

    app = FastAPI()

    @app.get("/")
    async def index(request: Request):
        return JSONResponse(auth.build_html_bootstrap_payload(request))

    cases = [
        # (client ip, base_url(⇒Host), expect real token)
        ("172.17.0.1", "http://evil.com", False),
        ("172.17.0.1", "http://localhost", True),
        ("127.0.0.1", "http://127.0.0.1:8000", True),
    ]

    async def run():
        for client_ip, base_url, expect_token in cases:
            transport = httpx.ASGITransport(app=app, client=(client_ip, 4321))
            async with httpx.AsyncClient(transport=transport, base_url=base_url) as client:
                response = await client.get("/")
            payload = response.json()
            assert response.status_code == 200
            if expect_token:
                assert payload.get("authToken") == "secret-token", (
                    f"{client_ip} + Host {base_url} should receive the real token"
                )
                assert payload["clientIsLoopback"] is True
            else:
                assert "authToken" not in payload, (
                    f"{client_ip} + Host {base_url} must NOT receive the real token"
                )
                assert payload["clientIsLoopback"] is False

    asyncio.run(run())


def test_is_loopback_host_value_strict_without_gateway_rule():
    from backend.app.auth import _is_loopback_host_value

    assert _is_loopback_host_value("localhost") is True
    assert _is_loopback_host_value("127.0.0.1") is True
    assert _is_loopback_host_value("::1") is True
    assert _is_loopback_host_value("::ffff:127.0.0.1") is True
    # Docker bridge gateway is trusted as a CLIENT IP, but a Host header of a
    # bridge address is still not a loopback page host.
    assert _is_loopback_host_value("172.17.0.1") is False
    assert _is_loopback_host_value("evil.com") is False
    assert _is_loopback_host_value(None) is False


# ---------------------------------------------------------------------------
# Fix 3: per-session asyncio.Lock serialises concurrent appends
# ---------------------------------------------------------------------------


def test_save_chat_history_serializes_concurrent_writers_per_session(tmp_path):
    from backend.app import database

    async def run():
        await _init_tmp_db(tmp_path)

        sid = "lock-race-session"
        seed = {"role": "user", "content": "prefix"}
        await database.save_chat_history(sid, [seed], title="Race")

        # Mutual exclusion: while the per-session lock is held externally, a new
        # writer must wait instead of racing ahead.
        lock = database._get_session_lock(sid)
        turn_a = [
            seed,
            {"role": "assistant", "content": "turn-a"},
        ]
        async with lock:
            waiting_task = asyncio.create_task(database.save_chat_history(sid, turn_a))
            await asyncio.sleep(0.05)
            assert not waiting_task.done(), "writer must wait on the per-session lock"
        await waiting_task

        # Real concurrency: two identical appends launched together must produce
        # exactly ONE extra turn — no double append from a stale count read.
        turn_c_messages = [
            seed,
            {"role": "assistant", "content": "turn-a"},
            {"role": "assistant", "content": "turn-c"},
        ]
        await asyncio.gather(
            database.save_chat_history(sid, list(turn_c_messages)),
            database.save_chat_history(sid, list(turn_c_messages)),
        )

        history = await database.load_chat_history(sid)
        contents = [m["content"] for m in history["messages"]]
        assert contents == ["prefix", "turn-a", "turn-c"], contents

        await _dispose_tmp_db()

    asyncio.run(run())


# ---------------------------------------------------------------------------
# Fix 4: renaming an empty session must actually persist
# ---------------------------------------------------------------------------


def test_rename_empty_session_updates_title_in_db(tmp_path):
    from backend.app import database
    from backend.app.routers.history import router

    async def run():
        await _init_tmp_db(tmp_path)

        async with await database.get_session() as session:
            session.add(database.ChatSession(id="empty-rename", title="新对话"))
            await session.commit()

        app = FastAPI()
        app.include_router(router)

        transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 1234))
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            renamed = await client.patch(
                "/api/history/empty-rename", json={"title": "Renamed Empty"}
            )
            missing = await client.patch(
                "/api/history/no-such-chat", json={"title": "Ghost"}
            )

        assert renamed.status_code == 200
        assert renamed.json() == {"status": "ok", "title": "Renamed Empty"}
        assert missing.status_code == 404

        stored_title = (
            await database.load_chat_history("empty-rename")
        )["title"]
        assert stored_title == "Renamed Empty", "rename of an empty session must persist"

        await _dispose_tmp_db()

    asyncio.run(run())


# ---------------------------------------------------------------------------
# Fix 5: delete_message distinguishes missing vs content mismatch
# ---------------------------------------------------------------------------


def test_delete_message_reports_missing_and_mismatch_separately(tmp_path):
    from backend.app import database
    from backend.app.routers.chat import router

    async def run():
        await _init_tmp_db(tmp_path)

        sid = "delete-tri-state"
        await database.save_chat_history(
            sid,
            [
                {"role": "user", "content": "first"},
                {"role": "assistant", "content": "second"},
            ],
            title="Tri State",
        )

        assert await database.delete_message("ghost-session", 0) == "missing"
        assert await database.delete_message(sid, 99) == "missing"
        assert await database.delete_message(sid, 0, expected_content="drifted") == "mismatch"

        app = FastAPI()
        app.include_router(router)

        transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 1234))
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            mismatch = await client.request(
                "DELETE",
                "/api/chat/message",
                json={"session_id": sid, "message_index": 0, "expected_content": "drifted"},
            )
            gone = await client.request(
                "DELETE",
                "/api/chat/message",
                json={"session_id": "ghost-session", "message_index": 0},
            )

        assert mismatch.status_code == 409
        assert mismatch.json()["detail"]
        assert gone.status_code == 404
        assert gone.json()["detail"] == "Message not found"

        # The genuine delete keeps returning True and works.
        assert await database.delete_message(sid, 0, expected_content="first") is True

        await _dispose_tmp_db()

    asyncio.run(run())


def test_generate_session_id_returns_plain_string_not_coroutine():
    """回归：generate_session_id 必须同步返回 str（曾因包装 async 函数
    返回协程对象，导致新建会话拿到 coroutine 当 id）。"""
    import inspect
    import re

    from backend.app import database

    sid = database.generate_session_id()
    assert isinstance(sid, str)
    assert not inspect.isawaitable(sid)
    assert re.fullmatch(r"\d{14}-[0-9a-f]{8}", sid), sid


def test_new_session_id_alias_still_awaitable_and_consistent():
    import asyncio
    import re

    from backend.app import database

    async def run():
        return await database._new_session_id()

    sid = asyncio.run(run())
    assert isinstance(sid, str)
    assert re.fullmatch(r"\d{14}-[0-9a-f]{8}", sid), sid
