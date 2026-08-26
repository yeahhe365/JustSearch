"""回归测试：审计修复（llm_client / workflow）。

覆盖：
- [FIX 1] _markdown_to_live_artifact_html 的 <pre><code> 拼接必须是完整 f-string，
  否则代码内容渲染成字面 "{code_text}"。
- [FIX 2] stats_callback 在"达到最大迭代次数的部分答案"路径上也必须携带
  sites_crawled（前端 chat.js 读取 searchStats.sites_crawled）。
- [FIX 3] _LIVE_ARTIFACT_CONTAINER_RE 与 OPEN_RE 一致使用反引用，拒绝
  <div>...</span> 这类开闭标签不配对的片段。
- [FIX 4] _normalize_url 只小写 scheme/netloc，保留 path/query 大小写。
- [FIX 5] 短操作（decide_click_elements 等）对瞬时网络错误有一次重试。
- [FIX 6] LLMClient.aclose / SearchWorkflow.aclose 关闭底层连接池；run() 结束时调用。
- [FIX 14] purge_analysis_cache 清理过期分析缓存并返回清除数量（跨代理契约）。
"""

import asyncio
import inspect
import time

import backend.app.llm_client as llm_client
from backend.app.llm_client import LLMClient, _markdown_to_live_artifact_html
from backend.app.providers import WORKFLOW_MODEL_STEP_IDS
from backend.app.workflow import SearchWorkflow


def _make_workflow(**kwargs):
    """离线构造 SearchWorkflow（不触网，浏览器/LLM 由调用方替换）。"""
    return SearchWorkflow(
        api_key="test",
        base_url="https://example.test/v1",
        model="test-model",
        search_engine="google",
        max_results=3,
        **kwargs,
    )


class FakeLLM:
    """可编程的最小 LLM 替身：记录 aclose 调用。"""

    def __init__(self, analysis=None, relevant_ids=None, answer=None):
        self._analysis = analysis or {
            "type": "search",
            "queries": ["query one"],
            "resolved_query": "query one",
        }
        self._relevant_ids = relevant_ids if relevant_ids is not None else [1]
        self._answer = answer or {"status": "insufficient", "answer": "partial answer text", "missing_info": "more"}
        self.aclose_calls = 0

    async def analyze_task(self, _user_input, _history=None):
        return dict(self._analysis)

    async def assess_relevance(self, _query, _snippets):
        return list(self._relevant_ids)

    async def generate_answer(self, *_args, **_kwargs):
        return dict(self._answer)

    async def aclose(self):
        self.aclose_calls += 1


class FakeBrowser:
    engine = "google"
    engine_config = {"google": {}}

    async def search_web(self, *_args, **_kwargs):
        return [
            {
                "id": 1,
                "title": "Example result",
                "url": "https://example.com/a",
                "snippet": "snippet text",
            }
        ]

    async def crawl_page(self, *_args, **_kwargs):
        # >= 500 字符，避免触发自适应增加迭代次数的旁路。
        return "x" * 600


# --- [FIX 1] code block rendering -------------------------------------------------

def test_fenced_code_block_renders_code_content():
    html = _markdown_to_live_artifact_html("```python\nprint('hello')\n```")
    assert "print" in html
    assert "{code_text}" not in html


def test_indented_code_block_renders_code_content():
    html = _markdown_to_live_artifact_html("\n    x = 1\n")
    assert "x = 1" in html
    assert "{code_text}" not in html


# --- [FIX 3] container regex backreference ----------------------------------------

def test_inline_artifact_detection_rejects_mismatched_tag_pair():
    assert llm_client._looks_like_inline_live_artifact("<div><p>x</p></div>")
    # 开闭标签不配对必须被拒绝（与注释描述一致）。
    assert not llm_client._looks_like_inline_live_artifact("<div>...</span>")


# --- [FIX 4] _normalize_url preserves path case ------------------------------------

def test_normalize_url_lowercases_only_scheme_and_netloc():
    workflow = _make_workflow()
    canonical = workflow._normalize_url("https://example.com/PageA")
    # scheme / host 变体仍然折叠到同一键
    assert workflow._normalize_url("https://Example.com/PageA") == canonical
    assert workflow._normalize_url("HTTPS://EXAMPLE.com/PageA") == canonical
    # 路径大小写不同 → 不同页面，不得合并
    assert workflow._normalize_url("https://example.com/pagea") != canonical
    # query 大小写同样保留
    assert workflow._normalize_url("https://example.com/path?Keep=X") == \
        workflow._normalize_url("https://EXAMPLE.com/path?Keep=X")


# --- [FIX 2] stats payload on the max-iterations partial-answer path ---------------

def test_stats_payload_includes_sites_crawled_on_max_iterations_partial():
    workflow = _make_workflow(max_iterations=1)
    fake_llm = FakeLLM()
    workflow.llm = fake_llm
    workflow.step_llms = {}
    workflow.browser = FakeBrowser()

    progress = []
    stats = []

    result = asyncio.run(
        workflow.run(
            "some question",
            progress.append,
            history=[],
            stats_callback=stats.append,
        )
    )

    assert len(stats) == 1
    payload = stats[0]
    expected_keys = {
        "sites_searched",
        "sites_crawled",
        "iterations",
        "total_seconds",
        "prompt_tokens",
        "completion_tokens",
    }
    assert set(payload.keys()) == expected_keys
    assert payload["sites_crawled"] == 1
    assert payload["sites_searched"] == 1
    assert payload["iterations"] == 1
    # 行为保持：仍走循环内的部分答案返回路径
    assert "partial answer text" in result
    assert "⚠️" in result


def test_run_returns_fallback_message_when_no_sources_ever_found():
    class EmptyBrowser(FakeBrowser):
        async def search_web(self, *_args, **_kwargs):
            return []

    workflow = _make_workflow(max_iterations=1)
    workflow.llm = FakeLLM()
    workflow.step_llms = {}
    workflow.browser = EmptyBrowser()

    result = asyncio.run(workflow.run("some question", lambda _m: None, history=[]))

    assert "多次尝试后未能生成有效答案" in result


# --- [FIX 5] one retry for transient errors on short operations --------------------

class _FakeCompletions:
    def __init__(self, fn):
        self._fn = fn

    async def create(self, **kwargs):
        return await self._fn(**kwargs)


class _FakeChat:
    def __init__(self, completions):
        self.completions = completions


class _FakeInnerClient:
    def __init__(self, fn):
        self.chat = _FakeChat(_FakeCompletions(fn))


class _FakeResponse:
    content = '{"clicked_ids": ["js-interact-0"]}'


def test_decide_click_elements_retries_transient_network_error(monkeypatch):
    async def fast_sleep(*_args, **_kwargs):
        return None

    monkeypatch.setattr(llm_client.asyncio, "sleep", fast_sleep)

    attempts = {"count": 0}

    async def fake_create(**_kwargs):
        attempts["count"] += 1
        if attempts["count"] == 1:
            raise ConnectionError("connection reset by peer")
        return _FakeResponse()

    client = LLMClient("test-key", "https://example.test/v1", "test-model")
    client.client = _FakeInnerClient(fake_create)

    clicked = asyncio.run(
        client.decide_click_elements(
            "query",
            [{"id": "js-interact-0", "tag": "button", "text": "Next"}],
        )
    )

    assert clicked == ["js-interact-0"]
    # 瞬时失败后重试过一次
    assert attempts["count"] == 2


# --- [FIX 6] aclose() resource cleanup ----------------------------------------------

def test_llm_client_aclose_closes_underlying_client():
    client = LLMClient("test-key", "https://example.test/v1", "test-model")
    closed = []

    class FakeInner:
        async def close(self):
            closed.append(True)

    client.client = FakeInner()
    asyncio.run(client.aclose())
    assert closed == [True]


def test_llm_client_aclose_tolerates_missing_close_method():
    client = LLMClient("test-key", "https://example.test/v1", "test-model")
    client.client = object()  # 无 close 方法
    asyncio.run(client.aclose())  # 不应抛异常


def test_search_workflow_aclose_closes_shared_step_clients_once():
    workflow = _make_workflow()
    closes = []

    class FakeStepClient:
        async def aclose(self):
            closes.append(1)

    shared = FakeStepClient()
    workflow.llm = shared
    workflow.step_llms = {step_id: shared for step_id in WORKFLOW_MODEL_STEP_IDS}

    asyncio.run(workflow.aclose())

    # step_llms 共享同一客户端实例，只应关闭一次
    assert sum(closes) == 1


def test_run_leaves_llm_clients_open_for_post_run_citation_verification():
    """run() 不得自关步骤客户端：chat 路由在 task.result() 之后还要用
    answer 步骤的 LLM 做引用语义验证（复用已关闭连接池会 APIConnectionError）。
    关闭责任归所有者（SSE 生成器退出时显式 aclose）。"""
    workflow = _make_workflow(max_iterations=1)
    fake_llm = FakeLLM()
    workflow.llm = fake_llm
    workflow.step_llms = {}
    workflow.browser = FakeBrowser()

    asyncio.run(workflow.run("some question", lambda _m: None, history=[]))

    assert fake_llm.aclose_calls == 0

    # 所有者显式关闭后计数才前进。
    asyncio.run(workflow.aclose())
    assert fake_llm.aclose_calls == 1


# --- [FIX 14] purge_analysis_cache cross-agent contract ------------------------------

def test_purge_analysis_cache_signature_contract():
    params = inspect.signature(llm_client.purge_analysis_cache).parameters
    assert "max_age_seconds" in params
    assert params["max_age_seconds"].default == 3600.0


def test_purge_analysis_cache_removes_only_expired_entries():
    try:
        llm_client._ANALYSIS_CACHE.clear()
        now = time.time()
        llm_client._ANALYSIS_CACHE["old"] = ({"r": 1}, now - 7200.0)
        llm_client._ANALYSIS_CACHE["fresh"] = ([1, 2], now - 30.0)

        removed = llm_client.purge_analysis_cache(max_age_seconds=3600.0)

        assert removed == 1
        assert "old" not in llm_client._ANALYSIS_CACHE
        assert "fresh" in llm_client._ANALYSIS_CACHE
    finally:
        llm_client._ANALYSIS_CACHE.clear()


def test_purge_analysis_cache_nonpositive_age_clears_all():
    try:
        now = time.time()
        llm_client._ANALYSIS_CACHE.clear()
        llm_client._ANALYSIS_CACHE["a"] = ({}, now)
        llm_client._ANALYSIS_CACHE["b"] = ({}, now - 99999.0)

        removed = llm_client.purge_analysis_cache(max_age_seconds=0)

        assert removed == 2
        assert llm_client._ANALYSIS_CACHE == {}
    finally:
        llm_client._ANALYSIS_CACHE.clear()
