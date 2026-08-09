import base64
import asyncio
import re

from backend.app import browser_manager
from backend.app import page_crawler
from backend.app import search_engine
from backend.app.crawler import content as crawler_content
from backend.app.workflow import SearchWorkflow
from backend.app.crawler import redirects
from backend.app.crawler import security
from backend.app.browser_manager import BrowserManager
from backend.app.search_result_cleanup import is_search_engine_internal_page


def test_resolve_redirect_url_extracts_sogou_script_target(monkeypatch):
    wrapper_url = "https://www.sogou.com/link?url=opaque-token"
    target_url = "https://download.csdn.net/blog/column/12812907/146013916"

    async def fake_fetch(url):
        assert url == wrapper_url
        return (
            '<meta content="always" name="referrer">'
            f'<script>window.location.replace("{target_url}")</script>'
            f"<noscript><META http-equiv=\"refresh\" content=\"0;URL='{target_url}'\"></noscript>"
        )

    monkeypatch.setattr(redirects, "_fetch_sogou_redirect_html", fake_fetch, raising=False)

    assert asyncio.run(redirects.resolve_redirect_url(wrapper_url)) == target_url


def test_resolve_redirect_url_ignores_sogou_lookalike_domain(monkeypatch):
    wrapper_url = "https://evil-sogou.com/link?url=opaque-token"
    called = []

    async def fake_fetch(url):
        called.append(url)
        return '<script>window.location.replace("https://example.com/article")</script>'

    monkeypatch.setattr(redirects, "_fetch_sogou_redirect_html", fake_fetch, raising=False)

    assert asyncio.run(redirects.resolve_redirect_url(wrapper_url)) == wrapper_url
    assert called == []


def test_decode_bing_redirect_url_shared_helper():
    """Shared helper decodes bing /ck/a redirects and rejects non-bing/lookalike URLs."""
    target_url = "https://example.com/docs?a=1&b=2"
    encoded = base64.urlsafe_b64encode(target_url.encode("utf-8")).decode("ascii").rstrip("=")
    bing_url = f"https://www.bing.com/ck/a?u=a1{encoded}&ntb=1"

    assert redirects.decode_bing_redirect_url(bing_url) == target_url
    # Non-bing host: unchanged.
    assert redirects.decode_bing_redirect_url(f"https://evil-bing.com/ck/a?u=a1{encoded}") == ""
    # Wrong path: unchanged.
    assert redirects.decode_bing_redirect_url(f"https://www.bing.com/other?u=a1{encoded}") == ""
    # Missing u=a1 prefix: unchanged.
    assert redirects.decode_bing_redirect_url("https://www.bing.com/ck/a?u=plain") == ""
    # Decoded non-http target: unchanged.
    decoded_non_http = base64.urlsafe_b64encode(b"ftp://example.com/x").decode("ascii").rstrip("=")
    assert redirects.decode_bing_redirect_url(f"https://www.bing.com/ck/a?u=a1{decoded_non_http}") == ""


def test_resolve_redirect_url_ignores_redirect_markers_on_non_engine_domains():
    target = "https://example.com/article"
    encoded_target = base64.urlsafe_b64encode(target.encode("utf-8")).decode("ascii").rstrip("=")
    bing_lookalike = f"https://example.test/bing.com/ck/a?u=a1{encoded_target}"
    google_lookalike = (
        "https://example.test/google.com/url?q=https%3A%2F%2Fexample.com%2Farticle"
    )
    duck_lookalike = (
        "https://example.test/duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Farticle"
    )

    assert asyncio.run(redirects.resolve_redirect_url(bing_lookalike)) == bing_lookalike
    assert asyncio.run(redirects.resolve_redirect_url(google_lookalike)) == google_lookalike
    assert asyncio.run(redirects.resolve_redirect_url(duck_lookalike)) == duck_lookalike


def test_resolve_redirect_url_extracts_google_target_param():
    google_url = "https://www.google.com/url?sa=t&q=https%3A%2F%2Fexample.com%2Farticle"

    assert asyncio.run(redirects.resolve_redirect_url(google_url)) == "https://example.com/article"


def test_resource_blocker_removed_in_bridge_refactor():
    # 桥接重构后 install_resource_blocker 已移除(真实浏览器不拦截资源)。
    # 保留 SSRF 守卫:is_private_url 仍用于在 navigate 前后校验目标 URL。
    assert not hasattr(crawler_content, "install_resource_blocker")
    assert hasattr(security, "is_private_url")


def test_crawl_page_blocks_private_url_after_browser_redirect(monkeypatch):
    # 桥接重构后 crawl_page 走 bridge.navigate + bridge.get_tab_url。
    # 导航到私有地址后,SSRF 守卫应拦截并返回错误,不进入内容提取。
    captured = {}

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
            # 模拟浏览器跳转到了内网地址。
            return "http://127.0.0.1/admin"

    async def fake_resolve(url, log_func=None):
        return url

    monkeypatch.setattr(page_crawler, "TabPool", FakeTabPool)
    monkeypatch.setattr(page_crawler, "get_bridge_client", lambda: FakeBridge())
    monkeypatch.setattr(page_crawler, "resolve_redirect_url", fake_resolve)
    monkeypatch.setattr(page_crawler, "is_private_url", lambda url: "127.0.0.1" in str(url))

    async def fake_extract(*_a, **_k):
        raise AssertionError("private redirect targets must not be extracted")

    monkeypatch.setattr(page_crawler, "extract_page_content", fake_extract)

    result = asyncio.run(
        page_crawler.crawl_page("https://public.example/start")
    )

    assert result == "错误: 不允许访问内网地址"
    assert captured.get("finalized") is True


def test_crawl_page_prefers_page_url_when_response_url_is_original(monkeypatch):
    # 跳转后 URL 与原 URL 一致(public),应进入正常提取流程。
    class FakeTabPool:
        def __init__(self, client):
            pass

        async def acquire(self, session_id=None):
            return {"tab_id": 1}

        async def release(self, tab):
            pass

        async def close_all_pending(self, session_id=None):
            pass

    class FakeBridge:
        async def navigate(self, tab_id, url, timeout_ms=20000):
            pass

        async def get_tab_url(self, tab_id):
            return "https://public.example/start"

        async def evaluate(self, tab_id, js, timeout_ms=None):
            return False

    async def fake_resolve(url, log_func=None):
        return url

    async def fake_extract(bridge, tab_id, url, log_func=None):
        return "public content"

    async def fake_og(bridge, tab_id):
        return {}

    monkeypatch.setattr(page_crawler, "TabPool", FakeTabPool)
    monkeypatch.setattr(page_crawler, "get_bridge_client", lambda: FakeBridge())
    monkeypatch.setattr(page_crawler, "resolve_redirect_url", fake_resolve)
    monkeypatch.setattr(page_crawler, "is_private_url", lambda url: "127.0.0.1" in str(url))
    monkeypatch.setattr(page_crawler, "extract_page_content", fake_extract)
    monkeypatch.setattr(page_crawler, "extract_og_metadata", fake_og)

    result = asyncio.run(
        page_crawler.crawl_page("https://public.example/start")
    )

    assert result == "public content"


def test_crawl_page_skips_pdf_after_browser_redirect(monkeypatch):
    class FakeTabPool:
        def __init__(self, client):
            pass

        async def acquire(self, session_id=None):
            return {"tab_id": 1}

        async def release(self, tab):
            pass

        async def close_all_pending(self, session_id=None):
            pass

    class FakeBridge:
        async def navigate(self, tab_id, url, timeout_ms=20000):
            pass

        async def get_tab_url(self, tab_id):
            return "https://cdn.example/report.pdf?download=1"

    async def fake_resolve(url, log_func=None):
        return url

    async def fake_extract(*_a, **_k):
        raise AssertionError("redirected PDFs should not enter generic extraction")

    monkeypatch.setattr(page_crawler, "TabPool", FakeTabPool)
    monkeypatch.setattr(page_crawler, "get_bridge_client", lambda: FakeBridge())
    monkeypatch.setattr(page_crawler, "resolve_redirect_url", fake_resolve)
    monkeypatch.setattr(page_crawler, "is_private_url", lambda url: False)
    monkeypatch.setattr(page_crawler, "extract_page_content", fake_extract)

    result = asyncio.run(
        page_crawler.crawl_page("https://public.example/report")
    )

    assert result == (
        "[PDF 文档] https://cdn.example/report.pdf?download=1\n"
        "注意: PDF 文件无法直接提取内容，请访问链接查看原文。"
    )


def test_private_url_blocks_direct_198_18_address_but_allows_proxy_resolved_domain(monkeypatch):
    def fake_getaddrinfo(hostname, *_args, **_kwargs):
        assert hostname == "example.test"
        return [(None, None, None, None, ("198.18.0.12", 0))]

    monkeypatch.setattr(security.socket, "getaddrinfo", fake_getaddrinfo)

    assert security.is_private_url("http://198.18.0.12/status") is True
    assert security.is_private_url("https://example.test/page") is False


def test_fallback_text_extract_cleans_multiline_search_titles(monkeypatch):
    # 桥接重构后 _fallback_text_extract(bridge, tab_id, ...) 内部走 bridge.evaluate。
    # 用一个 fake bridge 桩掉 evaluate,返回固定的锚点列表。
    class FakeBridge:
        async def evaluate(self, _tab_id, _js, timeout_ms=None):
            return [
                {
                    "title": (
                        "FastAPI\n"
                        "fastapi.tiangolo.com > tutorial > cors\n"
                        "CORS (Cross-Origin Resource Sharing) - FastAPI"
                    ),
                    "url": "https://fastapi.tiangolo.com/tutorial/cors/",
                    "snippet": "allow_origins - A list of origins that should be permitted.",
                }
            ]

    manager = BrowserManager(engine="brave", max_results=3)
    results = asyncio.run(manager._fallback_text_extract(FakeBridge(), tab_id=1, query="FastAPI CORS"))

    assert results[0]["title"] == "CORS (Cross-Origin Resource Sharing) - FastAPI"


def test_fallback_text_extract_skips_generic_more_about_links(monkeypatch):
    class FakeBridge:
        async def evaluate(self, _tab_id, _js, timeout_ms=None):
            return [
                {
                    "title": "更多关于 reddit.com 的信息",
                    "url": "https://www.reddit.com/r/FastAPI/comments/1fm2hhk/cors_policy_no_accesscontrolalloworigin_header_is/",
                    "snippet": "",
                },
                {
                    "title": "CORS (Cross-Origin Resource Sharing) - FastAPI",
                    "url": "https://fastapi.tiangolo.com/tutorial/cors/",
                    "snippet": "allow_origins - A list of origins that should be permitted.",
                },
            ]

    manager = BrowserManager(engine="brave", max_results=3)
    results = asyncio.run(manager._fallback_text_extract(FakeBridge(), tab_id=1, query="FastAPI CORS"))

    assert len(results) == 1
    assert results[0]["id"] == 1
    assert results[0]["url"] == "https://fastapi.tiangolo.com/tutorial/cors/"


def test_search_result_postprocessing_resolves_sogou_wrappers_and_skips_search_pages(monkeypatch):
    wrapper_url = "https://www.sogou.com/link?url=opaque-article"
    search_wrapper_url = "https://www.sogou.com/link?url=opaque-more-content"
    article_url = "https://www.jb51.net/python/31727923x.htm"
    internal_search_url = (
        "https://www.sogou.com/web?ie=utf8&query=FastAPI%20CORSMiddleware%20allow_origins"
    )

    async def fake_resolve(url, log_func=None):
        if url == wrapper_url:
            return article_url
        if url == search_wrapper_url:
            return internal_search_url
        return url

    monkeypatch.setattr(browser_manager, "resolve_redirect_url", fake_resolve, raising=False)

    manager = BrowserManager(engine="sogou", max_results=3)
    results = asyncio.run(
        manager._postprocess_search_results(
            [
                {
                    "id": 1,
                    "title": "Python web框架fastapi中间件的使用及CORS跨域问题",
                    "url": wrapper_url,
                    "snippet": "allow_origins example",
                },
                {
                    "id": 2,
                    "title": "FastAPI CORSMiddleware allow_origins的更多内容_CSDN技术社区",
                    "url": search_wrapper_url,
                    "snippet": "more results",
                },
            ]
        )
    )

    assert len(results) == 1
    assert results[0]["id"] == 1
    assert results[0]["url"] == article_url


def test_search_result_postprocessing_skips_common_search_engine_internal_pages(monkeypatch):
    async def fake_resolve(url, log_func=None):
        return url

    monkeypatch.setattr(browser_manager, "resolve_redirect_url", fake_resolve, raising=False)

    manager = BrowserManager(engine="google", max_results=10)
    results = asyncio.run(
        manager._postprocess_search_results(
            [
                {
                    "id": 1,
                    "title": "Google Search",
                    "url": "https://www.google.com/search?q=FastAPI",
                    "snippet": "",
                },
                {
                    "id": 2,
                    "title": "Bing Search",
                    "url": "https://www.bing.com/search?q=FastAPI",
                    "snippet": "",
                },
                {
                    "id": 3,
                    "title": "DuckDuckGo Search",
                    "url": "https://duckduckgo.com/?q=FastAPI",
                    "snippet": "",
                },
                {
                    "id": 4,
                    "title": "Brave Search",
                    "url": "https://search.brave.com/search?q=FastAPI",
                    "snippet": "",
                },
                {
                    "id": 5,
                    "title": "FastAPI CORS",
                    "url": "https://fastapi.tiangolo.com/tutorial/cors/",
                    "snippet": "allow_origins controls allowed origins.",
                },
            ]
        )
    )

    assert len(results) == 1
    assert results[0]["id"] == 1
    assert results[0]["url"] == "https://fastapi.tiangolo.com/tutorial/cors/"


def test_search_engine_internal_page_detection_preserves_real_subdomain_results():
    assert is_search_engine_internal_page("https://www.google.com/search?q=FastAPI") is True
    assert is_search_engine_internal_page("https://developers.google.com/search?q=FastAPI") is False
    assert is_search_engine_internal_page("https://learn.microsoft.com/search/?terms=FastAPI") is False


def test_search_web_records_wait_selector_timeout_as_selector_failure(monkeypatch):
    # 桥接重构后 search_web 走 bridge + TabPool。用 fake bridge 桩掉:
    # - navigate 成功
    # - evaluate 永远返回 0(结果容器不存在)→ 走降级 → 也为空 → selector 失败
    class FakeTabPool:
        def __init__(self, client):
            pass

        async def acquire(self, session_id=None):
            return {"tab_id": 1}

        async def release(self, tab):
            pass

        async def close_all_pending(self, session_id=None):
            pass

    class FakeBridge:
        async def init(self, wait_timeout=0.0):
            return False

        async def navigate(self, tab_id, url, timeout_ms=20000):
            return {"tabId": tab_id, "url": url}

        async def scroll_by(self, *a, **k):
            pass

        async def evaluate(self, tab_id, js, timeout_ms=None):
            # 结果容器长度=0,降级提取也返回空列表。
            if "function(selectors" in js:
                return []
            if ".length" in js:
                return 0
            return []

        async def get_tab_url(self, tab_id):
            return "https://www.google.com/search?q=test"

    monkeypatch.setattr(browser_manager, "TabPool", FakeTabPool)
    monkeypatch.setattr(browser_manager, "get_bridge_client", lambda: FakeBridge())

    manager = BrowserManager(engine="google", max_results=3)

    assert asyncio.run(manager.search_web("FastAPI CORS")) == []


def test_search_web_returns_empty_when_bridge_extract_yields_nothing(monkeypatch):
    """After bridge redesign, captcha is handled in real Chrome; backend just extracts."""
    class FakeTabPool:
        def __init__(self, client):
            pass

        async def acquire(self, session_id=None):
            return {"tab_id": 1}

        async def release(self, tab):
            pass

        async def close_all_pending(self, session_id=None):
            pass

    class FakeBridge:
        async def init(self, wait_timeout=0.0):
            return False

        async def navigate(self, tab_id, url, timeout_ms=20000):
            return {"tabId": tab_id, "url": url}

        async def scroll_by(self, *a, **k):
            pass

        async def evaluate(self, tab_id, js, timeout_ms=None):
            # Wait-selector finds a container, but extract returns nothing
            # (e.g. captcha interstitial without result cards).
            if "function(selectors" in js:
                return []
            if ".length" in js:
                return 1
            return []

        async def get_tab_url(self, tab_id):
            return "https://search.brave.com/search?q=FastAPI"

    monkeypatch.setattr(browser_manager, "TabPool", FakeTabPool)
    monkeypatch.setattr(browser_manager, "get_bridge_client", lambda: FakeBridge())

    manager = BrowserManager(engine="brave", max_results=3)
    assert asyncio.run(manager.search_web("FastAPI CORS", use_cache=False)) == []


def test_search_web_with_session_extracts_results_via_bridge(monkeypatch):
    """Happy path: wait-selector + extract IIFE return results for a session."""
    class FakeTabPool:
        def __init__(self, client):
            pass

        async def acquire(self, session_id=None):
            assert session_id == "session-1"
            return {"tab_id": 1}

        async def release(self, tab):
            pass

        async def close_all_pending(self, session_id=None):
            pass

    class FakeBridge:
        async def init(self, wait_timeout=0.0):
            return False

        async def navigate(self, tab_id, url, timeout_ms=20000):
            return {"tabId": tab_id, "url": url}

        async def scroll_by(self, *a, **k):
            pass

        async def evaluate(self, tab_id, js, timeout_ms=None):
            if "function(selectors" in js:
                return [
                    {
                        "id": 1,
                        "title": "CORS (Cross-Origin Resource Sharing) - FastAPI",
                        "url": "https://fastapi.tiangolo.com/tutorial/cors/",
                        "snippet": "allow_origins controls allowed origins.",
                    }
                ]
            if ".length" in js:
                return 1
            return None

        async def get_tab_url(self, tab_id):
            return "https://search.brave.com/search?q=FastAPI"

    async def fake_resolve(url, log_func=None):
        return url

    logs = []
    monkeypatch.setattr(browser_manager, "TabPool", FakeTabPool)
    monkeypatch.setattr(browser_manager, "get_bridge_client", lambda: FakeBridge())
    monkeypatch.setattr(browser_manager, "resolve_redirect_url", fake_resolve)

    manager = BrowserManager(engine="brave", max_results=3)
    results = asyncio.run(
        manager.search_web(
            "FastAPI CORS",
            session_id="session-1",
            log_func=logs.append,
            use_cache=False,
        )
    )

    assert results[0]["title"] == "CORS (Cross-Origin Resource Sharing) - FastAPI"
    assert any("成功解析" in msg for msg in logs)


def test_search_web_navigate_failure_returns_empty(monkeypatch):
    class FakeTabPool:
        def __init__(self, client):
            pass

        async def acquire(self, session_id=None):
            return {"tab_id": 1}

        async def release(self, tab):
            pass

        async def close_all_pending(self, session_id=None):
            pass

    class FakeBridge:
        async def init(self, wait_timeout=0.0):
            return False

        async def navigate(self, tab_id, url, timeout_ms=20000):
            raise RuntimeError("navigation failed")

        async def scroll_by(self, *a, **k):
            pass

        async def evaluate(self, tab_id, js, timeout_ms=None):
            return None

        async def get_tab_url(self, tab_id):
            return "https://www.google.com/search?q=FastAPI%20CORS"

    monkeypatch.setattr(browser_manager, "TabPool", FakeTabPool)
    monkeypatch.setattr(browser_manager, "get_bridge_client", lambda: FakeBridge())

    manager = BrowserManager(engine="google", max_results=3)
    assert asyncio.run(manager.search_web("FastAPI CORS", use_cache=False)) == []


def test_search_web_cache_is_isolated_from_returned_results(monkeypatch):
    # 桥接重构后 search_web 走 bridge + TabPool。验证缓存隔离。
    class FakeTabPool:
        def __init__(self, client):
            pass

        async def acquire(self, session_id=None):
            return {"tab_id": 1}

        async def release(self, tab):
            pass

        async def close_all_pending(self, session_id=None):
            pass

    class FakeBridge:
        def __init__(self):
            self.loaded_urls = []

        async def init(self, wait_timeout=0.0):
            return False

        async def navigate(self, tab_id, url, timeout_ms=20000):
            self.loaded_urls.append(url)
            return {"tabId": tab_id, "url": url}

        async def scroll_by(self, *a, **k):
            pass

        async def evaluate(self, tab_id, js, timeout_ms=None):
            # 提取 IIFE 以 (function(selectors 开头;wait-selector 探针只是 querySelectorAll(...).length。
            # 必须先判 IIFE,因为 IIFE 内部也含 .length。
            if "function(selectors" in js:
                return [
                    {
                        "id": 1,
                        "title": "Original cached title",
                        "url": "https://example.com/original",
                        "snippet": "cache isolation",
                    }
                ]
            if ".length" in js:
                return 1
            return None

        async def get_tab_url(self, tab_id):
            return "https://www.google.com/search?q=cache%20isolation&num=5&hl=en"

    async def fake_resolve(url, log_func=None):
        return url

    browser_manager._search_cache.clear()

    fake_bridge = FakeBridge()
    monkeypatch.setattr(browser_manager, "TabPool", FakeTabPool)
    monkeypatch.setattr(browser_manager, "get_bridge_client", lambda: fake_bridge)
    monkeypatch.setattr(browser_manager, "resolve_redirect_url", fake_resolve)
    monkeypatch.setattr(browser_manager.random, "uniform", lambda *_args: 0)

    manager = BrowserManager(engine="google", max_results=3)

    first = asyncio.run(manager.search_web("cache isolation"))
    first[0]["title"] = "Mutated by caller"

    second = asyncio.run(manager.search_web("cache isolation"))

    assert second[0]["title"] == "Original cached title"
    assert fake_bridge.loaded_urls == [
        "https://www.google.com/search?q=cache%20isolation&num=5&hl=en"
    ]


def test_search_web_check_preferred_engine_without_cache(monkeypatch):
    # 桥接重构后 search_web 走 bridge + TabPool，验证偏好引擎的完整搜索流程。
    class FakeTabPool:
        def __init__(self, client):
            pass

        async def acquire(self, session_id=None):
            return {"tab_id": 1}

        async def release(self, tab):
            pass

        async def close_all_pending(self, session_id=None):
            pass

    class FakeBridge:
        def __init__(self):
            self.loaded_urls = []

        async def init(self, wait_timeout=0.0):
            return False

        async def navigate(self, tab_id, url, timeout_ms=20000):
            self.loaded_urls.append(url)
            return {"tabId": tab_id, "url": url}

        async def scroll_by(self, *a, **k):
            pass

        async def evaluate(self, tab_id, js, timeout_ms=None):
            # 提取 IIFE 以 (function(selectors 开头;wait-selector 探针只是 querySelectorAll(...).length。
            # 必须先判 IIFE,因为 IIFE 内部也含 .length。
            if "function(selectors" in js:
                return [
                    {
                        "id": 1,
                        "title": "JustSearch",
                        "url": "https://example.com/justsearch",
                        "snippet": "test result",
                    }
                ]
            if ".length" in js:
                return 1
            return None

        async def get_tab_url(self, tab_id):
            return "https://search.brave.com/search?q=JustSearch%20test"

    async def fake_resolve(url, log_func=None):
        return url

    browser_manager._search_cache.clear()

    fake_bridge = FakeBridge()
    monkeypatch.setattr(browser_manager, "TabPool", FakeTabPool)
    monkeypatch.setattr(browser_manager, "get_bridge_client", lambda: fake_bridge)
    monkeypatch.setattr(browser_manager, "resolve_redirect_url", fake_resolve)
    monkeypatch.setattr(browser_manager.random, "uniform", lambda *_args: 0)

    manager = BrowserManager(engine="brave", max_results=3)

    results = asyncio.run(
        manager.search_web(
            "JustSearch test",
            use_cache=False,
        )
    )

    assert results[0]["title"] == "JustSearch"
    assert fake_bridge.loaded_urls == ["https://search.brave.com/search?q=JustSearch%20test"]
    assert "brave:JustSearch test" not in browser_manager._search_cache




def test_search_selector_hot_reload_keeps_last_good_config_on_bad_json(monkeypatch, tmp_path):
    config_path = tmp_path / "search_selectors.json"
    config_path.write_text(
        """
        {
            "google": {
                "base_url": "https://google.example/search?q={query}",
                "selectors": {
                    "result_container": [".result"],
                    "title": "h3",
                    "link": "a",
                    "snippet": ".snippet",
                    "date": ""
                },
                "captcha_check": [],
                "wait_selector": ".result"
            },
            "custom": {
                "base_url": "https://custom.example/search?q={query}",
                "selectors": {
                    "result_container": [".item"],
                    "title": "h2",
                    "link": "a",
                    "snippet": "p",
                    "date": ""
                },
                "captcha_check": [],
                "wait_selector": ".result"
            }
        }
        """,
        encoding="utf-8",
    )
    monkeypatch.setattr(search_engine, "__file__", str(tmp_path / "search_engine.py"))
    monkeypatch.setattr(search_engine, "_config_cache", {})
    monkeypatch.setattr(search_engine, "_config_mtime", 0.0)

    loaded = search_engine.load_selectors(None)
    assert loaded["custom"]["base_url"] == "https://custom.example/search?q={query}"

    config_path.write_text("{bad json", encoding="utf-8")
    monkeypatch.setattr(search_engine, "_config_mtime", -1)

    reloaded = search_engine.load_selectors(None)

    assert reloaded["custom"]["base_url"] == "https://custom.example/search?q={query}"
    assert search_engine.get_all_engines() == ["google", "custom"]


def test_search_selector_hot_reload_keeps_last_good_config_on_bad_shape(monkeypatch, tmp_path):
    config_path = tmp_path / "search_selectors.json"
    config_path.write_text(
        """
        {
            "google": {
                "base_url": "https://google.example/search?q={query}",
                "selectors": {
                    "result_container": ".result",
                    "title": "h3",
                    "link": "a",
                    "snippet": ".snippet"
                },
                "captcha_check": [],
                "wait_selector": ".result"
            },
            "custom": {
                "base_url": "https://custom.example/search?q={query}",
                "selectors": {
                    "result_container": [".item"],
                    "title": "h2",
                    "link": "a",
                    "snippet": "p"
                },
                "captcha_check": [],
                "wait_selector": ".item"
            }
        }
        """,
        encoding="utf-8",
    )
    monkeypatch.setattr(search_engine, "__file__", str(tmp_path / "search_engine.py"))
    monkeypatch.setattr(search_engine, "_config_cache", {})
    monkeypatch.setattr(search_engine, "_config_mtime", 0.0)

    loaded = search_engine.load_selectors(None)
    assert loaded["custom"]["base_url"] == "https://custom.example/search?q={query}"

    config_path.write_text(
        """
        {
            "broken": {
                "base_url": "https://broken.example/search?q={query}",
                "selectors": {
                    "result_container": []
                },
                "captcha_check": [],
                "wait_selector": ""
            }
        }
        """,
        encoding="utf-8",
    )
    monkeypatch.setattr(search_engine, "_config_mtime", -1)

    reloaded = search_engine.load_selectors(None)

    assert reloaded["custom"]["base_url"] == "https://custom.example/search?q={query}"
    assert search_engine.get_all_engines() == ["google", "custom"]


def test_search_selector_loader_skips_invalid_engines(monkeypatch, tmp_path):
    config_path = tmp_path / "search_selectors.json"
    config_path.write_text(
        """
        {
            "broken": {
                "base_url": "",
                "selectors": {},
                "captcha_check": [],
                "wait_selector": ".result"
            },
            "custom": {
                "base_url": "https://custom.example/search?q={query}",
                "selectors": {
                    "result_container": ".item",
                    "title": "h2",
                    "link": "a",
                    "snippet": "p"
                },
                "captcha_check": "captcha",
                "wait_selector": ".item"
            }
        }
        """,
        encoding="utf-8",
    )
    monkeypatch.setattr(search_engine, "__file__", str(tmp_path / "search_engine.py"))
    monkeypatch.setattr(search_engine, "_config_cache", {})
    monkeypatch.setattr(search_engine, "_config_mtime", 0.0)

    loaded = search_engine.load_selectors(None)

    assert list(loaded.keys()) == ["custom"]
    assert loaded["custom"]["selectors"]["result_container"] == [".item"]
    # captcha_check is ignored after bridge redesign (solved in real Chrome).
    assert "captcha_check" not in loaded["custom"]
    assert loaded["custom"]["wait_selector"] == ".item"


def test_workflow_records_failed_searches_as_empty(monkeypatch):
    async def raises_error(*_args, **_kwargs):
        raise RuntimeError("search engine exploded")

    workflow = SearchWorkflow(
        api_key="test",
        base_url="https://example.test/v1",
        model="test-model",
        search_engine="brave",
        max_results=3,
    )
    workflow.browser.search_web = raises_error

    sources, counter, result_count = asyncio.run(
        workflow._handle_search(
            ["FastAPI CORS", "FastAPI CORSMiddleware"],
            [],
            set(),
            1,
            lambda _msg: None,
            "FastAPI CORS",
            0,
        )
    )

    assert sources == []
    assert counter == 0
    assert result_count == 0


def test_workflow_skips_crawl_when_no_results_are_relevant():
    class FakeLLM:
        async def assess_relevance(self, _query, _snippets):
            return []

    class FakeBrowser:
        engine = "google"
        engine_config = {"google": {}}

        async def search_web(self, *_args, **_kwargs):
            return [
                {
                    "id": 1,
                    "title": "Unrelated cooking tips",
                    "url": "https://example.com/cooking",
                    "snippet": "Pasta sauces and dinner ideas.",
                }
            ]

        async def crawl_page(self, *_args, **_kwargs):
            raise AssertionError("irrelevant search results should not be crawled")

    workflow = SearchWorkflow(
        api_key="test",
        base_url="https://example.test/v1",
        model="test-model",
        search_engine="google",
        max_results=3,
    )
    workflow.llm = FakeLLM()
    workflow.browser = FakeBrowser()

    sources, counter, result_count = asyncio.run(
        workflow._handle_search(
            ["FastAPI CORS official docs"],
            [],
            set(),
            1,
            lambda _msg: None,
            "FastAPI CORS official docs",
            0,
        )
    )

    assert sources == []
    assert counter == 0
    assert result_count == 1


def test_workflow_crawl_batch_keeps_successful_pages_when_one_fails():
    class FakeBrowser:
        async def crawl_page(self, url, **_kwargs):
            if url == "https://example.com/bad":
                raise RuntimeError("boom")
            return f"content for {url}"

    workflow = SearchWorkflow(
        api_key="test",
        base_url="https://example.test/v1",
        model="test-model",
        search_engine="google",
        max_results=3,
    )
    workflow.browser = FakeBrowser()
    progress = []

    sources, counter = asyncio.run(
        workflow._crawl_and_collect(
            [
                {"id": 1, "title": "Good", "url": "https://example.com/good"},
                {"id": 2, "title": "Bad", "url": "https://example.com/bad"},
            ],
            set(),
            progress.append,
            "query",
            0,
        )
    )

    assert counter == 1
    assert sources == [
        {
            "id": 1,
            "title": "Good",
            "url": "https://example.com/good",
            "date": "",
            "content": "content for https://example.com/good",
        }
    ]
    assert any("跳过爬取异常页面" in item for item in progress)


def test_workflow_source_ids_do_not_skip_failed_pages():
    class FakeBrowser:
        async def crawl_page(self, url, **_kwargs):
            if url.endswith("/empty"):
                return ""
            return f"content for {url}"

    workflow = SearchWorkflow(
        api_key="test",
        base_url="https://example.test/v1",
        model="test-model",
        search_engine="google",
        max_results=3,
    )
    workflow.browser = FakeBrowser()

    sources, counter = asyncio.run(
        workflow._crawl_and_collect(
            [
                {"id": 1, "title": "Empty", "url": "https://example.com/empty"},
                {"id": 2, "title": "Good", "url": "https://example.com/good"},
            ],
            set(),
            lambda _msg: None,
            "query",
            0,
        )
    )

    assert counter == 1
    assert [source["id"] for source in sources] == [1]


def test_workflow_skips_crawler_error_strings():
    class FakeBrowser:
        async def crawl_page(self, *_args, **_kwargs):
            return "爬取页面时出错: boom"

    workflow = SearchWorkflow(
        api_key="test",
        base_url="https://example.test/v1",
        model="test-model",
        search_engine="google",
        max_results=3,
    )
    workflow.browser = FakeBrowser()
    progress = []

    sources, counter = asyncio.run(
        workflow._crawl_and_collect(
            [
                {"id": 1, "title": "Broken", "url": "https://example.com/broken"},
            ],
            set(),
            progress.append,
            "query",
            0,
        )
    )

    assert sources == []
    assert counter == 0
    assert workflow._content_cache == {}
    assert any("跳过无效页面" in item for item in progress)


def test_workflow_direct_url_skips_blocked_private_error():
    class FakeBrowser:
        async def crawl_page(self, *_args, **_kwargs):
            return "错误: 不允许访问内网地址"

    workflow = SearchWorkflow(
        api_key="test",
        base_url="https://example.test/v1",
        model="test-model",
        search_engine="google",
        max_results=3,
    )
    workflow.browser = FakeBrowser()
    progress = []

    sources, counter = asyncio.run(
        workflow._handle_direct_url(
            "http://127.0.0.1/admin",
            set(),
            progress.append,
            "query",
            0,
        )
    )

    assert sources == []
    assert counter == 0
    assert any("跳过无效页面" in item for item in progress)


def test_workflow_decodes_bing_redirect_with_following_query_params():
    target_url = "https://Example.com/Docs?A=1"
    encoded_target = base64.urlsafe_b64encode(target_url.encode("utf-8")).decode("ascii").rstrip("=")
    bing_url = f"https://www.bing.com/ck/a?u=a1{encoded_target}&ntb=1"
    workflow = SearchWorkflow(
        api_key="test",
        base_url="https://example.test/v1",
        model="test-model",
        search_engine="google",
        max_results=3,
    )

    assert workflow._resolve_url(bing_url) == target_url
    assert workflow._normalize_url(bing_url) == "https://example.com/docs?a=1"


def test_workflow_deduplicates_visited_urls_after_normalization():
    class FakeLLM:
        async def assess_relevance(self, _query, _snippets):
            return [1, 2]

    class FakeBrowser:
        engine = "google"
        engine_config = {"google": {}}

        async def search_web(self, *_args, **_kwargs):
            return [
                {
                    "id": 1,
                    "title": "Tracked",
                    "url": "https://example.com/page?utm_source=newsletter",
                    "snippet": "tracked",
                },
                {
                    "id": 2,
                    "title": "Canonical",
                    "url": "https://example.com/page",
                    "snippet": "canonical",
                },
            ]

        async def crawl_page(self, *_args, **_kwargs):
            raise AssertionError("already visited canonical URL should not be crawled")

    workflow = SearchWorkflow(
        api_key="test",
        base_url="https://example.test/v1",
        model="test-model",
        search_engine="google",
        max_results=3,
    )
    workflow.llm = FakeLLM()
    workflow.browser = FakeBrowser()

    sources, counter, result_count = asyncio.run(
        workflow._handle_search(
            ["example page"],
            [],
            {"https://example.com/page"},
            1,
            lambda _msg: None,
            "example page",
            0,
        )
    )

    assert sources == []
    assert counter == 0
    assert result_count == 1


def test_workflow_routes_llm_calls_to_configured_step_clients():
    calls = []

    class AnalysisLLM:
        async def analyze_task(self, _query, _history):
            calls.append("analysis")
            return {"type": "search", "queries": ["FastAPI middleware"]}

    class AnswerLLM:
        total_prompt_tokens = 11
        total_completion_tokens = 7

        async def generate_answer(self, _query, _sources, _history, _stream_callback, canvas_mode=False, live_artifacts_mode=False):
            calls.append("answer")
            return {"status": "sufficient", "answer": "done"}

    workflow = SearchWorkflow(
        api_key="test",
        base_url="https://example.test/v1",
        model="fallback-model",
        search_engine="google",
        max_results=3,
    )
    workflow.step_llms["analysis"] = AnalysisLLM()
    workflow.step_llms["answer"] = AnswerLLM()

    async def fake_handle_search(*_args, **_kwargs):
        return (
            [
                {
                    "id": 1,
                    "title": "FastAPI",
                    "url": "https://example.com/fastapi",
                    "content": "FastAPI middleware reference.",
                }
            ],
            1,
            1,
        )

    workflow._handle_search = fake_handle_search
    stats = {}

    result = asyncio.run(
        workflow.run(
            "FastAPI middleware",
            lambda _msg: None,
            None,
            [],
            None,
            lambda data: stats.update(data),
        )
    )

    assert "done" in result
    assert calls == ["analysis", "answer"]
    assert stats["prompt_tokens"] == 11
    assert stats["completion_tokens"] == 7


def test_workflow_does_not_append_markdown_references_to_live_artifacts():
    class AnalysisLLM:
        async def analyze_task(self, _query, _history):
            return {"type": "search", "queries": ["Live Artifacts"]}

    class AnswerLLM:
        total_prompt_tokens = 2
        total_completion_tokens = 3

        async def generate_answer(
            self,
            _query,
            _sources,
            _history,
            _stream_callback,
            canvas_mode=False,
            live_artifacts_mode=False,
        ):
            assert live_artifacts_mode is True
            return {
                "status": "sufficient",
                "answer": '<section style="display:block;width:100%;box-sizing:border-box;max-width:100%;overflow-wrap:anywhere;"><h2>Live</h2><p>引用 [1]</p></section>',
            }

    workflow = SearchWorkflow(
        api_key="test",
        base_url="https://example.test/v1",
        model="fallback-model",
        search_engine="google",
        max_results=3,
        live_artifacts_mode=True,
    )
    workflow.step_llms["analysis"] = AnalysisLLM()
    workflow.step_llms["answer"] = AnswerLLM()

    async def fake_handle_search(*_args, **_kwargs):
        return (
            [
                {
                    "id": 1,
                    "title": "Live Artifacts source",
                    "url": "https://example.com/live-artifacts",
                    "content": "Live Artifacts source content.",
                }
            ],
            1,
            1,
        )

    workflow._handle_search = fake_handle_search

    result = asyncio.run(
        workflow.run(
            "Live Artifacts",
            lambda _msg: None,
            None,
            [],
            None,
            lambda _data: None,
        )
    )

    assert result.startswith("<section")
    assert "### 参考资料" not in result
    assert "\n\n---" not in result


def test_workflow_keeps_partial_live_artifact_answers_in_artifact_format():
    class AnalysisLLM:
        async def analyze_task(self, _query, _history):
            return {"type": "search", "queries": ["Live Artifacts partial"]}

    class AnswerLLM:
        total_prompt_tokens = 2
        total_completion_tokens = 3

        async def generate_answer(
            self,
            _query,
            _sources,
            _history,
            _stream_callback,
            canvas_mode=False,
            live_artifacts_mode=False,
        ):
            assert live_artifacts_mode is True
            return {
                "status": "insufficient",
                "missing_info": "缺少第二个独立来源",
                "answer": "## 临时结论\n- 已找到一个来源 [1]",
            }

    workflow = SearchWorkflow(
        api_key="test",
        base_url="https://example.test/v1",
        model="fallback-model",
        search_engine="google",
        max_results=3,
        max_iterations=1,
        live_artifacts_mode=True,
    )
    workflow.step_llms["analysis"] = AnalysisLLM()
    workflow.step_llms["answer"] = AnswerLLM()

    async def fake_handle_search(*_args, **_kwargs):
        return (
            [
                {
                    "id": 1,
                    "title": "Live Artifacts source",
                    "url": "https://example.com/live-artifacts",
                    "content": "Live Artifacts source content.",
                }
            ],
            1,
            1,
        )

    workflow._handle_search = fake_handle_search

    result = asyncio.run(
        workflow.run(
            "Live Artifacts partial",
            lambda _msg: None,
            None,
            [],
            None,
            lambda _data: None,
        )
    )

    assert 'data-justsearch-partial-banner="true"' in result
    assert "<section" in result
    assert "临时结论" in result
    assert "### 参考资料" not in result
    assert "\n\n---" not in result


def test_workflow_returns_partial_answer_after_exhausting_iterations():
    class AnalysisLLM:
        async def analyze_task(self, _query, _history):
            return {"type": "search", "queries": ["FastAPI CORS 是什么"]}

    class AnswerLLM:
        total_prompt_tokens = 3
        total_completion_tokens = 5

        async def generate_answer(self, _query, _sources, _history, _stream_callback, canvas_mode=False, live_artifacts_mode=False):
            return {
                "status": "insufficient",
                "missing_info": "缺少官方示例细节",
                "answer": "FastAPI 的 Depends 用于依赖注入。",
            }

    workflow = SearchWorkflow(
        api_key="test",
        base_url="https://example.test/v1",
        model="fallback-model",
        search_engine="google",
        max_results=3,
    )
    workflow.step_llms["analysis"] = AnalysisLLM()
    workflow.step_llms["answer"] = AnswerLLM()

    async def fake_handle_search(*_args, **_kwargs):
        return (
            [
                {
                    "id": 1,
                    "title": "FastAPI docs",
                    "url": "https://docs.example.org/",
                    "content": "FastAPI dependency injection with Depends().",
                }
            ],
            1,
            1,
        )

    workflow._handle_search = fake_handle_search
    progress = []
    stats = {}

    result = asyncio.run(
        workflow.run(
            "FastAPI CORS 是什么",
            progress.append,
            None,
            [],
            None,
            lambda data: stats.update(data),
        )
    )

    assert "无法确认资料足够完整" in result
    assert "FastAPI 的 Depends 用于依赖注入。" in result
    assert "多次尝试后未能生成有效答案" not in result
    assert "[FastAPI docs](https://docs.example.org/)" in result
    assert any("已达到最大迭代次数" in item for item in progress)
    assert stats["iterations"] == 6
    assert stats["prompt_tokens"] == 3
    assert stats["completion_tokens"] == 5


def test_workflow_uses_resolved_query_for_search_and_answer():
    """Follow-up turns must drive relevance/answer with decontextualized intent."""
    captured = {"search_query": None, "answer_query": None, "search_queries": None}

    class AnalysisLLM:
        async def analyze_task(self, _query, _history):
            return {
                "type": "search",
                "resolved_query": "梅西阿根廷世界杯半决赛对阵英格兰开球时间北京时间",
                "queries": ["梅西 阿根廷 英格兰 半决赛 开球时间"],
                "entities": ["梅西", "阿根廷", "英格兰"],
                "is_followup": True,
                "topic_changed": False,
            }

    class AnswerLLM:
        total_prompt_tokens = 1
        total_completion_tokens = 1

        async def generate_answer(
            self,
            query,
            _sources,
            _history,
            _stream_callback,
            canvas_mode=False,
            live_artifacts_mode=False,
        ):
            captured["answer_query"] = query
            return {"status": "sufficient", "answer": "开球时间待官方确认。"}

    workflow = SearchWorkflow(
        api_key="test",
        base_url="https://example.test/v1",
        model="fallback-model",
        search_engine="google",
        max_results=3,
    )
    workflow.step_llms["analysis"] = AnalysisLLM()
    workflow.step_llms["answer"] = AnswerLLM()

    async def fake_handle_search(search_queries, search_history, visited_urls, iteration,
                                 progress_callback, user_input, source_id_counter):
        captured["search_queries"] = list(search_queries)
        captured["search_query"] = user_input
        return (
            [
                {
                    "id": 1,
                    "title": "World Cup semi",
                    "url": "https://example.com/wc",
                    "content": "Argentina vs England kickoff TBD.",
                }
            ],
            1,
            1,
        )

    workflow._handle_search = fake_handle_search
    progress = []

    result = asyncio.run(
        workflow.run(
            "具体时间是什么时候？国内时间是什么时候？",
            progress.append,
            None,
            [
                {"role": "user", "content": "梅西的下一场比赛是什么时候？"},
                {"role": "assistant", "content": "阿根廷对阵英格兰半决赛。"},
            ],
            None,
            None,
        )
    )

    assert "开球时间" in result or "待官方确认" in result
    assert captured["search_query"] and "梅西" in captured["search_query"]
    assert captured["answer_query"] and "梅西" in captured["answer_query"]
    assert any("梅西" in q or "阿根廷" in q for q in (captured["search_queries"] or []))
    assert any("上下文改写" in msg for msg in progress)


def test_run_interactive_mode_passes_tab_id_to_evaluate_and_clicks():
    """Regression: BridgeClient.evaluate requires (tab_id, expression).

    Interactive mode used to call evaluate(expression) without tab_id, which
    raised TypeError and silently disabled all click-to-expand behavior.
    """
    logs = []
    evaluate_calls = []
    click_calls = []
    move_calls = []

    class FakeBridge:
        async def evaluate(self, tab_id, expression, timeout_ms=None):
            evaluate_calls.append({
                "tab_id": tab_id,
                "expression": expression,
                "timeout_ms": timeout_ms,
            })
            # Must receive an int/str tab id, not a JS blob.
            assert not isinstance(tab_id, str) or not tab_id.strip().startswith("(")
            assert isinstance(expression, str) and "js-interact" in expression
            return [
                {
                    "id": "js-interact-0",
                    "text": "Read more",
                    "tag": "button",
                    "x": 120.0,
                    "y": 340.0,
                },
                {
                    "id": "js-interact-1",
                    "text": "Share",
                    "tag": "button",
                    "x": 200.0,
                    "y": 400.0,
                },
            ]

        async def move_mouse(self, tab_id, x, y, **kwargs):
            move_calls.append({"tab_id": tab_id, "x": x, "y": y, **kwargs})

        async def click_at(self, tab_id, x, y):
            click_calls.append({"tab_id": tab_id, "x": x, "y": y})

    class FakeLLM:
        async def decide_click_elements(self, query, elements):
            assert query == "expand article details"
            assert elements[0]["id"] == "js-interact-0"
            return ["js-interact-0"]

    asyncio.run(
        page_crawler.run_interactive_mode(
            FakeBridge(),
            tab_id=42,
            query="expand article details",
            llm_client=FakeLLM(),
            log_func=logs.append,
            session_id="test-session",
            turn_id="test-turn",
        )
    )

    assert evaluate_calls, "evaluate must be called"
    assert evaluate_calls[0]["tab_id"] == 42
    assert isinstance(evaluate_calls[0]["expression"], str)
    assert click_calls == [{"tab_id": 42, "x": 120.0, "y": 340.0}]
    assert move_calls and move_calls[0]["tab_id"] == 42
    assert any("提取到 2 个候选元素" in msg for msg in logs)
    assert any("已点击元素 js-interact-0" in msg for msg in logs)


def test_run_interactive_mode_handles_non_list_evaluate_result():
    class FakeBridge:
        async def evaluate(self, tab_id, expression, timeout_ms=None):
            assert tab_id == 7
            return None  # bridge glitch / non-list return

        async def move_mouse(self, *a, **k):
            raise AssertionError("should not move")

        async def click_at(self, *a, **k):
            raise AssertionError("should not click")

    class FakeLLM:
        async def decide_click_elements(self, query, elements):
            raise AssertionError("should not ask LLM with empty elements")

    logs = []
    asyncio.run(
        page_crawler.run_interactive_mode(
            FakeBridge(),
            tab_id=7,
            query="anything",
            llm_client=FakeLLM(),
            log_func=logs.append,
        )
    )
    assert any("未找到显著的可交互元素" in msg for msg in logs)


def test_extract_github_repo_stats_passes_tab_id_to_evaluate():
    """Same missing-tab_id bug existed in GitHub repo star extraction."""
    evaluate_calls = []

    class FakeBridge:
        async def evaluate(self, tab_id, expression, timeout_ms=None):
            evaluate_calls.append((tab_id, expression[:40], timeout_ms))
            if "user-repositories-list" in expression:
                return True
            return {
                "totalStars": 42,
                "repos": [{"name": "demo", "stars": 42}],
                "count": 1,
            }

    result = asyncio.run(
        page_crawler.extract_github_repo_stats(FakeBridge(), tab_id=9, url="https://github.com/demo")
    )
    assert result is not None
    assert "42" in result
    assert all(call[0] == 9 for call in evaluate_calls)
    assert len(evaluate_calls) >= 2


def test_is_spa_like_url_detects_official_hosts():
    assert crawler_content.is_spa_like_url("https://openai.com/index/introducing-gpt-5/") is True
    assert crawler_content.is_spa_like_url("https://www.anthropic.com/news/claude-opus-4-8") is True
    assert crawler_content.is_spa_like_url("https://blog.rust-lang.org/2026/07/09/Rust-1.97.0/") is True
    assert crawler_content.is_spa_like_url("https://fastapi.tiangolo.com/tutorial/dependencies/") is True
    assert crawler_content.is_spa_like_url("https://example.com/plain-html-page") is False


def test_coerce_extract_result_accepts_legacy_string_and_dict():
    from backend.app.crawler.content import _coerce_extract_result

    legacy = _coerce_extract_result("hello world content here")
    assert legacy["text"].startswith("hello")
    assert legacy["useful"] > 0

    rich = _coerce_extract_result({"text": "abc  def", "strategy": "scored:main", "useful": 6})
    assert rich["strategy"] == "scored:main"
    assert rich["useful"] == 6

    empty = _coerce_extract_result(None)
    assert empty["text"] == ""
    assert empty["useful"] == 0


def test_extract_page_content_retries_when_first_pass_is_thin():
    """SPA shells often return tiny chrome first; extractor must retry then succeed."""
    calls = {"n": 0}
    logs = []

    class FakeBridge:
        async def evaluate(self, tab_id, expression, timeout_ms=None):
            assert tab_id == 3
            # scroll helpers
            if "scrollTo" in expression:
                return None
            calls["n"] += 1
            # first primary extract: thin shell
            if calls["n"] == 1 and "HOST_SELECTORS" in expression:
                return {"text": "Menu Login", "strategy": "cleaned-body", "useful": 9}
            # second primary extract after wait: real body
            if "HOST_SELECTORS" in expression:
                body = (
                    "Introducing GPT-5. " * 40
                    + "Released on August 7, 2025. Official OpenAI announcement. "
                    * 20
                )
                return {"text": body, "strategy": "host-selector:main", "useful": len(body.replace(" ", ""))}
            return {"text": "", "strategy": "structured-fallback", "useful": 0}

    text = asyncio.run(
        crawler_content.extract_page_content(
            FakeBridge(),
            tab_id=3,
            url="https://openai.com/index/introducing-gpt-5/",
            log_func=logs.append,
        )
    )
    assert "GPT-5" in text
    assert calls["n"] >= 2
    assert any("正文偏少" in msg or "SPA" in msg or "客户端渲染" in msg for msg in logs)


def test_extract_page_content_uses_structured_fallback_when_dom_stays_thin():
    class FakeBridge:
        async def evaluate(self, tab_id, expression, timeout_ms=None):
            if "scrollTo" in expression:
                return None
            if "structured-fallback" in expression or "application/ld+json" in expression or "JSON-LD" in expression or "@graph" in expression or "__NEXT_DATA__" in expression:
                article = "Claude Opus 4.8 was released on May 28, 2026. " * 30
                return {
                    "text": "标题: Introducing Claude Opus 4.8\n\n" + article,
                    "strategy": "structured-fallback",
                    "useful": 400,
                }
            # primary always thin
            return {"text": "Nav Home", "strategy": "cleaned-body", "useful": 7}

    text = asyncio.run(
        crawler_content.extract_page_content(
            FakeBridge(),
            tab_id=1,
            url="https://www.anthropic.com/news/claude-opus-4-8",
            log_func=None,
        )
    )
    assert "Opus 4.8" in text
    assert "May 28, 2026" in text or "2026" in text


def test_extract_page_content_prefers_defuddle_markdown():
    """Defuddle (extract_content) is the primary path when available."""
    logs = []
    evaluate_calls = {"n": 0}

    rich_md = (
        "# Introducing GPT-5\n\n"
        + "OpenAI released GPT-5 with major improvements. " * 40
    )

    class FakeBridge:
        async def extract_content(self, tab_id, timeout_ms=None):
            assert tab_id == 7
            return {
                "ok": True,
                "text": rich_md,
                "strategy": "defuddle",
                "useful": len(re.sub(r"\s+", "", rich_md)),
                "title": "Introducing GPT-5",
            }

        async def evaluate(self, tab_id, expression, timeout_ms=None):
            evaluate_calls["n"] += 1
            if "scrollTo" in expression:
                return None
            raise AssertionError("legacy evaluate path should not run when Defuddle succeeds")

    text = asyncio.run(
        crawler_content.extract_page_content(
            FakeBridge(),
            tab_id=7,
            url="https://example.com/posts/gpt-5",  # non-SPA path → no pre-scroll evaluate
            log_func=logs.append,
        )
    )
    assert "GPT-5" in text
    assert "OpenAI released" in text
    assert any("Defuddle" in msg for msg in logs)
    assert evaluate_calls["n"] == 0


def test_extract_page_content_falls_back_when_defuddle_thin():
    """Thin Defuddle result should fall through to legacy host-selector / density path."""
    body = ("Full article body with enough characters for the threshold. " * 20)

    class FakeBridge:
        async def extract_content(self, tab_id, timeout_ms=None):
            return {
                "ok": True,
                "text": "Hi",
                "strategy": "defuddle",
                "useful": 2,
                "title": "Thin",
            }

        async def evaluate(self, tab_id, expression, timeout_ms=None):
            if "scrollTo" in expression:
                return None
            if "HOST_SELECTORS" in expression:
                return {
                    "text": body,
                    "strategy": "host-selector:main",
                    "useful": len(re.sub(r"\s+", "", body)),
                }
            return {"text": "", "strategy": "structured-fallback", "useful": 0}

    text = asyncio.run(
        crawler_content.extract_page_content(
            FakeBridge(),
            tab_id=2,
            url="https://example.com/post",
            log_func=None,
        )
    )
    assert "Full article body" in text


def test_extract_page_content_falls_back_when_extract_content_missing():
    """Older bridges without extract_content still use legacy JS extractors."""
    body = ("Legacy extraction still works without Defuddle bridge method. " * 15)

    class FakeBridge:
        async def evaluate(self, tab_id, expression, timeout_ms=None):
            if "scrollTo" in expression:
                return None
            if "HOST_SELECTORS" in expression:
                return {
                    "text": body,
                    "strategy": "scored:main",
                    "useful": len(re.sub(r"\s+", "", body)),
                }
            return {"text": "", "strategy": "none", "useful": 0}

    text = asyncio.run(
        crawler_content.extract_page_content(
            FakeBridge(),
            tab_id=4,
            url="https://example.com/legacy",
            log_func=None,
        )
    )
    assert "Legacy extraction" in text


def test_js_extract_script_keeps_download_link_resolution():
    """Hygiene / regression: download link absolute href logic must remain."""
    src = crawler_content._JS_EXTRACT_CONTENT
    assert "const rawHref = a.getAttribute('href')" in src
    assert "const href = a.href || rawHref" in src
    assert "HOST_SELECTORS" in src
    assert "openai" in src
    assert "anthropic" in src
