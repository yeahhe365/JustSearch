"""Confirmed audit fixes (crawl path) — regression tests.

覆盖:
- fix 1/3: extract_page_content 前的最后 SSRF 复查 (_reenumerate_and_guard_url)
- fix 2/7: 交互点击候选 JS 过滤内网 href;PREPARE_CLICK_JS_TMPL 移除死参数 wantId
- fix 4: security.py 直连 IP 分支与 DNS 分支策略一致 (198.18.0.0/15 fake-IP 兼容)
- fix 8: content.py Defuddle 状态元组 ("ok" | "method_missing" | "error") 门控
- fix 9: search_result_cleanup.is_breadcrumb 只把 http/https 行当链接
- fix 15: browser_manager.purge_expired_search_cache 跨代理契约
- fix 17: citation_evidence._merge_candidates_by_start 公共合并助手
"""

from __future__ import annotations

import asyncio

from backend.app import browser_manager
from backend.app import page_crawler
from backend.app.crawler import security
from backend.app.crawler import content as crawler_content
from backend.app.search_result_cleanup import clean_fallback_title


# ---------------------------------------------------------------------------
# fix 1/3 — 提取前的最终 SSRF 复查
# ---------------------------------------------------------------------------

def test_reenumerate_and_guard_blocks_private_url_before_extract(monkeypatch):
    class FakeBridge:
        async def get_tab_url(self, tab_id):
            return "http://169.254.169.254/latest/meta-data/"

    monkeypatch.setattr(page_crawler, "is_private_url", lambda u: "169.254" in str(u))

    updated, refusal = asyncio.run(
        page_crawler._reenumerate_and_guard_url(FakeBridge(), 7, "https://public.example/start")
    )

    assert refusal == "错误: 不允许访问内网地址"
    assert updated == "https://public.example/start"


def test_reenumerate_and_guard_updates_final_url_when_safe(monkeypatch):
    class FakeBridge:
        async def get_tab_url(self, tab_id):
            return "https://moved.example/final"

    monkeypatch.setattr(page_crawler, "is_private_url", lambda u: False)

    updated, refusal = asyncio.run(
        page_crawler._reenumerate_and_guard_url(FakeBridge(), 7, "https://public.example/start")
    )

    assert refusal is None
    assert updated == "https://moved.example/final"


def test_reenumerate_and_guard_falls_back_when_url_read_fails(monkeypatch):
    class FakeBridge:
        async def get_tab_url(self, tab_id):
            raise RuntimeError("tab gone")

    monkeypatch.setattr(page_crawler, "is_private_url", lambda u: True)

    updated, refusal = asyncio.run(
        page_crawler._reenumerate_and_guard_url(FakeBridge(), 7, "https://public.example/start")
    )

    # 读 URL 失败 → 沿用已知安全的 final_url，不误拒。
    assert refusal is None
    assert updated == "https://public.example/start"


def test_crawl_page_rechecks_ssrf_before_extract_after_click_window(monkeypatch):
    """导航后复查通过、但交互/settle 窗口内 tab 再次跳到内网 → 提取前必须拦截。"""
    captured = {}
    url_reads = {"n": 0}

    class FakeTabPool:
        def __init__(self, client):
            self.client = client

        async def acquire(self, session_id=None):
            return {"tab_id": 1}

        async def release(self, tab):
            captured["released"] = tab

        async def close_all_pending(self, session_id=None):
            captured["finalized"] = True

    class FakeBridge:
        async def navigate(self, tab_id, url, timeout_ms=20000):
            captured["navigated"] = url

        async def get_tab_url(self, tab_id):
            url_reads["n"] += 1
            if url_reads["n"] == 1:
                # navigate 后第一次复查：公网。
                return "https://public.example/start"
            # 点击窗口后（提取前）的复查：被引到了内网 metadata 地址。
            return "http://169.254.169.254/latest/meta-data/"

        async def evaluate(self, tab_id, js, timeout_ms=None):
            return False

    async def fake_resolve(url, log_func=None):
        return url

    async def fake_extract(*_a, **_k):
        raise AssertionError("private post-click targets must not be extracted")

    monkeypatch.setattr(page_crawler, "TabPool", FakeTabPool)
    monkeypatch.setattr(page_crawler, "get_bridge_client", lambda: FakeBridge())
    monkeypatch.setattr(page_crawler, "resolve_redirect_url", fake_resolve)
    monkeypatch.setattr(page_crawler, "is_private_url", lambda u: "169.254" in str(u))
    monkeypatch.setattr(page_crawler, "extract_page_content", fake_extract)

    result = asyncio.run(page_crawler.crawl_page("https://public.example/start"))

    assert result == "错误: 不允许访问内网地址"
    assert captured.get("finalized") is True


# ---------------------------------------------------------------------------
# fix 2 / fix 7 — 注入 JS 候选过滤与死参数清理
# ---------------------------------------------------------------------------

def test_prepare_click_js_template_formats_without_want_id():
    # wantId 死参数已删除；模板只接受 wantText 一个 %s。
    assert "wantId" not in page_crawler.PREPARE_CLICK_JS_TMPL
    formatted = page_crawler.PREPARE_CLICK_JS_TMPL % page_crawler._js_str("展开阅读全文")
    # _js_str 会把非 ASCII 转成 \uXXXX 转义（JS 侧等价且更安全）
    assert "wantText" in formatted
    assert "\\u5c55\\u5f00" in formatted  # “展开”的转义形式
    assert formatted.count("%s") == 0


def test_interactive_elements_js_filters_internal_href_candidates():
    # 候选收集 JS 必须按解析后的 href 过滤指向内网的锚点。
    src = page_crawler.INTERACTIVE_ELEMENTS_JS
    assert "hrefTargetsInternalNetwork" in src
    for needle in (
        "172.16", "192.168", "169.254", "100.64", "198.18",
        "::1", "fc00", "fe80", ".local", ".internal", "localhost",
    ):
        assert needle in src


# ---------------------------------------------------------------------------
# fix 4 — 直连 IP 与 DNS 解析路径策略一致
# ---------------------------------------------------------------------------

def test_direct_ip_branch_matches_dns_branch_policy():
    # 无需网络：直连 IP 字面量不走 getaddrinfo。
    # 198.18.0.0/15 是本地代理工具的 fake-IP 段，两条路径都应放行；
    # link-local 元数据地址与 RFC1918 内网仍必须拒绝。
    assert security.is_private_url("http://198.18.5.5/") is False
    assert security.is_private_url("http://169.254.169.254/") is True
    assert security.is_private_url("http://10.0.0.5/") is True


# ---------------------------------------------------------------------------
# fix 8 — Defuddle 状态门控
# ---------------------------------------------------------------------------

def test_try_defuddle_extract_returns_status_tuple_success():
    class FakeBridge:
        async def extract_content(self, tab_id, timeout_ms=None):
            return {"ok": True, "text": "rich", "strategy": "defuddle", "useful": 4}

    status, payload = asyncio.run(crawler_content._try_defuddle_extract(FakeBridge(), 1))
    assert status == "ok"
    assert payload is not None and payload["useful"] == 4


def test_try_defuddle_extract_method_missing_status():
    class FakeBridge:
        async def extract_content(self, tab_id, timeout_ms=None):
            raise RuntimeError("extension error: Method not found: extractContent")

    status, payload = asyncio.run(crawler_content._try_defuddle_extract(FakeBridge(), 1))
    assert status == "method_missing"
    assert payload is None


def test_defuddle_transient_error_still_retried_on_next_attempt():
    """attempt 0 瞬态异常只算本次失败；attempt 1 必须再次尝试 Defuddle。"""
    calls = {"n": 0}

    class FakeBridge:
        async def extract_content(self, tab_id, timeout_ms=None):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("bridge request timed out")
            return {
                "ok": True,
                "text": "Recovered full article body. " * 20,
                "strategy": "defuddle",
                "useful": 500,
            }

        async def evaluate(self, tab_id, expression, timeout_ms=None):
            if "scrollTo" in expression:
                return None
            # 启发式回退保持 thin，迫使循环重试。
            return {"text": "Nav Home", "strategy": "cleaned-body", "useful": 7}

    text = asyncio.run(
        crawler_content.extract_page_content(
            FakeBridge(), tab_id=1, url="https://example.com/post", log_func=None
        )
    )
    assert calls["n"] >= 2
    assert "Recovered full article body." in text


def test_defuddle_method_missing_skipped_after_first_attempt():
    """method_missing 是永久状态：后续尝试不得再调 extract_content。"""
    calls = {"n": 0}

    class FakeBridge:
        async def extract_content(self, tab_id, timeout_ms=None):
            calls["n"] += 1
            raise RuntimeError("Unknown method: extractContent")

        async def evaluate(self, tab_id, expression, timeout_ms=None):
            if "scrollTo" in expression:
                return None
            if "HOST_SELECTORS" in expression:
                body = "Legacy extractor still returns the goods. " * 30
                return {
                    "text": body,
                    "strategy": "host-selector:main",
                    "useful": len(body.replace(" ", "")),
                }
            return {"text": "", "strategy": "none", "useful": 0}

    text = asyncio.run(
        crawler_content.extract_page_content(
            FakeBridge(), tab_id=1, url="https://example.com/legacy", log_func=None
        )
    )
    assert calls["n"] == 1
    assert "Legacy extractor" in text


# ---------------------------------------------------------------------------
# fix 9 — is_breadcrumb 只认 http/https scheme
# ---------------------------------------------------------------------------

def test_update_colon_line_is_not_breadcrumb():
    title = "Service status page\nUpdate: service status restored"
    assert clean_fallback_title(title) == "Update: service status restored"


def test_https_line_is_breadcrumb():
    title = "Real headline\nhttps://example.com/a"
    assert clean_fallback_title(title) == "Real headline"


# ---------------------------------------------------------------------------
# fix 15 — purge_expired_search_cache 跨代理契约
# ---------------------------------------------------------------------------

def test_purge_expired_search_cache_removes_only_old_entries():
    browser_manager._search_cache.clear()
    try:
        browser_manager._search_cache["google:old:5"] = ([{"title": "old"}], 1.0)
        browser_manager._search_cache["google:fresh:5"] = ([{"title": "new"}], __import__("time").time())

        removed = browser_manager.purge_expired_search_cache(max_age_seconds=300.0)

        assert removed == 1
        assert "google:old:5" not in browser_manager._search_cache
        assert "google:fresh:5" in browser_manager._search_cache

        # max_age_seconds <= 0 → 清空全部
        removed_all = browser_manager.purge_expired_search_cache(max_age_seconds=0)
        assert removed_all == 1
        assert browser_manager._search_cache == {}
    finally:
        browser_manager._search_cache.clear()


# ---------------------------------------------------------------------------
# fix 17 — 合并助手去重
# ---------------------------------------------------------------------------

def test_merge_candidates_by_start_merges_close_spans_preferring_longer():
    from backend.app.citation_evidence import _merge_candidates_by_start

    cands = [
        {"text": "short", "start": 10, "end": 15},
        {"text": "a much longer candidate text", "start": 12, "end": 40},
        {"text": "far away sentence", "start": 200, "end": 220},
    ]
    merged = _merge_candidates_by_start(cands, min_gap=30)
    assert len(merged) == 2
    assert merged[0]["start"] == 12 and "much longer" in merged[0]["text"]
    assert merged[1]["start"] == 200
