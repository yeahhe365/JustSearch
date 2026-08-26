"""Page content extraction via Chrome bridge.

Primary path (preferred):
  Defuddle (same engine as ToMarkdown / Obsidian Web Clipper) injected by the
  extension via chrome.scripting — returns AI-friendly Markdown.

Fallback chain (when Defuddle is unavailable / thin / errors):
  1. Site-specific main-content selectors for known SPA / docs hosts
  2. DOM density + link-density scoring (Readability-style) over semantic candidates
  3. Cleaned body text
  4. JSON-LD / OpenGraph structured text
  5. Retry with scroll + wait when extracted text is below a usefulness threshold
"""

from __future__ import annotations

import asyncio
import logging
from urllib.parse import urlparse

from ..citation_evidence import useful_char_count


logger = logging.getLogger(__name__)

# Non-whitespace character count below which we treat extraction as "thin"
# and attempt wait/retry/structured fallbacks. Official SPA shells often
# return only nav chrome (~50-100 chars) without this recovery path.
MIN_USEFUL_CHARS = 280

# Host substrings that typically hydrate content client-side and need extra wait.
SPA_HOST_HINTS = (
    "openai.com",
    "anthropic.com",
    "platform.claude.com",
    "blog.rust-lang.org",
    "docs.rs",
    "fastapi.tiangolo.com",
    "developer.mozilla.org",
    "learn.microsoft.com",
    "cloud.google.com",
    "aws.amazon.com",
    "vercel.app",
    "netlify.app",
    "gitbook.io",
    "readme.io",
    "notion.site",
    "spacex.com",
    "wikipedia.org",
    "docusaurus",
    "vitepress",
)

# Legacy DOM-density + multi-strategy content extraction (runs in page context).
# Kept as fallback when Defuddle is missing, fails, or returns thin content.
_JS_EXTRACT_CONTENT = r"""(() => {
    const body = document.body;
    if (!body) {
        return { text: "", strategy: "empty", useful: 0, title: document.title || "" };
    }

    const host = (location.hostname || "").toLowerCase();
    const path = location.pathname || "";

    const NOISE = [
        'nav','footer','aside','header',
        '[role="navigation"]','[role="banner"]','[role="contentinfo"]',
        '.sidebar','.nav-bar','.footer','.site-header','.site-footer',
        '.ad','.ads','.advertisement','.sponsor','.promoted',
        '.cookie-banner','.cookie-notice','.popup','.modal-overlay',
        '.social-share','.share-buttons','.related-posts','.related-articles',
        '.comments','#comments','.comment-section',
        '.breadcrumb','.pagination','.pager',
        'iframe','script','style','noscript','svg',
        '[aria-hidden="true"]'
    ];

    function usefulLen(s) {
        return (s || "").replace(/\s+/g, "").length;
    }

    function cleanText(el) {
        if (!el) return "";
        return (el.innerText || el.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
    }

    function stripNoise(root) {
        const clone = root.cloneNode(true);
        NOISE.forEach(sel => {
            try { clone.querySelectorAll(sel).forEach(el => el.remove()); } catch (e) {}
        });
        return clone;
    }

    // Host-specific primary content selectors (first match with enough text wins).
    const HOST_SELECTORS = [
        { match: /openai\.com$/i, sels: [
            'main article', 'main [class*="prose"]', 'main',
            'article', '[data-testid="blog-post"]', '.prose'
        ]},
        { match: /anthropic\.com$/i, sels: [
            'main article', 'main', 'article',
            '[class*="Prose"]', '[class*="prose"]', '[class*="Content"]'
        ]},
        { match: /platform\.claude\.com$/i, sels: [
            'main article', 'main .theme-doc-markdown', 'main', 'article'
        ]},
        { match: /blog\.rust-lang\.org$/i, sels: [
            'main article', 'article.post', 'article', 'main'
        ]},
        { match: /fastapi\.tiangolo\.com$/i, sels: [
            'article.md-content__inner', '.md-content', 'article', 'main'
        ]},
        { match: /developer\.mozilla\.org$/i, sels: [
            'article.main-page-content', 'main', 'article'
        ]},
        { match: /spacex\.com$/i, sels: [
            'main', 'article', '[class*="content"]', '#__next'
        ]},
        { match: /wikipedia\.org$/i, sels: [
            '#mw-content-text .mw-parser-output', '#bodyContent', 'main'
        ]},
        { match: /github\.com$/i, sels: [
            'article.markdown-body', '[data-target="readme-toc.content"]',
            '#readme', 'main'
        ]},
        { match: /medium\.com$/i, sels: [
            'article', 'section[data-field="body"]', 'main'
        ]},
        { match: /substack\.com$/i, sels: [
            '.available-content', 'article', 'main'
        ]},
    ];

    function pickBySelectors(selectors, minUseful) {
        for (const sel of selectors) {
            try {
                const nodes = document.querySelectorAll(sel);
                for (const node of nodes) {
                    const stripped = stripNoise(node);
                    const text = cleanText(stripped);
                    if (usefulLen(text) >= minUseful) {
                        return { text, strategy: "host-selector:" + sel, useful: usefulLen(text) };
                    }
                }
            } catch (e) {}
        }
        return null;
    }

    // 1) Host-specific path
    for (const entry of HOST_SELECTORS) {
        if (entry.match.test(host)) {
            const hit = pickBySelectors(entry.sels, 120);
            if (hit) {
                hit.title = document.title || "";
                return hit;
            }
        }
    }

    // 2) Generic semantic candidates with Readability-ish scoring
    const GENERIC_SELS = [
        'article', 'main', '[role="main"]',
        '.content', '.post-content', '.entry-content',
        '.article-content', '.post-body', '#content', '#main',
        '.main-content', '.page-content', '.text-content',
        '.detail-content', '.news-content', '.article-body',
        '.post-text', '#article-content', '.article_detail',
        '.content-body', '.RichText', '.rich_media_content',
        '#js_content', '.topic-richtext', '.Post-RichTextContainer',
        '.prose', '[class*="prose"]', '.markdown-body',
        '.md-content', '.theme-doc-markdown', '.docMainContainer',
        '#__next main', '#root main', '[data-content]'
    ];

    function scoreElement(el) {
        const text = cleanText(el);
        const u = usefulLen(text);
        if (u < 40) return -1;
        const links = el.querySelectorAll('a[href]').length;
        const tags = el.getElementsByTagName('*').length + 1;
        const density = u / tags;
        // Penalize nav-like regions with high link density
        const linkDensity = links / Math.max(1, tags);
        let score = u * 0.6 + density * 80 - linkDensity * 400;
        const tag = (el.tagName || '').toLowerCase();
        if (tag === 'article' || tag === 'main') score += 120;
        if (el.getAttribute('role') === 'main') score += 100;
        // Prefer mid-page content over giant wrappers with chrome
        if (u > 800 && u < 80000) score += 50;
        if (u > 120000) score -= 80;
        return score;
    }

    let bestEl = null;
    let bestScore = -1;
    const seen = new Set();
    for (const sel of GENERIC_SELS) {
        try {
            document.querySelectorAll(sel).forEach(el => {
                if (seen.has(el)) return;
                seen.add(el);
                const s = scoreElement(el);
                if (s > bestScore) {
                    bestScore = s;
                    bestEl = el;
                }
            });
        } catch (e) {}
    }

    let text = "";
    let strategy = "none";
    if (bestEl && bestScore > 0) {
        text = cleanText(stripNoise(bestEl));
        strategy = "scored:" + (bestEl.tagName || "").toLowerCase();
    }

    // 3) Cleaned body fallback
    if (usefulLen(text) < 200) {
        const bodyText = cleanText(stripNoise(body));
        if (usefulLen(bodyText) > usefulLen(text)) {
            text = bodyText;
            strategy = "cleaned-body";
        }
    }

    // Attach download links from best region (keep existing product behavior)
    const downloadExts = ['.dmg', '.exe', '.zip', '.pkg', '.deb', '.rpm', '.apk', '.msix', '.tar.gz', '.tar.xz', '.7z', '.iso', '.appx'];
    const downloadKeywords = /download|下载|安装包|installer|离线/i;
    const collectedLinks = [];
    const seenUrls = new Set();
    const linkRoot = bestEl || body;
    try {
        linkRoot.querySelectorAll('a[href]').forEach(a => {
            const rawHref = a.getAttribute('href');
            if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:')) return;
            const href = a.href || rawHref;
            const linkText = (a.innerText || '').trim();
            const isDownloadUrl = downloadExts.some(ext => (rawHref + ' ' + href).toLowerCase().includes(ext));
            const isDownloadText = downloadKeywords.test(linkText);
            if (isDownloadUrl || isDownloadText) {
                if (!seenUrls.has(href)) {
                    seenUrls.add(href);
                    const label = linkText || href;
                    collectedLinks.push({ text: label.substring(0, 80), url: href });
                }
            }
        });
    } catch (e) {}
    if (collectedLinks.length > 0) {
        text += '\n\n--- 页面中的下载链接 ---';
        for (const link of collectedLinks) {
            text += '\n[' + link.text + '](' + link.url + ')';
        }
    }

    return {
        text: text,
        strategy: strategy,
        useful: usefulLen(text),
        title: document.title || "",
        path: path,
        host: host,
    };
})()"""


_JS_STRUCTURED_FALLBACK = r"""(() => {
    function usefulLen(s) {
        return (s || "").replace(/\s+/g, "").length;
    }
    const parts = [];
    const title = document.title || "";
    if (title) parts.push("标题: " + title.trim());

    const getMeta = (name) => {
        const el = document.querySelector(`meta[property="${name}"]`) ||
                   document.querySelector(`meta[name="${name}"]`);
        return el ? (el.content || "").trim() : "";
    };
    const ogTitle = getMeta("og:title");
    const ogDesc = getMeta("og:description");
    const description = getMeta("description");
    if (ogTitle && ogTitle !== title) parts.push("OG标题: " + ogTitle);
    if (ogDesc) parts.push("摘要: " + ogDesc);
    else if (description) parts.push("摘要: " + description);

    // JSON-LD Article / BlogPosting / TechArticle
    const jsonBlocks = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
        try {
            const data = JSON.parse(s.textContent || "null");
            jsonBlocks.push(data);
        } catch (e) {}
    });

    function walkLd(node, out) {
        if (!node) return;
        if (Array.isArray(node)) {
            node.forEach(n => walkLd(n, out));
            return;
        }
        if (typeof node !== "object") return;
        const t = node["@type"];
        const types = Array.isArray(t) ? t : (t ? [t] : []);
        const interesting = types.some(x =>
            /Article|BlogPosting|NewsArticle|TechArticle|WebPage|FAQPage|Product/i.test(String(x || ""))
        );
        if (interesting || node.articleBody || node.text || node.description || node.headline) {
            if (node.headline) out.push("标题: " + String(node.headline));
            if (node.name && !node.headline) out.push("名称: " + String(node.name));
            if (node.datePublished) out.push("发布: " + String(node.datePublished));
            if (node.author) {
                const a = node.author;
                const name = typeof a === "string" ? a : (a.name || (Array.isArray(a) && a[0] && a[0].name) || "");
                if (name) out.push("作者: " + name);
            }
            if (node.articleBody) out.push(String(node.articleBody));
            else if (node.text) out.push(String(node.text));
            else if (node.description) out.push(String(node.description));
        }
        if (node["@graph"]) walkLd(node["@graph"], out);
    }

    const ldOut = [];
    jsonBlocks.forEach(b => walkLd(b, ldOut));
    if (ldOut.length) {
        parts.push("--- 结构化数据 ---");
        parts.push(ldOut.join("\n"));
    }

    // Next.js / Nuxt / generic __NEXT_DATA__ snippet (title + description only, avoid huge dumps)
    try {
        const next = document.querySelector("#__NEXT_DATA__");
        if (next && next.textContent) {
            const data = JSON.parse(next.textContent);
            const props = (data && data.props && data.props.pageProps) || {};
            const candidates = [
                props.body, props.content, props.articleBody, props.markdown,
                props.post && props.post.body, props.post && props.post.content,
                props.page && props.page.body, props.data && props.data.body,
            ].filter(Boolean);
            for (const c of candidates) {
                const s = typeof c === "string" ? c : "";
                if (usefulLen(s) > 200) {
                    parts.push("--- 页面数据 ---");
                    parts.push(s.substring(0, 20000));
                    break;
                }
            }
        }
    } catch (e) {}

    const text = parts.join("\n\n").trim();
    return {
        text: text,
        strategy: "structured-fallback",
        useful: usefulLen(text),
        title: title,
    };
})()"""


def is_spa_like_url(url: str) -> bool:
    if not url:
        return False
    lower = url.lower()
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        host = ""
    if any(h in host for h in SPA_HOST_HINTS):
        return True
    spa_path_hints = (
        "/docs/", "/documentation/", "/blog/", "/news/", "/index/",
        "docusaurus", "vitepress", "gitbook", "mkdocs",
    )
    return any(h in lower for h in spa_path_hints)


def _coerce_extract_result(raw) -> dict:
    """Normalize evaluate / extractContent return value to {text, strategy, useful}."""
    if isinstance(raw, str):
        return {
            "text": raw,
            "strategy": "legacy-string",
            "useful": useful_char_count(raw),
        }
    if isinstance(raw, dict):
        text = raw.get("text") or ""
        if not isinstance(text, str):
            text = str(text) if text is not None else ""
        useful = raw.get("useful")
        if not isinstance(useful, int):
            useful = useful_char_count(text)
        return {
            "text": text,
            "strategy": str(raw.get("strategy") or "dict"),
            "useful": useful,
            "title": raw.get("title") or "",
            "ok": raw.get("ok", True),
            "error": raw.get("error"),
            "author": raw.get("author") or "",
        }
    return {"text": "", "strategy": "empty", "useful": 0}


async def extract_og_metadata(bridge, tab_id: int) -> dict:
    """Extract OpenGraph metadata from a page for better source previews."""
    try:
        return await bridge.evaluate(tab_id, r"""(() => {
            const getMeta = (name) => {
                const el = document.querySelector(`meta[property="${name}"]`) ||
                           document.querySelector(`meta[name="${name}"]`);
                return el ? el.content : '';
            };
            return {
                og_title: getMeta('og:title'),
                og_description: getMeta('og:description'),
                og_image: getMeta('og:image'),
                og_site_name: getMeta('og:site_name'),
                author: getMeta('author'),
                published_time: getMeta('article:published_time'),
            };
        })()""", timeout_ms=10000)
    except Exception:
        return {}


async def _evaluate_extract(bridge, tab_id: int, expression: str) -> dict:
    raw = await bridge.evaluate(tab_id, expression, timeout_ms=30000)
    return _coerce_extract_result(raw)


async def _try_defuddle_extract(
    bridge, tab_id: int, log_func=None
) -> tuple[str, dict | None]:
    """Call extension extractContent (Defuddle).

    返回 (status, payload)，status ∈ {"ok", "method_missing", "error"}：
    - ("ok", result): 调用成功（result 可能是 ok=false 的薄结果，交由调用方比较）。
    - ("method_missing", None): 扩展版本过旧、无 extractContent RPC —— 永久不可用，
      调用方应关闭本页后续尝试。
    - ("error", None): 超时 / 桥接错误等瞬态失败 —— 后续尝试仍应再调 Defuddle。
    """
    extract_fn = getattr(bridge, "extract_content", None)
    if extract_fn is None or not callable(extract_fn):
        return ("method_missing", None)
    try:
        raw = await extract_fn(tab_id, timeout_ms=45000)
    except Exception as e:
        msg = str(e)
        # Older extension builds won't have the RPC method.
        # 仅精确匹配扩展层抛出的缺方法信号，避免页面内 "Element not found" 误触发永久降级
        low = msg.lower()
        if any(
            token in low
            for token in (
                "extractcontent",
                "unknown method",
                "method not found",
                "unsupported",
            )
        ) or "extractcontent" in low and "not found" in low:
            logger.debug("Defuddle extractContent unavailable: %s", e)
            if log_func:
                log_func("浏览器: Defuddle 不可用，回退到启发式抽取")
            return ("method_missing", None)
        logger.warning("Defuddle extractContent failed: %s", e)
        if log_func:
            log_func(f"浏览器: Defuddle 抽取失败（{e}），尝试回退")
        return ("error", None)

    result = _coerce_extract_result(raw)
    if raw and isinstance(raw, dict) and raw.get("ok") is False and result["useful"] == 0:
        err = raw.get("error") or "unknown"
        logger.debug("Defuddle returned ok=false: %s", err)
        if log_func:
            log_func(f"浏览器: Defuddle 未得到正文（{err}）")
        return ("ok", result)  # still return for comparison; caller may treat as thin
    return ("ok", result)


async def _wait_for_render(bridge, tab_id: int, spa: bool, log_func=None) -> None:
    """Give SPA shells time to hydrate; scroll to trigger lazy content."""
    await asyncio.sleep(1.2 if spa else 0.6)
    try:
        await bridge.evaluate(
            tab_id,
            "window.scrollTo(0, Math.min(document.body.scrollHeight * 0.35, 1200));",
            timeout_ms=5000,
        )
    except Exception:
        pass
    await asyncio.sleep(0.8 if spa else 0.4)
    if spa:
        try:
            await bridge.evaluate(
                tab_id,
                "window.scrollTo(0, Math.min(document.body.scrollHeight * 0.7, 2400));",
                timeout_ms=5000,
            )
        except Exception:
            pass
        await asyncio.sleep(0.8)


async def extract_page_content(bridge, tab_id: int, url: str, log_func=None) -> str:
    """Extract main content: Defuddle first, then legacy DOM heuristics + structured data.

    Bridge uses Runtime.evaluate for fallbacks; Defuddle runs via extractContent
    (chrome.scripting). Thin results trigger wait/scroll + retries.
    """
    spa = is_spa_like_url(url)
    last_err = None
    best = {"text": "", "strategy": "none", "useful": 0}
    defuddle_available = True  # optimistic; flipped off if method missing

    # Initial settle for SPA hosts before first extract
    if spa:
        if log_func:
            log_func("浏览器: 检测到 SPA/文档站，等待客户端渲染...")
        await _wait_for_render(bridge, tab_id, spa=True, log_func=log_func)

    for attempt in range(3):
        try:
            # --- Primary: Defuddle (ToMarkdown engine) ---
            if defuddle_available:
                dstatus, dresult = await _try_defuddle_extract(bridge, tab_id, log_func=log_func)
                if dstatus == "method_missing":
                    # 扩展无此 RPC 方法 → 本页永久跳过 Defuddle。
                    defuddle_available = False
                elif dstatus == "ok" and dresult is not None:
                    if dresult["useful"] > best["useful"]:
                        best = dresult
                    if dresult["useful"] >= MIN_USEFUL_CHARS:
                        if log_func:
                            log_func(
                                f"浏览器: Defuddle 提取成功"
                                f"（{dresult['useful']} 有效字符"
                                + (f"，第 {attempt + 1} 次尝试" if attempt > 0 else "")
                                + "）"
                            )
                        return dresult["text"]
                # status == "error": 瞬态失败 —— 本次走启发式回退，
                # defuddle_available 保持 True，后续尝试仍会再调 Defuddle。

            # --- Secondary: legacy density / host-selector path ---
            result = await _evaluate_extract(bridge, tab_id, _JS_EXTRACT_CONTENT)
            if result["useful"] > best["useful"]:
                best = result

            if result["useful"] >= MIN_USEFUL_CHARS:
                if log_func and (attempt > 0 or defuddle_available):
                    log_func(
                        f"浏览器: 内容提取成功（{result['strategy']}，"
                        f"{result['useful']} 有效字符"
                        + (f"，第 {attempt + 1} 次尝试" if attempt > 0 else "")
                        + "）"
                    )
                return result["text"]

            # Thin — wait/scroll and retry
            if attempt < 2:
                if log_func:
                    log_func(
                        f"浏览器: 正文偏少（{best['useful']} 有效字符，"
                        f"{best.get('strategy', '?')}），等待渲染后重试..."
                    )
                await _wait_for_render(bridge, tab_id, spa=True, log_func=log_func)
                continue

        except Exception as e:
            last_err = e
            msg = str(e)
            if any(
                token in msg
                for token in (
                    "Execution context was destroyed",
                    "Cannot find context",
                    "No execution context",
                )
            ):
                if attempt < 2:
                    await asyncio.sleep(2)
                    continue
            logger.error("Extraction error on %s: %s", url, e)
            break

    # Structured fallback (JSON-LD / OG / light Next data)
    try:
        structured = await _evaluate_extract(bridge, tab_id, _JS_STRUCTURED_FALLBACK)
        if structured["useful"] > best["useful"]:
            best = structured
            if log_func:
                log_func(
                    f"浏览器: 使用结构化数据回退（{structured['useful']} 有效字符）"
                )
    except Exception as e:
        logger.debug("Structured fallback failed on %s: %s", url, e)

    if best["useful"] > 0:
        if best["useful"] < MIN_USEFUL_CHARS and log_func:
            log_func(
                f"浏览器: 正文仍偏少（{best['useful']} 有效字符，"
                f"{best['strategy']}），将使用现有内容"
            )
        return best["text"]

    if last_err and log_func:
        log_func(f"浏览器: 内容提取失败 {url}: {last_err}")
    return ""
