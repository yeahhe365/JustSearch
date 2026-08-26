import asyncio
import json
import logging
import os
import time
from typing import List, Dict, Callable, Any, Optional
from .llm_client import LLMClient, ensure_live_artifact_answer
from .browser_manager import BrowserManager
from .providers import WORKFLOW_MODEL_STEP_IDS
from .crawler.redirects import decode_bing_redirect_url

logger = logging.getLogger(__name__)

class SearchWorkflow:
    # canvas_mode is a deprecated alias for live_artifacts_mode (kept for API
    # contract compatibility; the web frontend stopped sending it).
    def __init__(self, api_key: str, base_url: str, model: str, search_engine: str = "google", max_results: int = 50, max_iterations: int = 5, interactive_search: bool = True, session_id: str = None, step_model_configs: Optional[dict] = None, live_artifacts_mode: bool = False, canvas_mode: Optional[bool] = None, history_options: Optional[dict] = None):
        self.llm = LLMClient(api_key, base_url, model, **(history_options or {}))
        self.step_llms = self._build_step_llms(
            step_model_configs or {},
            api_key,
            base_url,
            model,
            history_options or {},
        )
        # Pass the search engine preference to the browser manager
        self.browser = BrowserManager(engine=search_engine, max_results=max_results)
        self.max_iterations = max_iterations
        self.interactive_search = interactive_search
        self.session_id = session_id
        if canvas_mode:
            import warnings
            warnings.warn("canvas_mode deprecated, use live_artifacts_mode", DeprecationWarning, stacklevel=2)
            logger.warning("[Workflow] canvas_mode deprecated")
        self.live_artifacts_mode = bool(live_artifacts_mode or canvas_mode)
        # Content cache: url -> content (avoid re-crawling same URL across iterations)
        self._content_cache: Dict[str, str] = {}
        # Minimum content length to be considered useful (chars)
        self._min_content_length = 150

    def _is_invalid_crawl_content(self, content: Any) -> bool:
        if not isinstance(content, str):
            return True
        stripped = content.strip()
        if not stripped or stripped == "[CRAWL_TIMEOUT]":
            return True
        return stripped.startswith(("错误:", "爬取页面时出错:"))

    def _build_step_llms(
        self,
        step_model_configs: dict,
        default_api_key: str,
        default_base_url: str,
        default_model: str,
        history_options: Optional[dict] = None,
    ) -> dict:
        client_cache = {
            (default_api_key, default_base_url, default_model): self.llm
        }
        clients = {}
        hist_opts = history_options or {}
        for step_id in WORKFLOW_MODEL_STEP_IDS:
            config = step_model_configs.get(step_id) if isinstance(step_model_configs, dict) else None
            api_key = str((config or {}).get("api_key") or default_api_key)
            base_url = str((config or {}).get("base_url") or default_base_url)
            model = str((config or {}).get("model") or default_model)
            cache_key = (api_key, base_url, model)
            if cache_key not in client_cache:
                client_cache[cache_key] = LLMClient(
                    api_key,
                    base_url,
                    model,
                    **hist_opts,
                )
            clients[step_id] = client_cache[cache_key]
        return clients

    def _llm_for_step(self, step_id: str):
        client = self.step_llms.get(step_id)
        return client or self.llm

    def _usage_totals(self) -> tuple[int, int]:
        seen = set()
        prompt_tokens = 0
        completion_tokens = 0
        for client in [self.llm, *self.step_llms.values()]:
            ident = id(client)
            if ident in seen:
                continue
            seen.add(ident)
            prompt_tokens += getattr(client, "total_prompt_tokens", 0) or 0
            completion_tokens += getattr(client, "total_completion_tokens", 0) or 0
        return prompt_tokens, completion_tokens

    async def aclose(self) -> None:
        """关闭所有步骤 LLM 客户端（共享实例只关一次），释放底层连接池。"""
        seen = set()
        for client in [self.llm, *self.step_llms.values()]:
            if id(client) in seen:
                continue
            seen.add(id(client))
            aclose = getattr(client, "aclose", None)
            if aclose is None:
                continue
            try:
                await aclose()
            except Exception as e:
                logger.warning("[Workflow] 关闭 LLM 客户端失败: %s", e)

    @staticmethod
    def _lowercase_scheme_and_netloc(url: str) -> str:
        """仅小写 scheme 与 netloc；path/query/fragment 保留原大小写。

        整体 lower() 会把大小写敏感的不同路径（如 /PageA 与 /pagea）错误地
        合并成同一个去重键。
        """
        try:
            from urllib.parse import urlparse, urlunparse
            parsed = urlparse(url)
            return urlunparse(
                parsed._replace(scheme=parsed.scheme.lower(), netloc=parsed.netloc.lower())
            )
        except Exception:
            return url.lower()

    def _normalize_url(self, url: str) -> str:
        """规范化 URL 用于去重。处理 Bing redirect URL 等特殊格式。"""
        if not url:
            return ''
        # 提取 Bing redirect URL 中的真实目标
        # （既有测试锚定该分支保持整体小写的旧去重语义，故不改动）
        decoded_bing_url = decode_bing_redirect_url(url)
        if decoded_bing_url:
            return decoded_bing_url.lower().rstrip('/')
        # Strip common tracking parameters
        try:
            from urllib.parse import urlparse, urlunparse, parse_qs, urlencode
            parsed = urlparse(url)
            if parsed.query:
                params = parse_qs(parsed.query, keep_blank_values=True)
                # Remove known tracking params
                # Remove known tracking params + normalize mobile URLs
                tracking_keys = {'utm_source', 'utm_medium', 'utm_campaign', 'utm_term',
                                 'utm_content', 'fbclid', 'gclid', 'msclkid', 'ref', 'source',
                                 'share_token', 'is_shared', 's_bm', 'spm', 'from', 'bd_vid',
                                 'wvr', 'mod', 'lang', 'sudaref', 'isa', '_ent', 'vtype',
                                 'is_from_webapp', 'timestamp', 'share_wrap'}
                cleaned = {k: v for k, v in params.items() if k.lower() not in tracking_keys}
                new_query = urlencode(cleaned, doseq=True)
                # Normalize mobile URLs (m.example.com -> example.com for dedup)
                hostname = parsed.hostname or ''
                if hostname.startswith('m.'):
                    hostname = hostname[2:]
                url = urlunparse(parsed._replace(query=new_query, netloc=hostname if hostname != parsed.hostname else parsed.netloc))
        except Exception:
            pass
        # 通用规范化：去尾斜杠；scheme/netloc 小写，path/query 保留原大小写
        return self._lowercase_scheme_and_netloc(url).rstrip('/')

    def _resolve_url(self, url: str) -> str:
        """将 Bing redirect URL 解析为真实目标 URL（用于显示）。"""
        if not url:
            return url
        decoded_bing_url = decode_bing_redirect_url(url)
        if decoded_bing_url:
            return decoded_bing_url
        return url

    def _format_references(self, answer: str, sources: List[Dict]) -> str:
        """
        Helper to append a formatted reference list to the answer.
        """
        if not sources:
            return answer
        
        # Deduplicate by id — dict comprehension keeps last occurrence
        unique_sources = {src['id']: src for src in sources}
        sorted_sources = sorted(unique_sources.values(), key=lambda x: x['id'])
        
        ref_section = "\n\n---\n### 参考资料\n"
        for src in sorted_sources:
            title = src.get('title', 'Unknown Source').replace('\n', ' ').strip()
            url = self._resolve_url(src.get('url', '#'))
            date = src.get('date', '')
            date_str = f" ({date})" if date else ""
            ref_section += f"[{src['id']}] [{title}]({url}){date_str}  \n" 
            
        return answer + ref_section

    def _format_partial_answer(self, answer: str, sources: List[Dict], reason: str) -> str:
        answer = (answer or "").strip()
        if not answer:
            return ""

        prefix = (
            f"⚠️ {reason}，以下是基于已收集资料整理的临时答案，可能仍不完整。\n\n"
        )
        return self._format_references(prefix + answer, sources)

    def _format_live_artifact_partial_answer(self, answer: str, reason: str) -> str:
        """Wrap a partial Live Artifact with an HTML banner — never plain-text-prefix HTML.

        Prepending Chinese warning text to a raw HTML artifact used to force
        ``ensure_live_artifact_answer`` down the Markdown path, which HTML-escaped
        every tag and showed source markup in the chat bubble.
        """
        answer = (answer or "").strip()
        if not answer:
            return ""

        body = ensure_live_artifact_answer(answer)
        if not body:
            return ""

        # Escape only the reason string; body is already trusted HTML from ensure_*.
        reason_safe = (
            str(reason or "")
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace('"', "&quot;")
        )
        banner = (
            '<div role="note" data-justsearch-partial-banner="true" '
            'style="margin:0 0 0.75rem 0;padding:0.65rem 0.85rem;'
            "border-left:3px solid var(--amc-live-artifact-accent,#f59e0b);"
            "background:var(--amc-live-artifact-surface,transparent);"
            "color:var(--amc-live-artifact-muted,inherit);font-size:0.92em;"
            'line-height:1.45;overflow-wrap:anywhere;">'
            f"⚠️ {reason_safe}，以下是基于已收集资料整理的临时答案，可能仍不完整。"
            "</div>"
        )
        return (
            '<div style="display:block;width:100%;box-sizing:border-box;'
            'max-width:100%;overflow-wrap:anywhere;background:transparent;">'
            f"{banner}{body}</div>"
        )

    async def _handle_direct_url(self, url: str, visited_urls: set,
                                  progress_callback: Callable[[str], None],
                                  user_input: str, source_id_counter: int) -> tuple:
        """处理直接 URL 访问，返回 (new_sources, source_id_counter)。"""
        progress_callback(f"目标 URL: {url}")
        
        new_sources = []
        visit_key = self._normalize_url(url)
        if visit_key not in visited_urls:
            content = await self.browser.crawl_page(url, log_func=progress_callback, interactive_mode=self.interactive_search, query=user_input, llm_client=self._llm_for_step("interaction"), session_id=self.session_id)
            visited_urls.add(visit_key)
            # 过滤超时/空内容
            if self._is_invalid_crawl_content(content):
                progress_callback(f"跳过无效页面: {url}")
                return [], source_id_counter
            source_id_counter += 1
            new_sources.append({
                "id": source_id_counter, 
                "url": url, 
                "title": "Direct URL", 
                "content": content
            })
        else:
            progress_callback(f"URL 已访问过，跳过: {url}")
        
        return new_sources, source_id_counter

    async def _handle_search(self, search_queries: list, search_history: list,
                              visited_urls: set, iteration: int,
                              progress_callback: Callable[[str], None],
                              user_input: str, source_id_counter: int) -> tuple:
        """处理搜索引擎查询，返回 (new_sources, source_id_counter, search_results_count)。"""
        # Deduplicate normalized queries
        valid_queries = []
        history_norm = {q.strip().lower() for q in search_history}
        for q in search_queries:
            norm = q.strip().lower()
            if norm not in history_norm:
                valid_queries.append(q)
                search_history.append(q)
                history_norm.add(norm)
        
        # If all were duplicates (e.g. Iter 2 suggests same query), allow at least one if it's new to this batch?
        # 防御式保留：search_history 理论上可为空。
        if not valid_queries and iteration == 1 and search_queries:
             valid_queries = [search_queries[0]]

        search_results = []
        if valid_queries:
            progress_callback(f"阶段 II: 在 {self.browser.engine.capitalize()} 上搜索: {', '.join(valid_queries)}...")
            logger.info("[Workflow] 搜索引擎: %s, 查询: %s", self.browser.engine, valid_queries)

            search_tasks = [
                self.browser.search_web(
                    q,
                    log_func=progress_callback,
                    session_id=self.session_id if self.interactive_search else None,
                )
                for q in valid_queries
            ]

            # Wait for all searches with total timeout; individual failures return [].
            try:
                results_list = await asyncio.wait_for(
                    asyncio.gather(*search_tasks, return_exceptions=True), timeout=90
                )
            except asyncio.TimeoutError:
                logger.warning("[Workflow] 搜索总超时(90s)，取消剩余任务")
                for t in search_tasks:
                    if not t.done():
                        t.cancel()
                results_list = [[] for _ in search_tasks]
            
            # Handle exceptions from individual searches
            processed_results = []
            for i, result in enumerate(results_list):
                if isinstance(result, asyncio.CancelledError):
                    raise result
                if isinstance(result, BaseException) and not isinstance(result, Exception):
                    raise result
                if isinstance(result, Exception):
                    logger.warning("[Workflow] 搜索查询 %d 失败: %s", i, result)
                    processed_results.append([])
                elif isinstance(result, list):
                    processed_results.append(result)
                else:
                    processed_results.append([])
            results_list = processed_results
            
            # Flatten, deduplicate and reindex results
            current_id = 1
            seen_result_urls = set()  # 用规范化后的 URL 去重
            for batch in results_list:
                for res in batch:
                    normalized = self._normalize_url(res.get('url', ''))
                    if normalized in seen_result_urls:
                        continue
                    seen_result_urls.add(normalized)
                    new_res = res.copy()
                    new_res['id'] = current_id
                    search_results.append(new_res)
                    current_id += 1
        else:
            if iteration > 1:
                progress_callback("警告: 模型建议的所有查询都已尝试过。")

        if not search_results:
            progress_callback("未找到搜索结果。")
            return [], source_id_counter, 0

        progress_callback(f"找到 {len(search_results)} 个结果。正在评估相关性...")
        progress_callback("正在调用 AI 评估搜索结果的相关性...")
        
        # [04] Relevance Assessment
        try:
            relevant_ids = await asyncio.wait_for(
                self._llm_for_step("relevance").assess_relevance(user_input, search_results),
                timeout=30,
            )
        except Exception as e:
            logger.warning("[Workflow] 相关性评估失败，降级取前3: %s", e)
            relevant_ids = [r['id'] for r in search_results[:3]]
        progress_callback(f"选定进行深度爬取的 ID: {relevant_ids}")

        relevant_id_set = set()
        for item_id in relevant_ids:
            try:
                relevant_id_set.add(int(item_id))
            except (TypeError, ValueError):
                continue

        valid_result_ids = {res['id'] for res in search_results}
        if not relevant_id_set.intersection(valid_result_ids):
            logger.warning("[Workflow] 相关性评估返回空/非法 id %s，降级取前3未访问", relevant_ids)
            # 降级：取前3未访问
            fallback = [r for r in search_results if self._normalize_url(r.get('url','')) not in visited_urls][:3]
            if fallback:
                relevant_id_set = {r['id'] for r in fallback}
            else:
                progress_callback("相关性评估未选中可用结果，跳过偏题搜索结果。")
                return [], source_id_counter, len(search_results)
        
        # [05] Admission Filter — 优先未访问的 URL，如果都访问过则选次优结果
        to_crawl = []
        seen_urls_in_batch = set()
        already_visited = []

        for res in search_results:
            if res['id'] in relevant_id_set:
                normalized_url = self._normalize_url(res.get('url', ''))
                if normalized_url not in visited_urls and normalized_url not in seen_urls_in_batch:
                    to_crawl.append(res)
                    seen_urls_in_batch.add(normalized_url)
                elif normalized_url in visited_urls:
                    already_visited.append(res)
        
        # 如果所有相关结果都已访问，从未访问的非相关结果中补充
        if not to_crawl:
            # 先尝试已访问的 URL 对应的搜索结果页面中是否有其他候选
            for res in search_results:
                normalized_url = self._normalize_url(res.get('url', ''))
                if normalized_url not in visited_urls and normalized_url not in seen_urls_in_batch and res['id'] not in relevant_id_set:
                    to_crawl.append(res)
                    seen_urls_in_batch.add(normalized_url)
                    if len(to_crawl) >= 3:
                        break
        
        # [06] Deep Crawling
        if not to_crawl:
            progress_callback("未找到新的相关页面进行爬取 (可能已访问过)。")
            return [], source_id_counter, len(search_results)

        sources, counter = await self._crawl_and_collect(to_crawl, visited_urls, progress_callback,
                                              user_input, source_id_counter)
        return sources, counter, len(search_results)

    async def _crawl_and_collect(self, to_crawl: list, visited_urls: set,
                                   progress_callback: Callable[[str], None],
                                   user_input: str, source_id_counter: int) -> tuple:
        """批量爬取页面并收集结果，返回 (new_sources, source_id_counter)。支持内容缓存。"""
        progress_callback(f"正在并行爬取 {len(to_crawl)} 个页面...")
        for item in to_crawl:
            logger.info("[Workflow] 爬取: %s", item.get('url', '?')[:100])
            progress_callback(f"  → {item.get('title', item.get('url', '?'))[:60]}")

        # Separate cached vs uncached
        cached_contents: Dict[int, str] = {}
        uncached_items: list = []
        uncached_indices: list = []

        for i, item in enumerate(to_crawl):
            cache_key = self._normalize_url(item.get('url', ''))
            cached = self._content_cache.get(cache_key)
            if cached:
                cached_contents[i] = cached
                progress_callback(f"  ✓ 使用缓存: {item.get('title', '?')[:50]}")
            else:
                uncached_items.append(item)
                uncached_indices.append(i)

        # Crawl uncached pages with bounded concurrency (debugger/CDP chokes when
        # many tabs run interactive Input events at once). Default 2.
        if uncached_items:
            try:
                crawl_limit = max(1, int(os.environ.get("JUSTSEARCH_CRAWL_CONCURRENCY", "2")))
            except (ValueError, TypeError):
                crawl_limit = 2
            sem = asyncio.Semaphore(crawl_limit)

            async def _crawl_one(item):
                async with sem:
                    return await self.browser.crawl_page(
                        item['url'],
                        log_func=progress_callback,
                        interactive_mode=self.interactive_search,
                        query=user_input,
                        llm_client=self._llm_for_step("interaction"),
                        session_id=self.session_id,
                    )

            try:
                contents = await asyncio.wait_for(
                    asyncio.gather(
                        *[_crawl_one(item) for item in uncached_items],
                        return_exceptions=True,
                    ),
                    timeout=120,
                )
            except asyncio.TimeoutError:
                logger.warning("[Workflow] 爬取总超时(120s)")
                contents = ["" for _ in uncached_items]
            # Cache results
            for content, orig_idx, item in zip(contents, uncached_indices, uncached_items):
                if isinstance(content, BaseException) and not isinstance(content, Exception):
                    raise content
                if isinstance(content, Exception):
                    if isinstance(content, asyncio.CancelledError):
                        raise content
                    logger.warning("[Workflow] 爬取页面异常: %s: %s", item.get('url', '')[:80], content)
                    progress_callback(f"跳过爬取异常页面: {item.get('url', '')}")
                    cached_contents[orig_idx] = ""
                    continue
                cached_contents[orig_idx] = content
                if not self._is_invalid_crawl_content(content):
                    self._content_cache[self._normalize_url(item.get('url', ''))] = content

        new_sources = []
        for i, item in enumerate(to_crawl):
            visited_urls.add(self._normalize_url(item.get('url', '')))
            content = cached_contents.get(i, "")
            content_len = len(content) if isinstance(content, str) else 0
            # 过滤超时/空内容
            if self._is_invalid_crawl_content(content):
                logger.warning("[Workflow] 跳过无效页面: %s (len=%d)", item['url'][:80], content_len)
                progress_callback(f"跳过无效页面: {item['url']}")
                continue
            logger.info("[Workflow] 爬取成功: %s (len=%d)", item['url'][:80], content_len)
            # [07] Structure Data
            source_id_counter += 1
            new_sources.append({
                "id": source_id_counter,
                "title": item['title'],
                "url": item['url'],
                "date": item.get('date', ''),
                "content": content
            })

        return new_sources, source_id_counter

    async def verify_citation_claims(
        self,
        items: list[dict[str, Any]],
        *,
        timeout: float = 6.0,
    ) -> dict[str, dict[str, Any]]:
        """Run one bounded semantic verification batch using the answer-step model.

        The router owns fail-open behavior; this method deliberately exposes no
        private client internals and requires no fifth provider/model setting.
        """
        client = self._llm_for_step("answer")
        return await client.verify_citation_claims(items, timeout=timeout)

    async def run(self, user_input: str, progress_callback: Callable[[str], None], stream_callback: Optional[Callable[[str], None]] = None, history: Optional[List[Dict[str, str]]] = None, source_callback: Optional[Callable[[List[Dict]], None]] = None, stats_callback: Optional[Callable[[Dict], None]] = None) -> str:
        """
        Executes the JustSearch Workflow with iterative refinement.
        """
        iteration = 0
        accumulated_sources = []
        visited_urls = set()
        search_history = []
        last_feedback = "" 
        last_partial_answer = ""
        source_id_counter = 0
        total_search_results = 0
        start_time = time.monotonic()
        # Decontextualized intent used for relevance / crawl / answer (Phase-1 multi-turn).
        resolved_query = (user_input or "").strip()
        analysis_entities: list = []
            
        while iteration < self.max_iterations:
            iteration += 1
            if iteration == 1:
                progress_callback(f"🔍 第 1 轮搜索 — 阶段 I: 分析问题...")
            else:
                progress_callback(f"🔄 第 {iteration}/{self.max_iterations} 轮补充搜索 — 分析缺失信息...")
            logger.info("[Workflow] === 迭代 %d/%d 开始 ===", iteration, self.max_iterations)
            logger.info("[Workflow] 用户输入: %s", user_input[:100])

            # [02] Task Analysis
            if iteration == 1:
                analysis_input = user_input
            else:
                entity_hint = f"\nKnown entities from prior analysis: {analysis_entities}" if analysis_entities else ""
                analysis_input = (
                    f"Original User Question: {resolved_query or user_input}\n"
                    f"Raw latest user message: {user_input}\n"
                    f"Previous Search Queries Tried: {search_history}\n"
                    f"Reason previous results were insufficient: {last_feedback}\n"
                    f"{entity_hint}\n"
                    f"Task: Generate a NEW, different self-contained search query (or specific URL) "
                    f"to find the missing information. Keep the same topic/entities unless the user changed topic."
                )

            try:
                analysis = await asyncio.wait_for(
                    self._llm_for_step("analysis").analyze_task(analysis_input, history), timeout=30
                )
            except Exception as e:
                logger.warning("[Workflow] 任务分析失败，降级直接搜索: %s", e)
                analysis = {"type": "search", "queries": [resolved_query or user_input]}
            logger.info("[Workflow] 任务分析结果: type=%s, data=%s", analysis.get("type", ""), json.dumps(analysis, ensure_ascii=False)[:150])

            if analysis.get("type") != "direct":
                candidate_resolved = str(analysis.get("resolved_query") or "").strip()
                if candidate_resolved:
                    resolved_query = candidate_resolved
                elif analysis.get("queries"):
                    resolved_query = str(analysis["queries"][0]).strip() or resolved_query
                analysis_entities = list(analysis.get("entities") or analysis_entities or [])
                if analysis.get("is_followup") and resolved_query != user_input:
                    progress_callback(f"上下文改写: {resolved_query[:120]}")
                logger.info(
                    "[Workflow] resolved_query=%s entities=%s followup=%s",
                    resolved_query[:120],
                    analysis_entities,
                    analysis.get("is_followup"),
                )

            new_sources = []

            if analysis.get("type") == "direct":
                url = analysis.get("url")
                new_sources, source_id_counter = await self._handle_direct_url(
                    url, visited_urls, progress_callback, resolved_query or user_input, source_id_counter
                )
            else:
                search_queries = analysis.get("queries", [])
                # Fallback for single query or if model returns old format
                if not search_queries and analysis.get("query"):
                    search_queries = [analysis.get("query")]
                if not search_queries and resolved_query:
                    search_queries = [resolved_query]

                new_sources, source_id_counter, search_count = await self._handle_search(
                    search_queries, search_history, visited_urls, iteration,
                    progress_callback, resolved_query or user_input, source_id_counter
                )
                total_search_results += search_count
                
            accumulated_sources.extend(new_sources)
                
            # Adaptive iteration: if we have very little content, allow one extra iteration
            total_content_length = sum(len(s.get('content', '')) for s in accumulated_sources)
            if total_content_length < 500 and self.max_iterations < 6:
                self.max_iterations += 1
                progress_callback(f"信息量不足 ({total_content_length} 字符)，自动增加一轮搜索...")
                
            if not accumulated_sources:
                progress_callback("目前尚未收集到有效信息，尝试下一次迭代...")
                last_feedback = "No valid sources found yet."
                continue

            # [09] Generation & Evaluation
            progress_callback(f"阶段 III: 使用累计 {len(accumulated_sources)} 个来源生成答案...")
            progress_callback("正在调用 AI 模型生成回答...")
                
            if source_callback:
                source_callback(accumulated_sources)
                
            # Use decontextualized question so generation stays on-topic for follow-ups.
            answer_query = resolved_query or user_input
            try:
                result = await self._llm_for_step("answer").generate_answer(
                    answer_query,
                    accumulated_sources,
                    history,
                    stream_callback,
                    live_artifacts_mode=self.live_artifacts_mode,
                )
            except Exception as e:
                logger.error("[Workflow] 生成答案异常: %s", e, exc_info=True)
                if last_partial_answer:
                    # 返回已有部分答案而非直接抛错，前端可展示已搜资料
                    reason = f"生成失败: {type(e).__name__}"
                    final_answer = (
                        self._format_live_artifact_partial_answer(last_partial_answer, reason)
                        if self.live_artifacts_mode
                        else self._format_partial_answer(last_partial_answer, accumulated_sources, reason)
                    )
                    if stats_callback:
                        total_elapsed = time.monotonic() - start_time
                        prompt_tokens, completion_tokens = self._usage_totals()
                        stats_callback({
                            "sites_searched": total_search_results,
                            "sites_crawled": len(visited_urls),
                            "iterations": iteration,
                            "prompt_tokens": prompt_tokens,
                            "completion_tokens": completion_tokens,
                            "total_seconds": round(total_elapsed, 1),
                        })
                    return final_answer
                raise
                
            if result.get("status") == "sufficient":
                progress_callback("答案状态: 充分")
                final_answer = result.get("answer")
                if stats_callback:
                    total_elapsed = time.monotonic() - start_time
                    prompt_tokens, completion_tokens = self._usage_totals()
                    stats_callback({
                        "sites_searched": total_search_results,
                        "sites_crawled": len(visited_urls),
                        "iterations": iteration,
                        "prompt_tokens": prompt_tokens,
                        "completion_tokens": completion_tokens,
                        "total_seconds": round(total_elapsed, 1),
                    })
                if self.live_artifacts_mode:
                    return ensure_live_artifact_answer(final_answer)
                return self._format_references(final_answer, accumulated_sources)
            elif result.get("status") == "error":
                # A hard generation failure (timeout / corrupt stream / provider
                # error). Do NOT treat it as an insufficient partial and run
                # another search round, and do NOT render the exception text as a
                # normal answer — surface it to the caller so the UI shows the
                # error + retry affordance.
                raise RuntimeError(result.get("answer") or "生成答案失败")
            else:
                last_partial_answer = result.get("answer", "")
                last_feedback = result.get("missing_info") or last_partial_answer
                if iteration < self.max_iterations:
                    progress_callback(f"⚠️ 已有信息不足以完整回答，正在进行第 {iteration + 1} 轮深度搜索...")
                    # Include specific missing info in the feedback
                    missing = last_feedback[:200]
                    if missing:
                        progress_callback(f"缺失信息: {missing}")
                else:
                    progress_callback(f"已达到最大迭代次数 ({self.max_iterations})，正在整理现有结果...")
                    
                if iteration >= self.max_iterations:
                    reason = f"经过 {iteration} 次尝试后，仍无法确认资料足够完整"
                    final_answer = (
                        self._format_live_artifact_partial_answer(
                            last_partial_answer,
                            reason,
                        )
                        if self.live_artifacts_mode
                        else self._format_partial_answer(
                            last_partial_answer,
                            accumulated_sources,
                            reason,
                        )
                    )
                    if stats_callback:
                        prompt_tokens, completion_tokens = self._usage_totals()
                        stats_callback({
                            "sites_searched": total_search_results,
                            "sites_crawled": len(visited_urls),
                            "iterations": iteration,
                            "total_seconds": round(time.monotonic() - start_time, 1),
                            "prompt_tokens": prompt_tokens,
                            "completion_tokens": completion_tokens,
                        })
                    return final_answer

        # 循环正常退出只发生在"从未收集到任何来源"时（其余路径均在循环内
        # return / raise），此时 last_partial_answer 必为空，直接给出兜底提示。
        return "多次尝试后未能生成有效答案。建议您尝试：\n1. 换用不同的关键词重新提问\n2. 简化问题，分步骤提问\n3. 切换搜索引擎后重试"

    # 注意：这里刻意不 aclose()。run() 返回后调用方（chat 路由）还要用
    # answer 步骤的 LLM 客户端做引用语义验证；复用已关闭的连接池会直接
    # APIConnectionError（还会白烧一次可重试退避）。关闭责任在所有者——
    # chat 路由的 SSE 生成器退出时显式 await workflow.aclose()。
