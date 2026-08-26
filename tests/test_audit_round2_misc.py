"""第二轮审计修复：prompts / logging / openai_client 生命周期回归测试。"""

import asyncio
import json
import logging
import re


# ---------------------------------------------------------------------------
# prompts: 引用验证示例必须是合法 JSON；死别名已删除
# ---------------------------------------------------------------------------


def test_citation_verification_prompt_exemplar_is_valid_json():
    from backend.app.prompts import CITATION_VERIFICATION_PROMPT

    rendered = CITATION_VERIFICATION_PROMPT.format(current_time="2025-01-01")
    match = re.search(r'\{"results".*$', rendered, re.M)
    assert match, "JSON exemplar line not found in rendered prompt"
    parsed = json.loads(match.group(0))
    assert isinstance(parsed["results"], list)
    sample = parsed["results"][0]
    assert set(sample) == {"id", "verdict", "confidence", "reason"}
    assert isinstance(sample["confidence"], float)


def test_live_artifacts_prompt_dead_alias_removed():
    import backend.app.prompts as prompts

    assert not hasattr(prompts, "LIVE_ARTIFACTS_PROMPT"), (
        "裸名别名会诱导误用 ZH-only 协议；应只使用 _ZH/_EN + select_live_artifacts_protocol"
    )
    assert hasattr(prompts, "LIVE_ARTIFACTS_PROMPT_ZH")
    assert hasattr(prompts, "LIVE_ARTIFACTS_PROMPT_EN")


def test_every_formatted_prompt_still_formats():
    from backend.app import prompts

    for name in ("CITATION_VERIFICATION_PROMPT",):
        rendered = getattr(prompts, name).format(current_time="2025-01-01")
        assert "current_time" in rendered or "{" in rendered


# ---------------------------------------------------------------------------
# logging: 控制字符折叠防日志伪造
# ---------------------------------------------------------------------------


def test_request_id_filter_collapses_control_characters():
    from backend.app.logging_utils import RequestIdFilter, set_request_id

    set_request_id("req-42")
    record = logging.LogRecord(
        name="app", level=logging.INFO, pathname=__file__, lineno=1,
        msg="query: %s", args=("hello\n2026-01-01 [ERROR] [fake] app: db corrupted",),
        exc_info=None,
    )
    filt = RequestIdFilter()
    assert filt.filter(record) is True
    message = record.getMessage()
    assert "\n" not in message
    assert "fake" in message  # 内容保留，仅换行被折叠
    assert record.request_id == "req-42"


def test_request_id_filter_leaves_clean_messages_untouched():
    from backend.app.logging_utils import RequestIdFilter, set_request_id

    set_request_id("req-7")
    original_msg = "plain message"
    record = logging.LogRecord(
        name="app", level=logging.INFO, pathname=__file__, lineno=1,
        msg=original_msg, args=None, exc_info=None,
    )
    RequestIdFilter().filter(record)
    assert record.msg == original_msg and record.args is None


# ---------------------------------------------------------------------------
# openai_client: 生命周期助手保证关闭（含异常路径）
# ---------------------------------------------------------------------------


class _FakeClient:
    def __init__(self):
        self.close_calls = 0

    def close(self):
        self.close_calls += 1


def test_openai_client_lifespan_closes_on_success_and_error(monkeypatch):
    from backend.app import openai_client as oc

    created = []

    def fake_create(**kwargs):
        client = _FakeClient()
        created.append(client)
        return client

    monkeypatch.setattr(oc, "create_openai_client", fake_create)

    async def run():
        async with oc.openai_client_lifespan(api_key="k", base_url="http://x") as c:
            assert c.close_calls == 0
        assert created[0].close_calls == 1

        with pytest_raises():
            async with oc.openai_client_lifespan(api_key="k", base_url="http://x"):
                raise RuntimeError("boom")

    def pytest_raises():
        import contextlib

        return contextlib.suppress(RuntimeError)

    asyncio.run(run())
    assert all(c.close_calls == 1 for c in created), "client pool leaked"


def test_validate_key_endpoint_generic_error_and_closed_client(monkeypatch):
    """settings validate-key：未映射异常必须泛化，且客户端连接池必须关闭。"""
    from backend.app.routers import settings as settings_router

    class FakeSDKClient:
        def __init__(self):
            self.closed = False

        def close(self):
            self.closed = True

        @property
        def chat(self):  # 触发调用的属性；直接抛错即可
            raise RuntimeError("resolver failure [Errno -2] internal /home/user path")

    fake = FakeSDKClient()

    def fake_create(**kwargs):
        return fake

    monkeypatch.setattr(settings_router, "create_openai_client", fake_create)

    async def run():
        # chat.completions.create 访问即抛 RuntimeError → 落入未映射分支。
        return await settings_router.validate_api_key_endpoint({
            "api_key": "sk-test",
            "base_url": "https://api.example.com/v1",
            "model_id": "gpt-test",
        })

    result = asyncio.run(run())
    assert result["valid"] is False
    assert "resolver" not in result["error"]
    assert "/home/user" not in result["error"]
    assert fake.closed is True, "validate-key 泄漏 httpx 连接池"
