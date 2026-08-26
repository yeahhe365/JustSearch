import urllib.parse


def clean_fallback_title(title: str, url: str = "") -> str:
    """Clean noisy multiline titles returned by search-result fallback parsing."""
    if not title:
        return ""

    lines = [
        line.strip()
        for line in title.replace("\r", "\n").split("\n")
        if line.strip()
    ]
    if not lines:
        return title.strip()
    if len(lines) == 1:
        return lines[0]

    hostname = ""
    try:
        hostname = urllib.parse.urlparse(url).hostname or ""
        hostname = hostname.removeprefix("www.")
    except Exception:
        pass

    def is_breadcrumb(line: str) -> bool:
        lower = line.lower()
        # 仅当行是纯 URL 或含多个导航分隔符时才按域名判面包屑
        if hostname and hostname.lower() in lower:
            if lower.strip().startswith(("http://", "https://")) or lower.count("›") + lower.count(">") >= 2:
                return True
        if "›" in line:
            return "." in line or "/" in line
        if ">" in line:
            # 要求至少两个分隔符或同时含域名特征，避免误删 "A > B (v1.2)"
            return (line.count(">") >= 2 or line.count("›") >= 1) and ("." in line or "/" in line)
        # 只把真正的 http(s) 链接行当面包屑；否则 "Update: service status"
        # 这类文本会被 urlparse 解析出 scheme="update" 而被误丢。
        return urllib.parse.urlparse(line).scheme.lower() in {"http", "https"}

    candidates = [line for line in lines if not is_breadcrumb(line)]
    if not candidates:
        candidates = lines

    return candidates[-1]


def is_generic_search_aux_title(title: str) -> bool:
    """Detect search-engine auxiliary links that are not real search results."""
    normalized = " ".join((title or "").split()).strip()
    if not normalized:
        return True

    lower = normalized.lower()
    return (
        normalized.startswith("更多关于") and normalized.endswith("的信息")
    ) or (
        lower.startswith("more about ") and lower.endswith(" information")
    )


def is_search_engine_internal_page(url: str) -> bool:
    """Return True for search pages that should not be crawled as sources.

    NOTE: baidu.com/link?url=... 是结果跳转链接,不是内部页 —— 不能在此过滤,
    否则会被 is_search_engine_internal_page 当垃圾链接丢掉。百度 link 解析
    在 redirects.resolve_redirect_url 里处理。
    """
    try:
        parsed = urllib.parse.urlparse(url)
    except Exception:
        return False

    hostname = (parsed.hostname or "").lower().rstrip(".").removeprefix("www.")
    path = parsed.path or "/"
    query = urllib.parse.parse_qs(parsed.query)

    def _host_match(h: str, base: str) -> bool:
        return h == base or h.endswith("." + base)

    import re as _re
    # Google 搜索域：匹配 google.com / google.co.* / www.google.*，不含 developers.google.com
    _is_google_search = (
        hostname == "google.com"
        or _re.match(r"^google\.[a-z.]+$", hostname) is not None
        or _re.match(r"^www\.google\.[a-z.]+$", hostname) is not None
    )
    if _is_google_search:
        return path in {"/search", "/url"} or path.startswith("/sorry/")
    if _host_match(hostname, "bing.com") or hostname == "cn.bing.com":
        return path in {"/search", "/ck/a"}
    if hostname == "duckduckgo.com":
        # /l/ 是 DDG 跳转链接，由 redirects 解析，不应过滤
        return (path in {"/", "/html/", "/html"} and "q" in query)
    if _host_match(hostname, "sogou.com"):
        return path.startswith(("/web", "/link"))
    if hostname == "search.brave.com":
        return path == "/search"
    if _host_match(hostname, "baidu.com"):
        return path in {"/s", "/baidu"} or path.startswith("/from=")
    if hostname in ("yandex.com", "yandex.ru"):
        return path == "/search"
    return False
