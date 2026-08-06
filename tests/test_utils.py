"""
Basic tests for JustSearch utility functions.
Run with: python -m pytest tests/ -v
"""

import json
import pytest
from types import SimpleNamespace

from backend.app.llm_client import (
    LLMClient,
    LLMProviderConfigurationError,
    ensure_live_artifact_answer,
    _is_retryable_llm_error,
    _provider_error_message,
    _build_search_analysis_result,
    _coerce_bool,
    _extract_history_anchor_terms,
    _fallback_search_analysis,
    _summarize_message_content,
    _budget_sources_for_prompt,
    _PROMPT_SOURCE_ITEM_CAP,
    _ASSISTANT_TURN_CHAR_BUDGET,
)
from backend.app.openai_client import LOCAL_PROVIDER_API_KEY, create_openai_client


def test_openai_client_uses_placeholder_for_empty_local_api_key():
    client = create_openai_client(
        api_key="",
        base_url="http://host.docker.internal:11434/v1",
    )

    assert client.api_key == LOCAL_PROVIDER_API_KEY


class TestLLMContextMessages:
    def test_history_is_kept_but_long_assistant_turns_are_summarized(self):
        """Multi-turn context keeps all recent roles; long/HTML assistant bodies are compressed."""
        client = LLMClient(api_key="test-key", base_url="https://example.test/v1")
        long_answer = "这是一段很长的 assistant 内容。" * 300
        history = [
            {"role": "user", "content": "第一轮"},
            {"role": "assistant", "content": long_answer},
            {"role": "user", "content": "第二轮"},
            {"role": "assistant", "content": "短回复"},
            {"role": "user", "content": "第三轮"},
        ]

        context = client._build_context_messages(history)

        assert [m["role"] for m in context] == [m["role"] for m in history]
        assert context[0]["content"] == "第一轮"
        assert context[2]["content"] == "第二轮"
        assert context[3]["content"] == "短回复"
        assert context[4]["content"] == "第三轮"
        # Long assistant content is truncated for token hygiene (not dropped).
        assert len(context[1]["content"]) < len(long_answer)
        assert "这是一段很长的 assistant 内容" in context[1]["content"]
        assert "答案已截断" not in context[1]["content"]


class TestLLMContextFixes:
    def test_user_angle_bracket_code_is_not_stripped(self):
        # Regression: user prose containing <vector> / comparisons must survive.
        r = _summarize_message_content("user", "what does <vector> do in C++?")
        assert "vector" in r
        assert "<vector>" in r

    def test_null_content_becomes_empty_not_literal_none(self):
        assert _summarize_message_content("assistant", None) == ""
        assert _summarize_message_content("user", None) == ""

    def test_coerce_bool_rejects_string_false(self):
        assert _coerce_bool("false") is False
        assert _coerce_bool("False") is False
        assert _coerce_bool("true") is True
        assert _coerce_bool(True) is True
        assert _coerce_bool(0) is False
        assert _coerce_bool(1) is True
        assert _coerce_bool(None) is False

    def test_empty_assistant_turn_keeps_alternation(self):
        client = LLMClient(api_key="test-key", base_url="https://example.test/v1")
        history = [
            {"role": "user", "content": "first question"},
            {"role": "assistant", "content": "<div></div>"},  # summarizes to empty
            {"role": "user", "content": "follow-up"},
        ]
        roles = [m["role"] for m in client._build_context_messages(history)]
        assert roles == ["user", "assistant", "user"]

    def test_fallback_only_adds_timezone_query_for_time_followups(self):
        history = [
            {"role": "user", "content": "iPhone 15 价格"},
            {"role": "assistant", "content": "iPhone 15 起售价已公布。"},
        ]
        # Non-time follow-up: should NOT inject "时间 北京时间".
        r = _fallback_search_analysis("价格呢？", history)
        assert not any("北京时间" in q and "价格" not in q for q in r["queries"])
        # Time follow-up: SHOULD include a timezone query.
        r2 = _fallback_search_analysis("具体时间？国内时间？", history)
        assert any("北京时间" in q for q in r2["queries"])

    def test_anchor_terms_capture_single_letter_and_strip_punctuation(self):
        a = _extract_history_anchor_terms([
            {"role": "user", "content": "C and R languages"},
            {"role": "assistant", "content": "Python. is great."},
        ])
        assert "C" in a and "R" in a
        assert "Python." not in a  # trailing dot stripped
        assert "Python" in a


class TestLLMResponseParsing:
    def test_provider_error_message_maps_subscription_failure(self):
        error = Exception(
            "Error code: 403 - {'code': 'SUBSCRIPTION_NOT_FOUND', "
            "'message': 'No active subscription found for this group'}"
        )

        assert "没有可用订阅" in _provider_error_message(error)

    def test_connection_errors_are_retryable(self):
        class APIConnectionError(Exception):
            pass

        assert _is_retryable_llm_error(APIConnectionError("Connection error."))
        assert _is_retryable_llm_error(TimeoutError("timed out"))
        assert _is_retryable_llm_error(Exception("Error code: 503 - bad gateway"))
        assert not _is_retryable_llm_error(Exception("invalid api key unauthorized"))

    def test_gateway_stream_corruption_is_retryable(self):
        """Gateway splitting SSE chunks mid-character or returning a GBK error
        page surfaces as UnicodeDecodeError; the retry loop must cover it."""
        from backend.app.llm_client import _is_stream_corruption_error

        decode_err = UnicodeDecodeError(
            "utf-8", b"\xe4\xb8", 0, 2, "unexpected end of data"
        )
        assert _is_retryable_llm_error(decode_err)
        assert _is_stream_corruption_error(decode_err)
        # SDK often wraps the decode error in an APIError — still detectable.
        wrapped = RuntimeError("'utf-8' codec can't decode bytes in position 236-237")
        assert _is_retryable_llm_error(wrapped)
        assert _is_stream_corruption_error(wrapped)
        # Plain provider auth failure is neither retryable nor stream corruption.
        plain = RuntimeError("invalid api key unauthorized")
        assert not _is_retryable_llm_error(plain)
        assert not _is_stream_corruption_error(plain)

    def test_generate_answer_retries_connection_error_before_streaming(self, monkeypatch):
        import asyncio
        from backend.app import llm_client as llm_module

        class APIConnectionError(Exception):
            pass

        class FakeStream:
            def __init__(self, chunks):
                self._chunks = chunks

            def __aiter__(self):
                self._iter = iter(self._chunks)
                return self

            async def __anext__(self):
                try:
                    content = next(self._iter)
                except StopIteration:
                    raise StopAsyncIteration
                return SimpleNamespace(
                    choices=[
                        SimpleNamespace(
                            delta=SimpleNamespace(content=content),
                            finish_reason=None,
                        )
                    ]
                )

        class FakeCompletions:
            def __init__(self):
                self.calls = 0

            async def create(self, model, messages, stream=False):
                self.calls += 1
                if self.calls == 1:
                    raise APIConnectionError("Connection error.")
                return FakeStream(
                    [
                        "Status: sufficient\nMissing_Info: \nAnswer:\n",
                        "Tokyo is the capital [1]",
                    ]
                )

        async def no_sleep(_delay):
            return None

        monkeypatch.setattr(llm_module.asyncio, "sleep", no_sleep)
        monkeypatch.setattr(llm_module, "_GENERATE_ANSWER_RETRIES", 3)

        client = LLMClient(api_key="test-key", base_url="https://example.test/v1")
        completions = FakeCompletions()
        client.client = SimpleNamespace(chat=SimpleNamespace(completions=completions))

        result = asyncio.run(
            client.generate_answer(
                "capital of Japan",
                [{"id": 1, "title": "Tokyo", "content": "Tokyo is capital", "url": "https://example.test"}],
            )
        )

        assert completions.calls == 2
        assert "Tokyo" in result["answer"]
        assert result["status"] == "sufficient"

    def test_llm_retry_backoff_releases_concurrency_slot(self, monkeypatch):
        import asyncio
        from backend.app import llm_client as llm_module

        original_sleep = asyncio.sleep
        sleep_started = None
        release_sleep = None
        events = []

        class RetryableError(Exception):
            status_code = 429

        class FakeCompletions:
            def __init__(self):
                self.retrying_calls = 0

            async def create(self, model, messages):
                events.append(f"call:{model}")
                if model == "retrying":
                    self.retrying_calls += 1
                    if self.retrying_calls == 1:
                        raise RetryableError("rate limited")
                return SimpleNamespace(usage=None)

        async def run_check():
            nonlocal sleep_started, release_sleep
            sleep_started = asyncio.Event()
            release_sleep = asyncio.Event()

            async def fake_sleep(_delay):
                events.append("backoff")
                sleep_started.set()
                await release_sleep.wait()

            monkeypatch.setattr(llm_module, "_LLM_CONCURRENCY", asyncio.Semaphore(1))
            monkeypatch.setattr(llm_module.asyncio, "sleep", fake_sleep)

            completions = FakeCompletions()
            retrying = LLMClient(api_key="test-key", base_url="https://example.test/v1", model="retrying")
            waiting = LLMClient(api_key="test-key", base_url="https://example.test/v1", model="waiting")
            retrying.client = SimpleNamespace(chat=SimpleNamespace(completions=completions))
            waiting.client = SimpleNamespace(chat=SimpleNamespace(completions=completions))

            retrying_task = asyncio.create_task(retrying._call_with_retry([], retries=1))
            await sleep_started.wait()

            waiting_task = asyncio.create_task(waiting._call_with_retry([], retries=0))
            for _ in range(5):
                await original_sleep(0)
                if "call:waiting" in events:
                    break

            assert "call:waiting" in events
            release_sleep.set()
            await asyncio.gather(retrying_task, waiting_task)

        asyncio.run(run_check())

    def test_extract_response_content_accepts_sse_text_response(self):
        client = LLMClient(api_key="test-key", base_url="https://example.test/v1")

        response = (
            'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'
            'data: {"choices":[{"delta":{"content":"{\\"type\\":\\"search\\","},"finish_reason":null}]}\n\n'
            'data: {"choices":[{"delta":{"content":"\\"queries\\":[\\"MDN delete\\"]}"},"finish_reason":null}]}\n\n'
            "data: [DONE]\n\n"
        )

        assert client._extract_response_content(response) == (
            '{"type":"search","queries":["MDN delete"]}'
        )

    def test_analyze_task_accepts_plain_string_response(self):
        client = LLMClient(api_key="test-key", base_url="https://example.test/v1")
        calls = []

        async def fake_call(*args, **kwargs):
            calls.append(kwargs)
            return '{"type": "search", "queries": ["URLSearchParams delete MDN"]}'

        client._call_with_retry = fake_call

        import asyncio
        result = asyncio.run(client.analyze_task("what does URLSearchParams.delete do"))

        assert result["type"] == "search"
        assert result["queries"] == ["URLSearchParams delete MDN"]
        assert result["resolved_query"] == "URLSearchParams delete MDN"
        assert "entities" in result
        assert calls[0]["retries"] == 0

    def test_assess_relevance_accepts_plain_string_response(self):
        client = LLMClient(api_key="test-key", base_url="https://example.test/v1")
        calls = []

        async def fake_call(*args, **kwargs):
            calls.append(kwargs)
            return '{"relevant_ids": [2, 4]}'

        client._call_with_retry = fake_call

        import asyncio
        result = asyncio.run(
            client.assess_relevance(
                "FastAPI CORS",
                [
                    {"id": 1, "title": "Generic FastAPI", "snippet": "..."},
                    {"id": 2, "title": "FastAPI CORS", "snippet": "..."},
                    {"id": 4, "title": "CORSMiddleware", "snippet": "..."},
                ],
            )
        )

        assert result == [2, 4]
        assert calls[0]["retries"] == 0

    def test_analyze_task_propagates_provider_configuration_errors(self):
        client = LLMClient(api_key="test-key", base_url="https://example.test/v1")

        async def fake_call(*args, **kwargs):
            raise LLMProviderConfigurationError("模型服务返回 403：当前 API Key 所属账户没有可用订阅。")

        client._call_with_retry = fake_call

        import asyncio
        with pytest.raises(LLMProviderConfigurationError, match="没有可用订阅"):
            asyncio.run(client.analyze_task("subscription check"))

    def test_assess_relevance_propagates_provider_configuration_errors(self):
        client = LLMClient(api_key="test-key", base_url="https://example.test/v1")

        async def fake_call(*args, **kwargs):
            raise LLMProviderConfigurationError("模型服务返回 403：当前 API Key 所属账户没有可用订阅。")

        client._call_with_retry = fake_call

        import asyncio
        with pytest.raises(LLMProviderConfigurationError, match="没有可用订阅"):
            asyncio.run(
                client.assess_relevance(
                    "subscription check",
                    [{"id": 1, "title": "A", "snippet": "..."}],
                )
            )

    def test_analyze_task_treats_string_queries_as_one_query(self):
        from backend.app import llm_client as llm_module

        llm_module._ANALYSIS_CACHE.clear()
        client = LLMClient(api_key="test-key", base_url="https://example.test/v1")

        async def fake_call(*args, **kwargs):
            return '{"queries": "URLSearchParams delete MDN"}'

        client._call_with_retry = fake_call

        import asyncio
        result = asyncio.run(client.analyze_task("format drift query"))

        assert result["type"] == "search"
        assert result["queries"] == ["URLSearchParams delete MDN"]
        assert result["resolved_query"]
        llm_module._ANALYSIS_CACHE.clear()

    def test_assess_relevance_parses_multi_digit_ids_from_string(self):
        from backend.app import llm_client as llm_module

        llm_module._ANALYSIS_CACHE.clear()
        client = LLMClient(api_key="test-key", base_url="https://example.test/v1")

        async def fake_call(*args, **kwargs):
            return '{"relevant_ids": "10, 12"}'

        client._call_with_retry = fake_call

        import asyncio
        result = asyncio.run(
            client.assess_relevance(
                "multi digit ids",
                [
                    {"id": 10, "title": "A", "snippet": "..."},
                    {"id": 12, "title": "B", "snippet": "..."},
                ],
            )
        )

        assert result == [10, 12]
        llm_module._ANALYSIS_CACHE.clear()

    def test_decide_click_elements_keeps_string_id_intact(self):
        client = LLMClient(api_key="test-key", base_url="https://example.test/v1")

        async def fake_call(*args, **kwargs):
            return '{"clicked_ids": "js-interact-10"}'

        client._call_with_retry = fake_call

        import asyncio
        result = asyncio.run(
            client.decide_click_elements(
                "open details",
                [
                    {"id": "js-interact-10", "tag": "button", "text": "Read more"},
                    {"id": "js-interact-11", "tag": "button", "text": "Share"},
                ],
            )
        )

        assert result == ["js-interact-10"]

    def test_extract_json_ignores_braces_inside_strings(self):
        client = LLMClient(api_key="test-key", base_url="https://example.test/v1")

        result = client._extract_json(
            'Sure: {"type": "search", "queries": ["literal {brace} query"]} done'
        )

        assert result == {"type": "search", "queries": ["literal {brace} query"]}

    def test_analyze_task_cache_is_scoped_by_history(self):
        import asyncio
        from backend.app import llm_client as llm_module

        llm_module._ANALYSIS_CACHE.clear()
        client = LLMClient(api_key="test-key", base_url="https://example.test/v1")
        calls = []

        async def fake_call(messages, **kwargs):
            calls.append(messages)
            history_text = "\n".join(msg["content"] for msg in messages)
            if "Alice" in history_text:
                return '{"type": "search", "queries": ["Alice context"]}'
            return '{"type": "search", "queries": ["Bob context"]}'

        client._call_with_retry = fake_call

        first = asyncio.run(
            client.analyze_task(
                "where is it?",
                [{"role": "user", "content": "Alice"}],
            )
        )
        second = asyncio.run(
            client.analyze_task(
                "where is it?",
                [{"role": "user", "content": "Bob"}],
            )
        )

        assert first["queries"] == ["Alice context"]
        assert second["queries"] == ["Bob context"]
        assert len(calls) == 2
        llm_module._ANALYSIS_CACHE.clear()

    def test_analyze_task_transient_failure_fallback_is_not_cached(self):
        import asyncio
        from backend.app import llm_client as llm_module

        llm_module._ANALYSIS_CACHE.clear()
        client = LLMClient(api_key="test-key", base_url="https://example.test/v1")
        calls = 0

        async def fake_call(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise RuntimeError("temporary upstream failure")
            return '{"type": "search", "queries": ["recovered analysis"]}'

        client._call_with_retry = fake_call

        first = asyncio.run(client.analyze_task("transient query"))
        second = asyncio.run(client.analyze_task("transient query"))

        assert first["type"] == "search"
        assert first["queries"] == ["transient query"]
        assert second["type"] == "search"
        assert second["queries"] == ["recovered analysis"]
        assert second["resolved_query"]
        assert calls == 2
        llm_module._ANALYSIS_CACHE.clear()

    def test_analyze_task_cache_is_isolated_from_returned_result(self):
        import asyncio
        from backend.app import llm_client as llm_module

        llm_module._ANALYSIS_CACHE.clear()
        client = LLMClient(api_key="test-key", base_url="https://example.test/v1")
        calls = 0

        async def fake_call(*args, **kwargs):
            nonlocal calls
            calls += 1
            return '{"type": "search", "queries": ["original cached query"]}'

        client._call_with_retry = fake_call

        first = asyncio.run(client.analyze_task("cache isolation"))
        first["queries"][0] = "mutated by caller"
        second = asyncio.run(client.analyze_task("cache isolation"))

        assert second["type"] == "search"
        assert second["queries"] == ["original cached query"]
        assert second["resolved_query"] == "original cached query"
        assert calls == 1
        llm_module._ANALYSIS_CACHE.clear()

    def test_relevance_cache_is_scoped_by_snippet_content(self):
        import asyncio
        from backend.app import llm_client as llm_module

        llm_module._ANALYSIS_CACHE.clear()
        client = LLMClient(api_key="test-key", base_url="https://example.test/v1")
        calls = []

        async def fake_call(*args, **kwargs):
            calls.append(args)
            return '{"relevant_ids": [%d]}' % (2 if len(calls) == 1 else 4)

        client._call_with_retry = fake_call

        first = asyncio.run(
            client.assess_relevance(
                "same query",
                [
                    {"id": 1, "title": "A", "url": "https://a.example", "snippet": "alpha"},
                    {"id": 2, "title": "B", "url": "https://b.example", "snippet": "beta"},
                ],
            )
        )
        second = asyncio.run(
            client.assess_relevance(
                "same query",
                [
                    {"id": 3, "title": "C", "url": "https://c.example", "snippet": "gamma"},
                    {"id": 4, "title": "D", "url": "https://d.example", "snippet": "delta"},
                ],
            )
        )

        assert first == [2]
        assert second == [4]
        assert len(calls) == 2
        llm_module._ANALYSIS_CACHE.clear()

    def test_relevance_cache_is_isolated_from_returned_result(self):
        import asyncio
        from backend.app import llm_client as llm_module

        llm_module._ANALYSIS_CACHE.clear()
        client = LLMClient(api_key="test-key", base_url="https://example.test/v1")
        calls = 0

        async def fake_call(*args, **kwargs):
            nonlocal calls
            calls += 1
            return '{"relevant_ids": [2, 4]}'

        client._call_with_retry = fake_call
        snippets = [
            {"id": 2, "title": "A", "url": "https://a.example", "snippet": "alpha"},
            {"id": 4, "title": "B", "url": "https://b.example", "snippet": "beta"},
        ]

        first = asyncio.run(client.assess_relevance("cache isolation", snippets))
        first.append(99)
        second = asyncio.run(client.assess_relevance("cache isolation", snippets))

        assert second == [2, 4]
        assert calls == 1
        llm_module._ANALYSIS_CACHE.clear()

    def test_analyze_task_parses_resolved_query_and_entities(self):
        import asyncio
        from backend.app import llm_client as llm_module

        llm_module._ANALYSIS_CACHE.clear()
        client = LLMClient(api_key="test-key", base_url="https://example.test/v1")

        async def fake_call(*args, **kwargs):
            return json.dumps(
                {
                    "type": "search",
                    "resolved_query": "梅西阿根廷世界杯半决赛对阵英格兰开球时间北京时间",
                    "queries": [
                        "梅西 阿根廷 英格兰 半决赛 开球时间",
                        "阿根廷 vs 英格兰 世界杯 北京时间",
                    ],
                    "entities": ["梅西", "阿根廷", "英格兰", "世界杯半决赛"],
                    "is_followup": True,
                    "topic_changed": False,
                },
                ensure_ascii=False,
            )

        client._call_with_retry = fake_call
        history = [
            {"role": "user", "content": "梅西的下一场比赛是什么时候？"},
            {"role": "assistant", "content": "阿根廷对阵英格兰半决赛。"},
        ]
        result = asyncio.run(
            client.analyze_task("具体时间是什么时候？国内时间是什么时候？", history)
        )

        assert result["type"] == "search"
        assert "梅西" in result["resolved_query"] or "阿根廷" in result["resolved_query"]
        assert any("梅西" in q or "阿根廷" in q for q in result["queries"])
        assert result["is_followup"] is True
        assert "梅西" in result["entities"] or "阿根廷" in result["entities"]
        llm_module._ANALYSIS_CACHE.clear()

    def test_analyze_task_followup_fallback_anchors_history_entities(self):
        import asyncio
        from backend.app import llm_client as llm_module

        llm_module._ANALYSIS_CACHE.clear()
        client = LLMClient(api_key="test-key", base_url="https://example.test/v1")

        async def fake_call(*args, **kwargs):
            raise RuntimeError("upstream down")

        client._call_with_retry = fake_call
        history = [
            {"role": "user", "content": "梅西的下一场比赛是什么时候？"},
            {
                "role": "assistant",
                "content": "梅西将代表阿根廷出战世界杯半决赛对阵英格兰。",
            },
        ]
        result = asyncio.run(
            client.analyze_task("具体时间是什么时候？国内时间是什么时候？", history)
        )

        assert result["type"] == "search"
        assert result["is_followup"] is True
        joined = " ".join([result["resolved_query"], *result["queries"]])
        assert "梅西" in joined or "阿根廷" in joined or "英格兰" in joined
        # Must not search the bare follow-up alone.
        assert result["queries"] != ["具体时间是什么时候？国内时间是什么时候？"]
        llm_module._ANALYSIS_CACHE.clear()

    def test_analyze_task_repairs_thin_followup_queries_from_model(self):
        import asyncio
        from backend.app import llm_client as llm_module

        llm_module._ANALYSIS_CACHE.clear()
        client = LLMClient(api_key="test-key", base_url="https://example.test/v1")

        async def fake_call(*args, **kwargs):
            # Model forgot entities — classic topic-drift failure mode.
            return '{"type":"search","queries":["具体时间 国内时间"],"is_followup":true}'

        client._call_with_retry = fake_call
        history = [
            {"role": "user", "content": "梅西的下一场比赛是什么时候？"},
            {"role": "assistant", "content": "阿根廷对阵英格兰的世界杯半决赛。"},
        ]
        result = asyncio.run(
            client.analyze_task("具体时间是什么时候？国内时间是什么时候？", history)
        )

        joined = " ".join(result["queries"])
        assert "梅西" in joined or "阿根廷" in joined or "英格兰" in joined
        assert result["resolved_query"]
        llm_module._ANALYSIS_CACHE.clear()

    def test_build_context_messages_strips_html_and_truncates_assistant(self):
        client = LLMClient(api_key="test-key", base_url="https://example.test/v1")
        history = [
            {"role": "user", "content": "梅西的下一场比赛是什么时候？"},
            {
                "role": "assistant",
                "content": (
                    '<section style="display:block"><h2>梅西下一场</h2>'
                    + ("阿根廷对阵英格兰。" * 80)
                    + "</section>"
                ),
            },
        ]
        msgs = client._build_context_messages(history)
        assert len(msgs) == 2
        assert msgs[0]["role"] == "user"
        assert msgs[1]["role"] == "assistant"
        assert "<section" not in msgs[1]["content"]
        assert "梅西下一场" in msgs[1]["content"] or "阿根廷" in msgs[1]["content"]
        # Long assistant turn is bounded by the per-turn char budget.
        assert len(msgs[1]["content"]) <= _ASSISTANT_TURN_CHAR_BUDGET


def test_budget_sources_caps_items_and_total():
    """Prompt-source budget: per-item cap, total budget, and tail placeholders."""
    # With a tiny total budget and tiny per-item cap, only the first source can
    # carry content; later sources exhaust the budget and become placeholders.
    sources = [
        {"id": 1, "content": "a" * 50000},
        {"id": 2, "content": "b" * 50000},
        {"id": 3, "content": "c" * 50000},
    ]
    out, orig, final = _budget_sources_for_prompt(
        sources, total_budget=120, per_item_cap=20000
    )
    assert orig == 150000
    assert final <= 120 + 100
    # First source consumed the budget and was trimmed.
    assert out[0]["content"].endswith("（节选）")
    # Sources 2 and 3 hit a non-positive remaining budget → placeholders.
    assert out[1]["content"] == "[此来源因上下文预算被省略]"
    assert out[2]["content"] == "[此来源因上下文预算被省略]"


def test_history_budget_keeps_latest_and_preserves_code_newlines():
    """Char budget fills newest-first; code-block newlines survive compression."""
    client = LLMClient(
        api_key="k",
        base_url="https://e.test/v1",
        history_window=10,
        history_char_budget=100,
        assistant_turn_char_budget=60,
    )
    code_turn = {
        "role": "assistant",
        "content": "见下：\n```\ndef f():\n    return 1\n```",
    }
    history = [
        {"role": "user", "content": "u" * 50},
        code_turn,
        {"role": "user", "content": "最新问题"},
    ]
    msgs = client._build_context_messages(history)
    # The newest user turn is always retained.
    assert msgs[-1]["content"] == "最新问题"
    # A code block's newlines must not be flattened to a single line.
    joined = "\n".join(m["content"] for m in msgs)
    assert "\n" in joined


def test_fallback_respects_topic_change():
    """A genuinely new-topic follow-up must not be anchored to old history."""
    from backend.app.llm_client import _fallback_search_analysis

    history = [
        {"role": "user", "content": "梅西的下一场比赛是什么时候？"},
        {"role": "assistant", "content": "阿根廷对阵英格兰半决赛。"},
    ]
    r = _fallback_search_analysis("为什么苹果股价最近跌了？", history)
    joined = " ".join([r["resolved_query"], *r["queries"]])
    assert "梅西" not in joined
    assert "阿根廷" not in joined
    assert "英格兰" not in joined
    assert r["topic_changed"] is True


def test_fallback_keeps_anchors_for_same_topic_followup():
    """Short same-topic follow-ups must still carry history entities."""
    from backend.app.llm_client import _fallback_search_analysis

    history = [
        {"role": "user", "content": "梅西的下一场比赛是什么时候？"},
        {"role": "assistant", "content": "阿根廷对阵英格兰半决赛。"},
    ]
    r = _fallback_search_analysis("具体时间？国内时间是什么时候？", history)
    joined = " ".join([r["resolved_query"], *r["queries"]])
    assert "梅西" in joined or "阿根廷" in joined or "英格兰" in joined
    assert r["topic_changed"] is False


def test_extract_history_anchor_terms_caps_cjk_run_at_subclause():
    """A long unpunctuated CJK run no longer swallows a whole clause."""
    from backend.app.llm_client import _extract_history_anchor_terms

    history = [
        {"role": "user", "content": "今天天气真好我们讨论一下足球比赛的结果和球员表现"},
        {"role": "assistant", "content": "好的开始讨论"},
    ]
    anchors = _extract_history_anchor_terms(history)
    # No anchor should be an entire long sentence; each should be a bounded run.
    assert all(len(a) <= 12 for a in anchors)
    assert not any("我们讨论一下足球比赛的结果和球员表现" in a for a in anchors)


class TestLiveArtifactsAnswerFormatting:
    def test_markdown_fallback_is_wrapped_as_inline_live_artifact(self):
        answer = "## 核心结论\n- **重点**：已开启 Live Artifacts [1]\n- 保留引用 [2]"

        artifact = ensure_live_artifact_answer(answer)

        assert artifact.startswith('<section style="display:block;width:100%;')
        assert "<h2>核心结论</h2>" in artifact
        assert "<li><strong>重点</strong>：已开启 Live Artifacts [1]</li>" in artifact
        assert "##" not in artifact

    def test_fenced_html_is_unwrapped(self):
        artifact = ensure_live_artifact_answer(
            "```html\n<section style=\"display:block;width:100%;box-sizing:border-box;max-width:100%;overflow-wrap:anywhere;\"><h2>Ready</h2></section>\n```"
        )

        assert artifact.startswith("<section")
        assert "```" not in artifact

    def test_multi_root_html_is_wrapped_under_single_root(self):
        """Greedy root regex accepts multi-root; ensure_ wraps for a single container."""
        multi = "<div>a</div><div>b</div>"
        artifact = ensure_live_artifact_answer(multi)
        assert artifact.startswith("<div style=")
        assert ">a</div><div>b</div></div>" in artifact or (
            "<div>a</div><div>b</div>" in artifact and artifact.count("<div") >= 3
        )
        # Single-root fragments stay unwrapped (aside from their own root).
        single = '<div style="display:block;width:100%">only</div>'
        assert ensure_live_artifact_answer(single) == single

    def test_fenced_full_html_document_is_preserved(self):
        artifact = ensure_live_artifact_answer(
            "```html\n<!doctype html><html><head><title>Demo</title></head><body><main>Ready</main></body></html>\n```"
        )

        assert artifact.startswith("<!doctype html>")
        assert "<main>Ready</main>" in artifact
        assert "&lt;html" not in artifact

    def test_chinese_status_envelope_html_is_not_escaped(self):
        """GLM often emits 状态/缺失信息/回答; tags must stay real HTML."""
        html = (
            '<div style="display:block;width:100%;box-sizing:border-box;'
            'max-width:100%;overflow-wrap:anywhere">'
            "<h2>跌停股后续走势</h2><p>部分数据缺失[1]</p></div>"
        )
        raw = (
            "状态: 不足\n\n"
            "缺失信息: 7月14日主力净流入缺失\n\n"
            f"回答:\n{html}"
        )
        artifact = ensure_live_artifact_answer(raw)
        assert "<h2>跌停股后续走势</h2>" in artifact
        assert "&lt;div" not in artifact
        assert "&lt;h2" not in artifact
        assert "状态:" not in artifact
        assert "缺失信息" not in artifact

    def test_english_status_envelope_html_is_not_escaped(self):
        html = (
            '<section style="display:block;width:100%;box-sizing:border-box;'
            'max-width:100%;overflow-wrap:anywhere;"><h2>Ready</h2></section>'
        )
        raw = f"Status: insufficient\nMissing_Info: need more data\nAnswer:\n{html}"
        artifact = ensure_live_artifact_answer(raw)
        assert artifact.startswith("<section")
        assert "<h2>Ready</h2>" in artifact
        assert "&lt;section" not in artifact

    def test_prose_prefix_plus_html_is_not_escaped(self):
        """Partial-answer path used to prepend ⚠️ text and escape the artifact."""
        html = (
            '<div style="display:block;width:100%;box-sizing:border-box;'
            'max-width:100%;overflow-wrap:anywhere"><h2>临时结论</h2></div>'
        )
        mixed = (
            "⚠️ 经过 2 次尝试后，仍无法确认资料足够完整，"
            f"以下是基于已收集资料整理的临时答案，可能仍不完整。\n\n{html}"
        )
        artifact = ensure_live_artifact_answer(mixed)
        assert "<h2>临时结论</h2>" in artifact
        assert "&lt;div" not in artifact
        assert "&lt;h2" not in artifact

    def test_parse_answer_envelope_chinese_insufficient(self):
        from backend.app.llm_client import _parse_answer_envelope

        parsed = _parse_answer_envelope(
            "状态：不足\n缺失信息：缺价格\n回答：\n<div><h2>A</h2></div>"
        )
        assert parsed["status"] == "insufficient"
        assert "缺价格" in parsed["missing_info"]
        assert parsed["answer"].startswith("<div>")
        assert parsed["had_envelope"] is True

    def test_format_live_artifact_partial_answer_keeps_html(self):
        from backend.app.workflow import SearchWorkflow

        html = (
            '<div style="display:block;width:100%;box-sizing:border-box;'
            'max-width:100%;overflow-wrap:anywhere"><h2>部分答案</h2></div>'
        )
        # SearchWorkflow.__init__ is heavy; call unbound helper via a thin stub.
        formatted = SearchWorkflow._format_live_artifact_partial_answer(
            SearchWorkflow,
            html,
            "经过 1 次尝试后，仍无法确认资料足够完整",
        )
        assert 'data-justsearch-partial-banner="true"' in formatted
        assert "<h2>部分答案</h2>" in formatted
        assert "&lt;div" not in formatted
        assert "&lt;h2" not in formatted

    def test_generate_answer_uses_live_artifacts_prompt_and_fallback(self):
        import asyncio

        captured = {}

        class FakeStream:
            def __init__(self, chunks):
                self._chunks = chunks

            def __aiter__(self):
                self._iter = iter(self._chunks)
                return self

            async def __anext__(self):
                try:
                    content = next(self._iter)
                except StopIteration:
                    raise StopAsyncIteration
                return SimpleNamespace(
                    choices=[
                        SimpleNamespace(
                            delta=SimpleNamespace(content=content),
                            finish_reason=None,
                        )
                    ]
                )

        class FakeCompletions:
            async def create(self, model, messages, stream):
                captured["messages"] = messages
                return FakeStream(
                    [
                        "Status: sufficient\nMissing_Info: \nAnswer:\n",
                        "## 结论\n- 普通 Markdown 会被兜底转换 [1]",
                    ]
                )

        client = LLMClient(api_key="test-key", base_url="https://example.test/v1")
        client.client = SimpleNamespace(chat=SimpleNamespace(completions=FakeCompletions()))

        result = asyncio.run(
            client.generate_answer(
                "测试 Live Artifacts",
                [{"id": 1, "title": "fixture", "content": "source", "url": "https://example.test"}],
                live_artifacts_mode=True,
            )
        )

        system_prompt = captured["messages"][0]["content"]
        assert "[Live Artifacts Inline Protocol - zh]" in system_prompt
        assert "JustSearch 的 Live Artifacts Designer" in system_prompt
        assert "100vh" in system_prompt
        assert "AMC-WebUI" not in system_prompt
        assert "The actual answer content in Markdown" not in system_prompt
        assert result["answer"].startswith('<section style="display:block;width:100%;')
        assert "<h2>结论</h2>" in result["answer"]

    def test_generate_answer_selects_english_live_artifacts_protocol(self):
        import asyncio

        captured = {}

        class FakeStream:
            def __init__(self, chunks):
                self._chunks = chunks

            def __aiter__(self):
                self._iter = iter(self._chunks)
                return self

            async def __anext__(self):
                try:
                    content = next(self._iter)
                except StopIteration:
                    raise StopAsyncIteration
                return SimpleNamespace(
                    choices=[
                        SimpleNamespace(
                            delta=SimpleNamespace(content=content),
                            finish_reason=None,
                        )
                    ]
                )

        class FakeCompletions:
            async def create(self, model, messages, stream):
                captured["messages"] = messages
                return FakeStream(
                    [
                        "Status: sufficient\nMissing_Info: \nAnswer:\n",
                        "<section><h2>Conclusion</h2><p>Done [1]</p></section>",
                    ]
                )

        client = LLMClient(api_key="test-key", base_url="https://example.test/v1")
        client.client = SimpleNamespace(chat=SimpleNamespace(completions=FakeCompletions()))

        asyncio.run(
            client.generate_answer(
                "What is Live Artifacts?",
                [{"id": 1, "title": "fixture", "content": "source", "url": "https://example.test"}],
                live_artifacts_mode=True,
            )
        )

        system_prompt = captured["messages"][0]["content"]
        assert "[Live Artifacts Inline Protocol - en]" in system_prompt
        assert "Live Artifacts Designer for JustSearch" in system_prompt
        assert "100vh" in system_prompt

    def test_live_artifacts_markdown_fallback_is_not_streamed_as_markdown(self):
        import asyncio

        class FakeStream:
            def __init__(self, chunks):
                self._chunks = chunks

            def __aiter__(self):
                self._iter = iter(self._chunks)
                return self

            async def __anext__(self):
                try:
                    content = next(self._iter)
                except StopIteration:
                    raise StopAsyncIteration
                return SimpleNamespace(
                    choices=[
                        SimpleNamespace(
                            delta=SimpleNamespace(content=content),
                            finish_reason=None,
                        )
                    ]
                )

        class FakeCompletions:
            async def create(self, model, messages, stream):
                return FakeStream(
                    [
                        "Status: sufficient\nMissing_Info: \nAnswer:\n",
                        "## 结论\n- Markdown 兜底最终会转为 artifact [1]",
                    ]
                )

        chunks = []
        client = LLMClient(api_key="test-key", base_url="https://example.test/v1")
        client.client = SimpleNamespace(chat=SimpleNamespace(completions=FakeCompletions()))

        result = asyncio.run(
            client.generate_answer(
                "测试 Live Artifacts",
                [{"id": 1, "title": "fixture", "content": "source", "url": "https://example.test"}],
                stream_callback=chunks.append,
                live_artifacts_mode=True,
            )
        )

        assert chunks == []
        assert result["answer"].startswith('<section style="display:block;width:100%;')

    def test_live_artifacts_fenced_html_streams_for_preview(self):
        import asyncio

        class FakeStream:
            def __init__(self, chunks):
                self._chunks = chunks

            def __aiter__(self):
                self._iter = iter(self._chunks)
                return self

            async def __anext__(self):
                try:
                    content = next(self._iter)
                except StopIteration:
                    raise StopAsyncIteration
                return SimpleNamespace(
                    choices=[
                        SimpleNamespace(
                            delta=SimpleNamespace(content=content),
                            finish_reason=None,
                        )
                    ]
                )

        class FakeCompletions:
            async def create(self, model, messages, stream):
                return FakeStream(
                    [
                        "Status: sufficient\nMissing_Info: \nAnswer:\n",
                        "```html\n",
                        "<section style=\"display:block;width:100%\"><h2>Live</h2></section>\n```",
                    ]
                )

        chunks = []
        client = LLMClient(api_key="test-key", base_url="https://example.test/v1")
        client.client = SimpleNamespace(chat=SimpleNamespace(completions=FakeCompletions()))

        result = asyncio.run(
            client.generate_answer(
                "测试 Live Artifacts",
                [{"id": 1, "title": "fixture", "content": "source", "url": "https://example.test"}],
                stream_callback=chunks.append,
                live_artifacts_mode=True,
            )
        )

        streamed = "".join(chunks)
        assert "```html" in streamed
        assert "<section" in streamed
        assert result["answer"].startswith("<section")

    def test_generate_answer_stream_consumption_holds_concurrency_slot(self, monkeypatch):
        import asyncio
        from backend.app import llm_client as llm_module

        original_sleep = asyncio.sleep
        events = []

        def make_chunk(content):
            return SimpleNamespace(
                choices=[
                    SimpleNamespace(
                        delta=SimpleNamespace(content=content),
                        finish_reason=None,
                    )
                ]
            )

        async def run_check():
            stream_started = asyncio.Event()
            release_first_stream = asyncio.Event()

            class BlockingStream:
                def __init__(self, model):
                    self.model = model
                    self.index = 0

                def __aiter__(self):
                    return self

                async def __anext__(self):
                    if self.index == 0:
                        self.index += 1
                        events.append(f"stream:{self.model}:start")
                        if self.model == "first":
                            stream_started.set()
                            await release_first_stream.wait()
                        return make_chunk("Status: sufficient\nMissing_Info: \nAnswer:\n")
                    if self.index == 1:
                        self.index += 1
                        return make_chunk(f"{self.model} answer")
                    raise StopAsyncIteration

            class FakeCompletions:
                async def create(self, model, messages, stream):
                    events.append(f"create:{model}")
                    return BlockingStream(model)

            monkeypatch.setattr(llm_module, "_LLM_CONCURRENCY", asyncio.Semaphore(1))
            completions = FakeCompletions()
            first = LLMClient(api_key="test-key", base_url="https://example.test/v1", model="first")
            second = LLMClient(api_key="test-key", base_url="https://example.test/v1", model="second")
            first.client = SimpleNamespace(chat=SimpleNamespace(completions=completions))
            second.client = SimpleNamespace(chat=SimpleNamespace(completions=completions))
            sources = [{"id": 1, "title": "fixture", "content": "source", "url": "https://example.test"}]

            first_task = asyncio.create_task(first.generate_answer("q1", sources))
            await stream_started.wait()

            second_task = asyncio.create_task(second.generate_answer("q2", sources))
            for _ in range(5):
                await original_sleep(0)
            assert "create:second" not in events

            release_first_stream.set()
            first_result = await first_task
            assert first_result["answer"] == "first answer"

            for _ in range(5):
                await original_sleep(0)
                if "create:second" in events:
                    break
            assert "create:second" in events
            second_result = await second_task
            assert second_result["answer"] == "second answer"

        asyncio.run(run_check())
