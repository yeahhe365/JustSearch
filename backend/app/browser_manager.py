import asyncio
import copy
import json
import logging
import random
import time
import urllib.parse

from typing import Any, List, Dict

from .search_engine import load_selectors
from .llm_client import _truncate_for_log
from .crawler.redirects import resolve_redirect_url
from .page_crawler import crawl_page
from .search_result_cleanup import (
    clean_fallback_title,
    is_generic_search_aux_title,
    is_search_engine_internal_page,
)
from .extension_bridge import get_bridge_client, TabPool

# Simple search result cache: query -> (results, timestamp)
_search_cache: dict = {}
_SEARCH_CACHE_TTL = 300  # 5 minutes

logger = logging.getLogger(__name__)


def _clone_search_results(results: List[Dict]) -> List[Dict]:
    """Return an isolated copy so cached search results cannot be mutated by callers."""
    return copy.deepcopy(results)


def json_selector_arg(selector: str) -> str:
    """Serialize a CSS selector into a JS string literal for Runtime.evaluate."""
    return json.dumps(selector)


class BrowserManager:
    def __init__(self, engine: str = "google", max_results: int = 50):
        self.engine = engine
        self.max_results = max_results
        # Load full engine config for fallback support, and single-engine config for direct use
        self.engine_config = load_selectors(None)  # full config dict (all engines)
        self.current_engine_config = self.engine_config.get(engine, load_selectors(engine))

    def _search_cache_key(self, query: str) -> str:
        """Include max_results so different result limits do not share a cache entry."""
        return f"{self.engine}:{query}:{self.max_results}"

    async def search_web(
        self,
        query: str,
        log_func=None,
        session_id: str = None,
        use_cache: bool = True,
    ) -> List[Dict]:
        """
        Concurrent Web Search - scrapes search results for the query.
        """
        cache_key = self._search_cache_key(query)
        cached = _search_cache.get(cache_key) if use_cache else None
        if cached and time.time() - cached[1] < _SEARCH_CACHE_TTL:
            if log_func:
                log_func(f"浏览器: 使用缓存搜索结果: '{_truncate_for_log(query)}'")
            return _clone_search_results(cached[0])

        config = self.engine_config.get(self.engine, self.current_engine_config)

        bridge = get_bridge_client()
        tab_pool = TabPool(bridge)
        tab = await tab_pool.acquire(session_id=session_id)
        tab_id = tab["tab_id"]
        try:
            safe_query = _truncate_for_log(query)
            if log_func:
                log_func(f"浏览器: 正在前往 {self.engine.capitalize()} 搜索 '{safe_query}'...")

            delay = random.uniform(1.0, 2.0)
            await asyncio.sleep(delay)

            encoded_query = urllib.parse.quote(query)
            url = config["base_url"].format(query=encoded_query, num=self.max_results + 2)

            try:
                if log_func:
                    log_func(f"浏览器: 正在加载搜索页面...")
                await bridge.navigate(tab_id, url, timeout_ms=20000)
                if log_func:
                    log_func(f"浏览器: 搜索页面已加载，模拟用户行为...")
                try:
                    await bridge.scroll_by(tab_id, 0, random.randint(300, 800), x=400, y=300)
                    await asyncio.sleep(random.uniform(0.5, 1.5))
                    await bridge.evaluate(tab_id, "window.scrollBy(0, window.innerHeight / 2)")
                    await asyncio.sleep(random.uniform(0.5, 1.5))
                except Exception:
                    pass
            except Exception as e:
                if log_func:
                    log_func(f"浏览器: 搜索页面加载失败: {e}")
                return []

            # Wait for results container
            selector = config["wait_selector"]
            found = False
            for attempt in range(3):
                try:
                    count = await bridge.evaluate(
                        tab_id,
                        f"document.querySelectorAll({json_selector_arg(selector)}).length",
                        timeout_ms=3000,
                    )
                    if isinstance(count, int) and count > 0:
                        found = True
                        await asyncio.sleep(1.0)
                        break
                except Exception:
                    pass
                if attempt < 2:
                    await asyncio.sleep(2.0)

            if not found:
                msg = f"等待结果容器 ({selector}) 超时。"
                logger.warning(msg)
                if log_func:
                    log_func(f"浏览器错误: {msg}")
                    log_func("浏览器: 尝试使用降级文本提取搜索结果...")
                results = await self._fallback_text_extract(bridge, tab_id, query, log_func)
                results = await self._postprocess_search_results(results, log_func=log_func)
                if results:
                    if log_func:
                        log_func(f"浏览器: 成功解析 {len(results)} 个结果。")
                    if use_cache:
                        _search_cache[cache_key] = (_clone_search_results(results), time.time())
                    return results
                return []

            if log_func:
                log_func(f"浏览器: 正在解析结果...")

            # Extract results via bridge.evaluate — JS 字符串逐字保留。
            results = []
            selectors_json = json.dumps(config["selectors"])
            max_results = self.max_results
            extract_js = f"""(function(selectors, max_results) {{
                const results = [];
                let count = 0;
                const seenUrls = new Set();

                let elements = [];
                for (const sel of selectors.result_container) {{
                    const found = document.querySelectorAll(sel);
                    if (found && found.length > 0) {{
                        elements = Array.from(found);
                        break;
                    }}
                }}

                if (elements.length === 0) return results;

                function resolveLink(el, titleEl, linkSelector) {{
                    let linkEl = el.querySelector(linkSelector);
                    // Brave (and some engines): the title node itself is the <a>.
                    if ((!linkEl || !linkEl.href) && titleEl) {{
                        if (titleEl.tagName === 'A' && titleEl.href) {{
                            linkEl = titleEl;
                        }} else if (titleEl.closest) {{
                            const parentA = titleEl.closest('a[href]');
                            if (parentA) linkEl = parentA;
                        }}
                    }}
                    if ((!linkEl || !linkEl.href) && el.matches && el.matches('a[href]')) {{
                        linkEl = el;
                    }}
                    if ((!linkEl || !linkEl.href)) {{
                        const anyA = el.querySelector('a[href^="http"], a[href^="https"]');
                        if (anyA) linkEl = anyA;
                    }}
                    return linkEl;
                }}

                for (const el of elements) {{
                    if (count >= max_results) break;

                    const titleEl = el.querySelector(selectors.title);
                    const linkEl = resolveLink(el, titleEl, selectors.link);
                    const snippetEl = el.querySelector(selectors.snippet);
                    const dateEl = selectors.date ? el.querySelector(selectors.date) : null;

                    if (!titleEl || !linkEl) continue;

                    const title = (titleEl.innerText || titleEl.textContent || titleEl.getAttribute('title') || '').trim();
                    const url = linkEl.href || '';
                    if (!title || !url || !url.startsWith('http')) continue;
                    if (seenUrls.has(url)) continue;

                    let snippet = "";
                    let date = "";

                    if (dateEl) {{
                        date = (dateEl.innerText || '').trim();
                    }}

                    if (snippetEl) {{
                        snippet = (snippetEl.innerText || '').trim();
                    }} else {{
                        let text = el.innerText || '';
                        if (title && text.includes(title)) text = text.replace(title, "");
                        snippet = text.trim().substring(0, 200);
                    }}

                    if (!date && snippet) {{
                        const dateMatch = snippet.match(/^([a-zA-Z]{{3}} \\d{{1,2}}, \\d{{4}}|\\d{{1,2}} [a-zA-Z]{{3}} \\d{{4}}|\\d{{4}}年\\d{{1,2}}月\\d{{1,2}}日|\\d{{1,2}} hours? ago|\\d{{1,2}} days? ago|\\d+分钟前|\\d+小时前|\\d+天前|昨天|今天|\\d{{4}}-\\d{{1,2}}-\\d{{1,2}})/);
                        if (dateMatch) {{
                            date = dateMatch[0];
                        }}
                    }}

                    seenUrls.add(url);
                    count++;
                    results.push({{
                        id: count,
                        title: title,
                        url: url,
                        snippet: snippet,
                        date: date
                    }});
                }}
                return results;
}})({selectors_json}, {max_results});"""

            for attempt in range(3):
                try:
                    res = await bridge.evaluate(tab_id, extract_js, timeout_ms=15000)
                    results = res if isinstance(res, list) else []
                    break
                except Exception as e:
                    if attempt < 2:
                        if log_func:
                            log_func(f"浏览器: 解析重试 ({attempt+1}/3): {e}")
                        await asyncio.sleep(1.0)
                        continue
                    raise

            # 降级兜底:CSS 选择器解析无结果时,尝试从页面纯文本提取链接
            if not results:
                logger.info("CSS 选择器解析无结果，尝试降级文本提取...")
                results = await self._fallback_text_extract(bridge, tab_id, query, log_func)

            results = await self._postprocess_search_results(results, log_func=log_func)

            if log_func:
                log_func(f"浏览器: 成功解析 {len(results)} 个结果。")
            if results:
                if use_cache:
                    _search_cache[cache_key] = (_clone_search_results(results), time.time())
            else:
                logger.warning(f"搜索 '{query}' 无结果")
            return results
        except Exception as e:
            msg = f"搜索错误: {e}"
            logger.error(msg)
            if log_func:
                log_func(f"浏览器错误: {msg}")
            return []
        finally:
            await tab_pool.release(tab)
            await tab_pool.close_all_pending(session_id=session_id)

    async def _fallback_text_extract(self, bridge, tab_id: int, query: str, log_func=None) -> List[Dict]:
        """
        降级方案:当 CSS 选择器解析失败时,从页面纯文本 + 链接提取搜索结果。
        JS 字符串逐字保留,只是从 page.evaluate 改成 bridge.evaluate。
        """
        try:
            js = r"""(function(maxResults) {
                const results = [];
                const anchors = document.querySelectorAll('a[href^="http"]');
                function hostMatches(hostname, domain) {
                    return hostname === domain || hostname.endsWith('.' + domain);
                }

                function isSearchEngineUtilityUrl(href) {
                    try {
                        const parsed = new URL(href);
                        const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
                        if (hostMatches(host, 'google.com')) {
                            if (parsed.pathname === '/url') {
                                return !parsed.searchParams.has('url') && !parsed.searchParams.has('q');
                            }
                            return parsed.pathname === '/search';
                        }
                        if (hostMatches(host, 'bing.com')) {
                            return parsed.pathname === '/search';
                        }
                        if (hostMatches(host, 'duckduckgo.com')) {
                            if (parsed.pathname.startsWith('/l/')) {
                                return !parsed.searchParams.has('uddg');
                            }
                            return parsed.pathname === '/' && parsed.searchParams.has('q');
                        }
                        if (hostMatches(host, 'sogou.com')) {
                            return parsed.pathname === '/web';
                        }
                        if (hostMatches(host, 'baidu.com')) {
                            // 百度结果链接是 /link?url= 跳转格式,不是内部页 —— 保留
                            return parsed.pathname === '/s' || parsed.pathname === '/baidu';
                        }
                        if (hostMatches(host, 'yandex.com')) {
                            return parsed.pathname === '/search';
                        }
                    } catch (e) {
                        return true;
                    }
                    return false;
                }

                let count = 0;
                for (const a of anchors) {
                    if (count >= maxResults) break;
                    const href = a.href;
                    // 跳过搜索引擎自身的导航链接，但保留 developers.google.com 等合法结果
                    if (isSearchEngineUtilityUrl(href)) continue;
                    const title = (a.innerText || a.textContent || '').trim();
                    if (title.length < 5 || title.length > 200) continue;
                    // 获取附近的文本作为摘要
                    const parent = a.closest('div, article, li') || a.parentElement;
                    const snippet = parent ? parent.innerText.replace(title, '').trim().substring(0, 200) : '';
                    results.push({ title, url: href, snippet });
                    count++;
                }
                return results;
            })(""" + str(self.max_results) + ")"

            items = await bridge.evaluate(tab_id, js, timeout_ms=15000)
            if not isinstance(items, list):
                items = []

            # 给结果编号
            filtered_items = []
            for item in items:
                item['title'] = clean_fallback_title(item.get('title', ''), item.get('url', ''))
                if is_generic_search_aux_title(item['title']):
                    continue
                filtered_items.append(item)

            for i, item in enumerate(filtered_items):
                item['id'] = i + 1

            if filtered_items and log_func:
                log_func(f"浏览器: 降级文本提取到 {len(filtered_items)} 个结果。")
            return filtered_items
        except Exception as e:
            logger.warning("降级文本提取失败: %s", e)
            return []

    async def _postprocess_search_results(self, results: List[Dict], log_func=None) -> List[Dict]:
        """Resolve result-wrapper URLs and remove search-engine utility pages."""
        processed = []
        for item in results:
            url = item.get('url', '')
            if not url:
                continue

            resolved_url = await resolve_redirect_url(url, log_func=log_func)
            if is_search_engine_internal_page(resolved_url):
                continue

            new_item = item.copy()
            new_item['url'] = resolved_url
            processed.append(new_item)

        for i, item in enumerate(processed):
            item['id'] = i + 1

        return processed

    async def crawl_page(self, url: str, log_func=None, interactive_mode: bool = False,
                         query: str = None, llm_client=None, session_id: str = None) -> str:
        """Delegate to the page_crawler module."""
        return await crawl_page(
            url=url,
            log_func=log_func,
            interactive_mode=interactive_mode,
            query=query,
            llm_client=llm_client,
            session_id=session_id,
        )
