import asyncio
import json
import logging
import os
import re

from .crawler.content import (
    extract_og_metadata,
    extract_page_content,
    is_spa_like_url,
)
from .crawler.redirects import resolve_redirect_url
from .crawler.security import is_private_url
from .extension_bridge import get_bridge_client, TabPool

logger = logging.getLogger(__name__)

# PDF URL pattern
_PDF_PATTERN = re.compile(r'\.pdf(\?.*)?$', re.IGNORECASE)

# 虚拟光标 move_sequence 全局单调计数器(进程级)。扩展端用 (turn_id, move_sequence)
# 去重贝塞尔路径并上报到达。进程重启会重置,但扩展端按 turn 去重,无冲突。
_move_sequence_counter = 0


def next_move_seq() -> int:
    global _move_sequence_counter
    _move_sequence_counter += 1
    return _move_sequence_counter


def _format_pdf_metadata(url: str) -> str:
    return f"[PDF 文档] {url}\n注意: PDF 文件无法直接提取内容，请访问链接查看原文。"


async def crawl_github_api(bridge, tab_id: int, url: str, log_func=None) -> str | None:
    """Handle GitHub API URLs - parse JSON and return a summary."""
    if log_func:
        log_func("浏览器: 检测到 GitHub API 请求，正在优化数据...")
    try:
        await bridge.navigate(tab_id, url, timeout_ms=30000)
        # networkidle 在桥接里没有等价物;给 API 响应一点时间。
        await asyncio.sleep(2.0)
        json_content = await bridge.evaluate(tab_id, "document.body.innerText", timeout_ms=15000)
        if not isinstance(json_content, str):
            return None
        data = json.loads(json_content)
        if isinstance(data, list):
            summary = f"GitHub API Repository List Summary (First 30 items):\n"
            total_stars = 0
            for repo in data:
                name = repo.get("name", "Unknown")
                stars = repo.get("stargazers_count", 0)
                desc = repo.get("description", "")
                total_stars += stars
                summary += f"- {name}: {stars} stars ({desc})\n"

            summary += f"\nTotal stars in this page: {total_stars}\n"

            if len(data) == 30:
                summary += "WARNING: There are likely more repositories (pagination detected). This count is INCOMPLETE.\n"

            if log_func:
                log_func(f"浏览器: 成功解析 GitHub API 数据，当前页共 {total_stars} stars。")
            return summary
    except json.JSONDecodeError:
        pass
    except Exception as e:
        if log_func:
            log_func(f"浏览器: GitHub API 处理失败: {e}")
    return None


async def extract_github_repo_stats(bridge, tab_id: int, url: str, log_func=None) -> str | None:
    """Extract star counts from GitHub repository list pages."""
    try:
        # 等待选择器:轮询 querySelector,最多 5s。
        for _ in range(10):
            found = await bridge.evaluate(
                tab_id,
                'document.querySelector("#user-repositories-list") !== null',
                timeout_ms=3000,
            )
            if found:
                break
            await asyncio.sleep(0.5)

        repo_stats = await bridge.evaluate(tab_id, """(() => {
            let totalStars = 0;
            let repos = [];

            const items = document.querySelectorAll('li[itemprop="owns"], .source, .public');

            items.forEach(item => {
                const starLink = item.querySelector('a[href*="/stargazers"]');
                if (starLink) {
                    const text = starLink.innerText.trim().replace(/,/g, '');
                    const stars = parseInt(text);
                    if (!isNaN(stars)) {
                        totalStars += stars;
                        const nameEl = item.querySelector('a[itemprop="name codeRepository"], h3 a');
                        const name = nameEl ? nameEl.innerText.trim() : "Unknown";
                        repos.push({name, stars});
                    }
                }
            });

            return {totalStars, repos, count: repos.length};
        })()""", timeout_ms=15000)

        if repo_stats and repo_stats.get('count', 0) > 0:
            if log_func:
                log_func(f"浏览器: 页面内统计到 {repo_stats['count']} 个仓库，共 {repo_stats['totalStars']} stars。")

            prepend_text = f"--- AUTOMATED ANALYSIS ---\n"
            prepend_text += f"Total Stars visible on this page: {repo_stats['totalStars']}\n"
            prepend_text += f"Repository Count visible: {repo_stats['count']}\n"
            prepend_text += f"Top Repositories (First few):\n"
            for r in repo_stats['repos']:
                prepend_text += f"- {r['name']}: {r['stars']} stars\n"
            prepend_text += f"--------------------------\n\n"
            return prepend_text
        else:
            if log_func:
                log_func("浏览器: 未能在页面上提取到 Star 数据。")
    except Exception as e:
        if log_func:
            log_func(f"浏览器: GitHub 页面分析失败: {e}")
    return None


# Bounded concurrency for interactive clicks across concurrent crawls —
# debugger/CDP does not handle many tabs running Input events at once, so we cap
# global interactive crawls (default 2) instead of fully serializing them. This
# lets a few conversations crawl interactively in parallel while keeping CDP load
# sane. 可用 JUSTSEARCH_INTERACTIVE_CONCURRENCY 调整。
_INTERACTIVE_CONCURRENCY = max(
    1, int(os.getenv("JUSTSEARCH_INTERACTIVE_CONCURRENCY", "2"))
)
_interactive_sem = asyncio.Semaphore(_INTERACTIVE_CONCURRENCY)

# If main text is already long, skip click-to-expand (saves time + CDP stress).
_INTERACTIVE_SKIP_MIN_CHARS = 8000

INTERACTIVE_ELEMENTS_JS = r"""(() => {
    const items = [];
    let idCounter = 0;

    function isVisible(elem) {
        if (!elem.getBoundingClientRect || !elem.checkVisibility) return false;
        const rect = elem.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) return false;
        if (rect.bottom <= 0 || rect.right <= 0) return false;
        return elem.checkVisibility();
    }

    const candidates = document.querySelectorAll('button, a[href], [role="button"]');
    const blacklist = /^(home|login|sign in|sign up|menu|privacy|terms|登录|注册|分享|首页|关闭|评论|like|share|follow|subscribe|cookie|accept|dismiss|下载 app|open in app|get app|feedback|举报|投诉|more actions)$/i;
    const navPatterns = /^(back|next|previous|prev|1|2|3|4|5|6|7|8|9|10|first|last|<|>|<<|>>)$/i;
    const skipNoise = /^(skip to (main )?content|skip navigation|跳转到?内容|跳至(主)?内容|skip to main|跳过导航)$/i;

    for (const el of candidates) {
        if (!isVisible(el)) continue;
        const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
        if (text.length < 2 || text.length > 50) continue;
        if (blacklist.test(text)) continue;
        if (navPatterns.test(text)) continue;
        if (skipNoise.test(text)) continue;
        const href = (el.getAttribute && el.getAttribute('href')) || '';
        if (href === '#' || href === '#content' || href === '#bodyContent' || href === '#main') continue;
        const parent = el.closest('header, footer, nav, .navbar, .footer, .header, .sidebar, .nav-bar, #header, #footer, #nav');
        if (parent) continue;
        const rect = el.getBoundingClientRect();
        if (rect.x + rect.width / 2 < 4 && rect.y + rect.height / 2 < 4) continue;
        items.push({
            id: "js-interact-" + idCounter++,
            text: text,
            tag: el.tagName.toLowerCase(),
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
            w: rect.width,
            h: rect.height
        });
        if (items.length >= 30) break;
    }
    return items;
})()"""

# Scroll target into view, re-measure center, return {x,y,ok} or null
PREPARE_CLICK_JS_TMPL = r"""(() => {
    const wantId = %s;
    const wantText = %s;
    // Prefer matching by re-running selection heuristics and id order is unstable
    // after DOM changes — match by text + similar position first.
    const candidates = Array.from(document.querySelectorAll('button, a[href], [role="button"]'));
    let el = null;
    for (const c of candidates) {
        const t = (c.innerText || c.textContent || '').trim().replace(/\s+/g, ' ');
        if (t === wantText) { el = c; break; }
    }
    if (!el) return { ok: false, reason: 'not-found' };
    try {
        el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    } catch (e) {
        try { el.scrollIntoView(true); } catch (e2) {}
    }
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return { ok: false, reason: 'tiny' };
    return {
        ok: true,
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        w: rect.width,
        h: rect.height
    };
})()"""

DOM_CLICK_JS_TMPL = r"""(() => {
    const wantText = %s;
    const candidates = Array.from(document.querySelectorAll('button, a[href], [role="button"]'));
    for (const c of candidates) {
        const t = (c.innerText || c.textContent || '').trim().replace(/\s+/g, ' ');
        if (t !== wantText) continue;
        try {
            c.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        } catch (e) {}
        try {
            c.click();
            return { ok: true, method: 'click' };
        } catch (e) {
            try {
                c.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                return { ok: true, method: 'dispatch' };
            } catch (e2) {
                return { ok: false, reason: String(e2) };
            }
        }
    }
    return { ok: false, reason: 'not-found' };
})()"""


def _js_str(s: str) -> str:
    """JSON-encode a string for safe embedding in evaluate() expressions."""
    return json.dumps(s if s is not None else "")


async def run_interactive_mode(bridge, tab_id: int, query: str, llm_client, log_func=None,
                              session_id: str = "default", turn_id: str | None = None):
    """Run interactive mode: extract clickable elements and ask LLM what to click.

    session_id/turn_id 透传给虚拟光标,让扩展端按 turn 去重路径、归组标签。
    全局信号量限制同一时刻最多 _INTERACTIVE_CONCURRENCY 个 tab 做 CDP 点击,
    避免并行过多挂死;但仍允许多个对话并行交互爬取。
    """
    async with _interactive_sem:
        await _run_interactive_mode_locked(
            bridge, tab_id, query, llm_client, log_func, session_id, turn_id
        )


async def _run_interactive_mode_locked(
    bridge, tab_id: int, query: str, llm_client, log_func=None,
    session_id: str = "default", turn_id: str | None = None,
):
    crawl_session_id = session_id or "default"
    if turn_id is None:
        turn_id = f"{crawl_session_id}-{next_move_seq()}"

    # Skip when page already has substantial text (expand rarely helps enough).
    try:
        text_len = await bridge.evaluate(
            tab_id,
            r"""(() => {
                const t = (document.body && (document.body.innerText || '')) || '';
                return t.replace(/\s+/g, ' ').trim().length;
            })()""",
            timeout_ms=10000,
        )
        if isinstance(text_len, (int, float)) and text_len >= _INTERACTIVE_SKIP_MIN_CHARS:
            if log_func:
                log_func(
                    f"浏览器: 正文已约 {int(text_len)} 字符，跳过交互点击（阈值阈值 {_INTERACTIVE_SKIP_MIN_CHARS}）"
                )
            return
    except Exception:
        pass

    if log_func:
        log_func("浏览器: 交互模式已开启，正在提取可点击元素...")

    elements = await bridge.evaluate(tab_id, INTERACTIVE_ELEMENTS_JS, timeout_ms=15000)

    if not isinstance(elements, list):
        elements = []

    if not elements:
        if log_func:
            log_func("浏览器: 未找到显著的可交互元素。")
        return

    if log_func:
        log_func(f"浏览器: 提取到 {len(elements)} 个候选元素。请求 AI 决策...")

    clicked_ids = await llm_client.decide_click_elements(query, elements)

    if not clicked_ids:
        if log_func:
            log_func("浏览器: AI 决定不点击任何元素。")
        return

    if log_func:
        log_func(f"浏览器: AI 决定点击元素 ID: {clicked_ids}")

    meta_by_id = {el["id"]: el for el in elements if isinstance(el, dict) and el.get("id")}

    for cid in clicked_ids:
        el_meta = meta_by_id.get(cid)
        if not el_meta:
            continue
        want_text = (el_meta.get("text") or "").strip()
        x, y = el_meta.get("x"), el_meta.get("y")
        clicked = False
        move_seq = next_move_seq()

        for attempt in range(3):
            try:
                # Re-measure after scroll — coordinates from first pass go stale.
                if want_text:
                    prep = await bridge.evaluate(
                        tab_id,
                        PREPARE_CLICK_JS_TMPL % (_js_str(cid), _js_str(want_text)),
                        timeout_ms=10000,
                    )
                    if isinstance(prep, dict) and prep.get("ok"):
                        x, y = prep.get("x", x), prep.get("y", y)

                if x is None or y is None:
                    raise RuntimeError("no coordinates")

                await bridge.move_mouse(
                    tab_id, float(x), float(y),
                    session_id=crawl_session_id,
                    turn_id=turn_id,
                    move_sequence=move_seq,
                    wait_for_arrival=True,
                )
                await bridge.click_at(tab_id, float(x), float(y))
                if log_func:
                    log_func(f"浏览器: 已点击元素 {cid}")
                clicked = True
                await asyncio.sleep(1.0)
                break
            except Exception as e:
                # CDP path failed — try native DOM click as fallback
                if want_text:
                    try:
                        dom = await bridge.evaluate(
                            tab_id,
                            DOM_CLICK_JS_TMPL % _js_str(want_text),
                            timeout_ms=10000,
                        )
                        if isinstance(dom, dict) and dom.get("ok"):
                            if log_func:
                                log_func(f"浏览器: 已点击元素 {cid}（DOM 兜底）")
                            clicked = True
                            await asyncio.sleep(1.0)
                            break
                    except Exception:
                        pass

                if attempt < 2:
                    if log_func:
                        log_func(f"浏览器: 点击 {cid} 失败 (重试 {attempt+1}/3): {e}")
                    await asyncio.sleep(0.5 * (attempt + 1))
                else:
                    if log_func:
                        log_func(f"浏览器: 点击元素 {cid} 最终失败: {e}")

        if clicked:
            await asyncio.sleep(1.0)


async def crawl_page(url: str, log_func=None,
                     interactive_mode: bool = False, query: str = None,
                     llm_client=None, session_id: str = None) -> str:
    """
    Deep Crawling - resolves redirects, loads page via bridge, extracts content.
    """
    final_url = await resolve_redirect_url(url, log_func)

    # SSRF protection: block private/internal network addresses
    if is_private_url(final_url):
        if log_func:
            log_func(f"浏览器: 拒绝访问内网地址 {final_url}")
        return "错误: 不允许访问内网地址"

    # PDF detection: skip browser crawling, return metadata
    if _PDF_PATTERN.search(final_url):
        if log_func:
            log_func(f"浏览器: 检测到 PDF 文件，跳过深度爬取")
        return _format_pdf_metadata(final_url)

    bridge = get_bridge_client()
    tab_pool = TabPool(bridge)
    tab = await tab_pool.acquire(session_id=session_id)
    tab_id = tab["tab_id"]

    try:
        if log_func:
            log_func(f"浏览器: 正在爬取 {final_url}...")

        # Special handling for GitHub API
        if "api.github.com" in final_url and "/repos" in final_url:
            result = await crawl_github_api(bridge, tab_id, final_url, log_func)
            if result is not None:
                return result

        try:
            if log_func:
                log_func(f"浏览器: 正在加载页面...")
            await bridge.navigate(tab_id, final_url, timeout_ms=20000)
        except Exception as e:
            err_msg = str(e)
            is_timeout = "Timeout" in err_msg or "timeout" in err_msg or "timed out" in err_msg
            if log_func:
                if is_timeout:
                    log_func(f"浏览器: 加载页面超时 {final_url}")
                else:
                    log_func(f"浏览器: 加载页面失败 {final_url}: {e}")
            if is_timeout:
                return "[CRAWL_TIMEOUT]"
            return ""

        # 跳转后复查 URL(SSRF / PDF)。桥接 navigate 完成后读真实 URL。
        try:
            navigated_url = await bridge.get_tab_url(tab_id)
        except Exception:
            navigated_url = final_url
        if navigated_url and navigated_url != final_url and navigated_url != "about:blank":
            if is_private_url(navigated_url):
                if log_func:
                    log_func(f"浏览器: 拒绝访问跳转后的内网地址 {navigated_url}")
                return "错误: 不允许访问内网地址"
            final_url = navigated_url
            if _PDF_PATTERN.search(final_url):
                if log_func:
                    log_func(f"浏览器: 跳转到 PDF 文件，跳过深度爬取")
                return _format_pdf_metadata(final_url)

        # Wait for content to stabilize
        prepend_text = ""
        try:
            if log_func:
                log_func(f"浏览器: 等待页面内容渲染...")
            # 桥接无 networkidle;给渲染一点时间。
            # SPA / 官方站的额外等待与滚动由 extract_page_content 内的
            # SPA 感知重试路径负责，这里只做基础 settle。
            await asyncio.sleep(1.2 if is_spa_like_url(final_url) else 1.0)
            if is_spa_like_url(final_url):
                try:
                    await bridge.evaluate(
                        tab_id,
                        "window.scrollTo(0, Math.min(document.body.scrollHeight / 3, 900));",
                        timeout_ms=5000,
                    )
                except Exception:
                    pass
                await asyncio.sleep(0.8)
            if "github.com" in final_url:
                if "tab=repositories" in final_url:
                    prepend_text = await extract_github_repo_stats(bridge, tab_id, final_url, log_func) or ""
                elif "/stars" in final_url:
                    # GitHub stars page optimization
                    prepend_text = await extract_github_repo_stats(bridge, tab_id, final_url, log_func) or ""
                elif "/blob/" not in final_url and "/tree/" not in final_url and "/issues/" not in final_url:
                    # GitHub repo homepage — try to extract README content specifically
                    try:
                        readme = await bridge.evaluate(tab_id, r"""() => {
                            const readme = document.querySelector('[data-target="readme-toc.content"], article.markdown-body, .readme .markdown-body');
                            if (readme) {
                                // Remove anchor links from headings
                                readme.querySelectorAll('a.anchor').forEach(el => el.remove());
                                return readme.innerText.substring(0, 8000);
                            }
                            return null;
                        }""", timeout_ms=15000)
                        if readme and len(readme) > 200:
                            if log_func:
                                log_func(f"浏览器: GitHub README 提取成功 ({len(readme)} 字符)")
                            # Also get repo metadata
                            meta = await bridge.evaluate(tab_id, r"""() => {
                                const parts = [];
                                const desc = document.querySelector('[data-testid="about-description"], .f4.my-3');
                                if (desc) parts.push('描述: ' + desc.innerText.trim());
                                const stars = document.querySelector('#repo-stars-counter-star, a[href$="/stargazers"]');
                                if (stars) parts.push('Stars: ' + stars.innerText.trim());
                                const forks = document.querySelector('#repo-network-counter, a[href$="/forks"]');
                                if (forks) parts.push('Forks: ' + forks.innerText.trim());
                                const lang = document.querySelector('[data-ga-click*="language"], ul.list-style-none li .color-fg-default');
                                if (lang) parts.push('语言: ' + lang.innerText.trim());
                                return parts.join('\n');
                            }""", timeout_ms=15000)
                            prepend_text = (meta + "\n\n--- README ---\n") if meta else "--- README ---\n"
                            prepend_text += readme + "\n--- END README ---\n\n"
                    except Exception:
                        pass
        except Exception:
            pass

        # Special handling for YouTube — extract video metadata and transcript
        if "youtube.com/watch" in final_url or "youtu.be/" in final_url:
            try:
                content = await bridge.evaluate(tab_id, r"""() => {
                    const parts = [];
                    const title = document.querySelector('h1 yt-formatted-string, h1');
                    if (title) parts.push('标题: ' + title.innerText);
                    const channel = document.querySelector('#channel-name a, ytd-channel-name a');
                    if (channel) parts.push('频道: ' + channel.innerText);
                    const views = document.querySelector('#info-container #count, .view-count');
                    if (views) parts.push(views.innerText);
                    const date = document.querySelector('#info-container #info-strings yt-formatted-string, #date');
                    if (date) parts.push('日期: ' + date.innerText);
                    const desc = document.querySelector('#description-inner, #attributed-snippet-text');
                    if (desc) parts.push('\n描述:\n' + desc.innerText.substring(0, 3000));
                    // Try to get transcript if expandable
                    const transcriptBtn = document.querySelector('[target-id="transcript"]');
                    if (transcriptBtn) parts.push('\n[有字幕/文字版可用]');
                    return parts.length > 0 ? parts.join('\n') : null;
                }""", timeout_ms=15000)
                if content:
                    if log_func:
                        log_func(f"浏览器: YouTube 视频信息提取成功")
                    return content
            except Exception:
                pass

        # Special handling for StackOverflow / StackExchange — extract Q&A
        if "stackoverflow.com" in final_url or "stackexchange.com" in final_url or "serverfault.com" in final_url or "superuser.com" in final_url or "askubuntu.com" in final_url:
            try:
                content = await bridge.evaluate(tab_id, r"""() => {
                    const parts = [];
                    const question = document.querySelector('.question .s-prose, .question .post-text');
                    if (question) parts.push('## 问题\n' + question.innerText.substring(0, 4000));
                    const answers = document.querySelectorAll('.answer .s-prose, .answer .post-text');
                    let answerText = '';
                    answers.forEach((a, i) => {
                        if (i < 3) answerText += '\n### 回答 ' + (i+1) + '\n' + a.innerText.substring(0, 4000) + '\n';
                    });
                    if (answerText) parts.push(answerText);
                    return parts.length > 0 ? parts.join('\n\n') : null;
                }""", timeout_ms=15000)
                if content:
                    if log_func:
                        log_func(f"浏览器: StackExchange 问答提取成功")
                    return content
            except Exception:
                pass

        # Special handling for Arxiv papers (abstract page only; HTML version uses default extraction)
        if "arxiv.org/abs/" in final_url:
            try:
                content = await bridge.evaluate(tab_id, r"""() => {
                    const parts = [];
                    const title = document.querySelector('h1.title');
                    if (title) parts.push('标题: ' + title.innerText.replace('Title:', '').trim());
                    const authors = document.querySelector('.authors');
                    if (authors) parts.push('作者: ' + authors.innerText.replace('Authors:', '').trim());
                    const abstract = document.querySelector('.abstract');
                    if (abstract) parts.push('\n摘要:\n' + abstract.innerText.replace('Abstract:', '').trim());
                    const date = document.querySelector('.dateline');
                    if (date) parts.push('日期: ' + date.innerText.trim());
                    return parts.length > 0 ? parts.join('\n') : null;
                }""", timeout_ms=15000)
                if content:
                    if log_func:
                        log_func(f"浏览器: Arxiv 论文信息提取成功")
                    return content
            except Exception:
                pass

        # Special handling for Zhihu — click "阅读全文" / "展开阅读全文" to expand
        if "zhihu.com" in final_url:
            try:
                expanded = await bridge.evaluate(tab_id, r"""() => {
                    const btns = document.querySelectorAll('button');
                    for (const btn of btns) {
                        const text = btn.innerText.trim();
                        if (text === '阅读全文' || text === '展开阅读全文' || text === '显示全部') {
                            btn.click();
                            return true;
                        }
                    }
                    return false;
                }""", timeout_ms=15000)
                if expanded:
                    await asyncio.sleep(1.5)
                    if log_func:
                        log_func(f"浏览器: 知乎全文已展开")
            except Exception:
                pass

        # Special handling for Medium — remove paywall overlay
        if "medium.com" in final_url:
            try:
                await bridge.evaluate(tab_id, r"""() => {
                    // Remove paywall overlays
                    document.querySelectorAll('[aria-label="Member-only story"], .metabar, .js-sticky-footer, .overlay').forEach(el => el.remove());
                    // Try to expand truncated content
                    const expandBtn = document.querySelector('button[data-action="expand"]');
                    if (expandBtn) expandBtn.click();
                }""", timeout_ms=15000)
            except Exception:
                pass

        # Special handling for WeChat articles — expand collapsed content
        if "mp.weixin.qq.com" in final_url:
            try:
                await bridge.evaluate(tab_id, r"""() => {
                    const expandBtn = document.querySelector('#js_content_overflow_mask');
                    if (expandBtn) {
                        const clickEvent = new Event('click');
                        expandBtn.dispatchEvent(clickEvent);
                    }
                }""", timeout_ms=15000)
            except Exception:
                pass

        # Special handling for Baidu Baike — extract article content only
        if "baike.baidu.com" in final_url:
            try:
                content = await bridge.evaluate(tab_id, r"""() => {
                    const summary = document.querySelector('.lemma-summary, .lemma-desc');
                    const mainContent = document.querySelector('.main-content, .lemma-main-content, #J-lemma-content');
                    const parts = [];
                    if (summary) parts.push(summary.innerText);
                    if (mainContent) parts.push(mainContent.innerText);
                    return parts.length > 0 ? parts.join('\n\n') : null;
                }""", timeout_ms=15000)
                if content and len(content) > 200:
                    if log_func:
                        log_func(f"浏览器: 百度百科内容提取成功 ({len(content)} 字符)")
                    return content
            except Exception:
                pass

        # Special handling for Zhihu Zhuanlan — expand full article
        if "zhuanlan.zhihu.com" in final_url:
            try:
                await bridge.evaluate(tab_id, r"""() => {
                    const btn = document.querySelector('.ContentItem-expandButton');
                    if (btn) btn.click();
                }""", timeout_ms=15000)
                await asyncio.sleep(1.0)
            except Exception:
                pass

        # Special handling for Toutiao articles — extract article body
        if "toutiao.com/article/" in final_url:
            try:
                content = await bridge.evaluate(tab_id, r"""() => {
                    const article = document.querySelector('.article-content, .syl-article-base, #article-root');
                    if (article) return article.innerText;
                    return null;
                }""", timeout_ms=15000)
                if content and len(content) > 200:
                    if log_func:
                        log_func(f"浏览器: 头条文章内容提取成功 ({len(content)} 字符)")
                    return content
            except Exception:
                pass

        # Special handling for CSDN — remove ads and recommendations
        if "csdn.net" in final_url:
            try:
                content = await bridge.evaluate(tab_id, r"""() => {
                    const article = document.querySelector('#article_content, #content_views');
                    if (article) {
                        const clone = article.cloneNode(true);
                        clone.querySelectorAll('.hide-article-box, .more-toolbox, .recommend-box, .person-messagebox, script, style').forEach(el => el.remove());
                        return clone.innerText;
                    }
                    return null;
                }""", timeout_ms=15000)
                if content and len(content) > 200:
                    if log_func:
                        log_func(f"浏览器: CSDN 文章内容提取成功 ({len(content)} 字符)")
                    return content
            except Exception:
                pass

        # Special handling for Juejin (掘金) — extract article body
        if "juejin.cn" in final_url:
            try:
                content = await bridge.evaluate(tab_id, r"""() => {
                    const article = document.querySelector('.article-content, .markdown-body');
                    if (article) return article.innerText;
                    return null;
                }""", timeout_ms=15000)
                if content and len(content) > 200:
                    if log_func:
                        log_func(f"浏览器: 掘金文章内容提取成功 ({len(content)} 字符)")
                    return content
            except Exception:
                pass

        # Special handling for Wikipedia — extract main article content only
        if "wikipedia.org/wiki/" in final_url:
            try:
                content = await bridge.evaluate(tab_id, r"""() => {
                    const article = document.querySelector('#mw-content-text .mw-parser-output');
                    if (!article) return null;
                    const clone = article.cloneNode(true);
                    clone.querySelectorAll('.reference, .noprint, .mw-editsection, .sidebar, .navbox, .infobox, table, .toc').forEach(el => el.remove());
                    return clone.innerText;
                }""", timeout_ms=15000)
                if content:
                    if log_func:
                        log_func(f"浏览器: Wikipedia 内容提取成功")
                    return content
            except Exception:
                pass  # Fall through to default extraction

        # Special handling for Xiaohongshu (小红书) — extract note content
        if "xiaohongshu.com/explore/" in final_url or "xiaohongshu.com/discovery/item/" in final_url or "xhslink.com" in final_url:
            try:
                content = await bridge.evaluate(tab_id, r"""() => {
                    const parts = [];
                    const title = document.querySelector('#detail-title, .note-content .title');
                    if (title) parts.push('标题: ' + title.innerText.trim());
                    const author = document.querySelector('.author-wrapper .username, .user-nickname');
                    if (author) parts.push('作者: ' + author.innerText.trim());
                    const desc = document.querySelector('#detail-desc, .note-text, .desc');
                    if (desc) parts.push('\n简介:\n' + desc.innerText.trim().substring(0, 5000));
                    const tags = document.querySelectorAll('.tag, .hash-tag');
                    if (tags.length > 0) {
                        const tagText = Array.from(tags).map(t => t.innerText.trim()).join(', ');
                        if (tagText) parts.push('\n标签: ' + tagText);
                    }
                    return parts.length > 0 ? parts.join('\n') : null;
                }""", timeout_ms=15000)
                if content:
                    if log_func:
                        log_func(f"浏览器: 小红书笔记内容提取成功")
                    return content
            except Exception:
                pass

        # Special handling for GitHub — extract README, issues, or PR content
        if "github.com" in final_url:
            try:
                content = await bridge.evaluate(tab_id, r"""() => {
                    // README on repo page
                    const readme = document.querySelector('#readme article, .markdown-body');
                    if (readme) {
                        const repoName = document.querySelector('strong a, .js-repo-nav span');
                        let result = '';
                        if (repoName) result += 'Repo: ' + repoName.innerText.trim() + '\n\n';
                        result += readme.innerText.trim();
                        // Also get star count
                        const stars = document.querySelector('#repo-stars-counter-star, a[href$="/stargazers"]');
                        if (stars) result += '\n\nStars: ' + stars.innerText.trim();
                        return result.substring(0, 10000);
                    }
                    // Issue/PR page
                    const issueBody = document.querySelector('.js-discussion, .comment-body');
                    if (issueBody) {
                        const title = document.querySelector('.js-issue-title, .gh-header-title');
                        let result = '';
                        if (title) result += 'Title: ' + title.innerText.trim() + '\n\n';
                        result += issueBody.innerText.trim();
                        return result.substring(0, 8000);
                    }
                    return null;
                }""", timeout_ms=15000)
                if content:
                    if log_func:
                        log_func(f"浏览器: GitHub 页面内容提取成功")
                    return content
            except Exception:
                pass

        # Special handling for Bilibili (B站) — extract video info and comments
        if "bilibili.com/video/" in final_url or "b23.tv/" in final_url:
            try:
                content = await bridge.evaluate(tab_id, r"""() => {
                    const parts = [];
                    const title = document.querySelector('h1.video-title, .video-info-container .video-title');
                    if (title) parts.push('标题: ' + title.innerText.trim());
                    const author = document.querySelector('.up-info .username, .up-name');
                    if (author) parts.push('UP主: ' + author.innerText.trim());
                    const views = document.querySelector('.view-text, .video-data .view');
                    if (views) parts.push('播放量: ' + views.innerText.trim());
                    const date = document.querySelector('.pubdate-ip-text, .pubdate-text');
                    if (date) parts.push('发布时间: ' + date.innerText.trim());
                    const desc = document.querySelector('.desc-info-text, .basic-desc-info');
                    if (desc) parts.push('\n简介: ' + desc.innerText.trim().substring(0, 2000));
                    const tags = document.querySelectorAll('.tag-link, .tag-area a');
                    if (tags.length > 0) {
                        const tagText = Array.from(tags).map(t => t.innerText.trim()).filter(t => t).join(', ');
                        if (tagText) parts.push('\n标签: ' + tagText);
                    }
                    // Try to get Danmaku/comment summary
                    const comments = document.querySelectorAll('.reply-content .root-reply .reply-content-container .reply-content');
                    if (comments.length > 0) {
                        parts.push('\n热门评论:');
                        const maxComments = Math.min(comments.length, 5);
                        for (let i = 0; i < maxComments; i++) {
                            parts.push('  ' + (i+1) + '. ' + comments[i].innerText.trim().substring(0, 200));
                        }
                    }
                    return parts.length > 0 ? parts.join('\n') : null;
                }""", timeout_ms=15000)
                if content:
                    if log_func:
                        log_func("浏览器: B站视频信息提取成功")
                    return content
            except Exception:
                pass

        # Special handling for WeChat Official Account articles (微信公众号)
        if "mp.weixin.qq.com" in final_url:
            try:
                content = await bridge.evaluate(tab_id, r"""() => {
                    const title = document.querySelector('#activity-name, .rich_media_title');
                    const author = document.querySelector('#js_name, .rich_media_meta_nickname a');
                    const date = document.querySelector('#publish_time, .rich_media_meta_primary_category');
                    const body = document.querySelector('#js_content, .rich_media_content');
                    if (!body) return null;
                    let result = '';
                    if (title) result += '标题: ' + title.innerText.trim() + '\n';
                    if (author) result += '公众号: ' + author.innerText.trim() + '\n';
                    if (date) result += '时间: ' + date.innerText.trim() + '\n';
                    result += '\n' + body.innerText.trim();
                    return result.substring(0, 10000);
                }""", timeout_ms=15000)
                if content:
                    if log_func:
                        log_func(f"浏览器: 微信公众号文章提取成功")
                    return content
            except Exception:
                pass

        # Detect Cloudflare challenge page
        is_cf_challenge = await bridge.evaluate(tab_id, r"""() => {
            const title = document.title || '';
            const body = document.body ? document.body.innerText : '';
            return title.includes('Just a moment') ||
                   title.includes('Attention Required') ||
                   body.includes('Checking your browser') ||
                   body.includes('cf-browser-verification') ||
                   document.querySelector('#challenge-running, .challenge-running') !== null;
        }""", timeout_ms=15000)
        if is_cf_challenge:
            if log_func:
                log_func("浏览器: 检测到 Cloudflare 验证页面，等待通过...")
            try:
                # 桥接无 networkidle;Cloudflare 验证通常几秒内自行通过,等待后复查。
                await asyncio.sleep(8.0)
            except Exception:
                pass
            # Re-check after waiting
            still_blocked = await bridge.evaluate(tab_id, r"""() => {
                const title = document.title || '';
                return title.includes('Just a moment') || title.includes('Attention Required');
            }""", timeout_ms=15000)
            if still_blocked:
                if log_func:
                    log_func("浏览器: Cloudflare 验证未通过，跳过此页面")
                return None

        # Interactive Mode
        if interactive_mode and query and llm_client:
            try:
                await run_interactive_mode(
                    bridge, tab_id, query, llm_client, log_func,
                    session_id=session_id or "default",
                )
            except Exception as e:
                if log_func:
                    log_func(f"浏览器: 交互模式执行出错: {e}")

        if log_func:
            log_func(f"浏览器: 正在提取页面内容...")
        content = await extract_page_content(bridge, tab_id, final_url, log_func)

        # Extract OpenGraph metadata for better context
        og = await extract_og_metadata(bridge, tab_id)
        if og and any(og.values()):
            meta_lines = []
            if og.get('og_description'):
                meta_lines.append(f"页面描述: {og['og_description']}")
            if og.get('author'):
                meta_lines.append(f"作者: {og['author']}")
            if og.get('published_time'):
                meta_lines.append(f"发布时间: {og['published_time']}")
            if meta_lines:
                content = "[元信息] " + " | ".join(meta_lines) + "\n\n" + content

        if prepend_text:
            content = prepend_text + content

        if log_func:
            log_func(f"浏览器: 已爬取 {url} - 提取了 {len(content)} 个字符。")
        return content.strip()

    except Exception as e:
        msg = f"Crawl error for {url}: {e}"
        logger.error(msg)
        if log_func:
            log_func(f"浏览器错误: {msg}")
        return f"爬取页面时出错: {str(e)}"
    finally:
        await tab_pool.release(tab)
        await tab_pool.close_all_pending(session_id=session_id)
