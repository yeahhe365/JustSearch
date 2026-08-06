import base64
import html
import re
import urllib.parse


async def resolve_redirect_url(url: str, log_func=None) -> str:
    """Resolve search-engine redirect URLs to their final target URLs."""
    final_url = url
    is_bing = _is_bing_redirect_url(url)
    is_google = _is_google_redirect_url(url)
    is_duckduckgo = _is_duckduckgo_redirect_url(url)
    is_sogou = _is_sogou_link_url(url)
    is_baidu = _is_baidu_link_url(url)
    if not (is_bing or is_google or is_duckduckgo or is_sogou or is_baidu):
        return final_url

    if log_func:
        log_func("浏览器: 检测到重定向 URL，正在尝试提取目标...")

    if is_baidu:
        try:
            target = await _resolve_baidu_link_url(url)
            if target and _is_http_url(target):
                final_url = target
                if log_func:
                    log_func(f"浏览器: 提取百度重定向 URL 成功: {final_url}")
        except Exception as e:
            if log_func:
                log_func(f"浏览器: 提取百度重定向 URL 失败: {e}")

    if is_duckduckgo:
        try:
            parsed = urllib.parse.urlparse(url)
            params = urllib.parse.parse_qs(parsed.query)
            if "uddg" in params and _is_http_url(params["uddg"][0]):
                final_url = params["uddg"][0]
                if log_func:
                    log_func(f"浏览器: 提取 DuckDuckGo 重定向 URL 成功: {final_url}")
        except Exception as e:
            if log_func:
                log_func(f"浏览器: 提取 DuckDuckGo 重定向 URL 失败: {e}")

    elif is_bing:
        try:
            decoded_url = decode_bing_redirect_url(url)
            if decoded_url:
                final_url = decoded_url
                if log_func:
                    log_func(f"浏览器: 提取 Bing 重定向 URL 成功: {final_url}")
        except Exception as e:
            if log_func:
                log_func(f"浏览器: 提取 Bing 重定向 URL 失败: {e}")

    elif is_google:
        try:
            parsed = urllib.parse.urlparse(url)
            params = urllib.parse.parse_qs(parsed.query)
            for key in ("url", "q"):
                candidate = params.get(key, [""])[0]
                if _is_http_url(candidate):
                    final_url = candidate
                    if log_func:
                        log_func(f"浏览器: 提取 Google 重定向 URL 成功: {final_url}")
                    break
        except Exception as e:
            if log_func:
                log_func(f"浏览器: 提取 Google 重定向 URL 失败: {e}")

    elif is_sogou:
        try:
            html_text = await _fetch_sogou_redirect_html(url)
            extracted_url = _extract_html_redirect_url(html_text)
            if extracted_url:
                final_url = extracted_url
                if log_func:
                    log_func(f"浏览器: 提取 Sogou 重定向 URL 成功: {final_url}")
        except Exception as e:
            if log_func:
                log_func(f"浏览器: 提取 Sogou 重定向 URL 失败: {e}")

    return final_url


def _hostname_matches(hostname: str, domain: str) -> bool:
    hostname = (hostname or "").lower().rstrip(".")
    domain = domain.lower()
    return hostname == domain or hostname.endswith(f".{domain}")


def decode_bing_redirect_url(url: str) -> str:
    """Decode a Bing /ck/a redirect's `u=a1<base64>` parameter to its target URL.

    Returns the decoded http(s) URL, or '' when the input is not a Bing redirect
    wrapper or cannot be decoded. Shared by redirects.resolve_redirect_url and
    workflow's URL-normalization (which applies its own lower/trim post-processing).
    """
    try:
        parsed = urllib.parse.urlparse(url)
        if not _hostname_matches(parsed.hostname or "", "bing.com"):
            return ""
        if not parsed.path.startswith("/ck/a"):
            return ""
        u_val = urllib.parse.parse_qs(parsed.query).get("u", [""])[0]
        if not u_val.startswith("a1"):
            return ""
        b64_part = u_val[2:]
        b64_part += "=" * ((4 - len(b64_part) % 4) % 4)
        decoded = base64.urlsafe_b64decode(b64_part).decode("utf-8", errors="ignore")
        if _is_http_url(decoded):
            return decoded
    except Exception:
        pass
    return ""


def _is_http_url(url: str) -> bool:
    try:
        parsed = urllib.parse.urlparse(url)
    except Exception:
        return False
    return parsed.scheme in {"http", "https"} and bool(parsed.hostname)


def _is_bing_redirect_url(url: str) -> bool:
    try:
        parsed = urllib.parse.urlparse(url)
    except Exception:
        return False
    return _hostname_matches(parsed.hostname or "", "bing.com") and parsed.path.startswith("/ck/a")


def _is_google_redirect_url(url: str) -> bool:
    try:
        parsed = urllib.parse.urlparse(url)
    except Exception:
        return False
    return _hostname_matches(parsed.hostname or "", "google.com") and parsed.path == "/url"


def _is_duckduckgo_redirect_url(url: str) -> bool:
    try:
        parsed = urllib.parse.urlparse(url)
    except Exception:
        return False
    return _hostname_matches(parsed.hostname or "", "duckduckgo.com") and parsed.path.startswith("/l/")


def _is_sogou_link_url(url: str) -> bool:
    """Return True for Sogou result-wrapper URLs."""
    try:
        parsed = urllib.parse.urlparse(url)
    except Exception:
        return False

    hostname = parsed.hostname or ""
    return _hostname_matches(hostname, "sogou.com") and parsed.path.startswith("/link")


def _is_baidu_link_url(url: str) -> bool:
    """Return True for Baidu result-wrapper URLs (baidu.com/link?url=...)."""
    try:
        parsed = urllib.parse.urlparse(url)
    except Exception:
        return False

    hostname = parsed.hostname or ""
    return _hostname_matches(hostname, "baidu.com") and parsed.path.startswith("/link")


async def _resolve_baidu_link_url(url: str) -> str:
    """Follow a baidu.com/link?url=... redirect to its final target.

    百度 link 页返回的是 JS 跳转(类似搜狗),也可能直接 302。先试 no-follow
    拿响应体,再从 HTML/JS 里抽目标 URL;若响应头有 Location 直接用。
    """
    import httpx

    async with httpx.AsyncClient(
        follow_redirects=False,
        timeout=10.0,
        headers={"User-Agent": "JustSearch/1.0"},
    ) as client:
        response = await client.get(url)
        # 302/301 直接读 Location
        location = response.headers.get("location", "")
        if location and _is_http_url(location):
            return location
        # 否则从响应体里抽 JS/meta 跳转目标
        target = _extract_html_redirect_url(response.text)
        if target:
            return target
    return ""


async def _fetch_sogou_redirect_html(url: str) -> str:
    """Fetch the lightweight Sogou wrapper page used to hold JS redirects."""
    import httpx

    async with httpx.AsyncClient(
        follow_redirects=False,
        timeout=10.0,
        headers={"User-Agent": "JustSearch/1.0"},
    ) as client:
        response = await client.get(url)
        response.raise_for_status()
        return response.text


def _extract_html_redirect_url(html_text: str) -> str:
    """Extract a target URL from script/meta HTML redirects."""
    if not html_text:
        return ""

    patterns = [
        r"""window\.location(?:\.replace)?\(\s*["']([^"']+)["']\s*\)""",
        r"""location\.href\s*=\s*["']([^"']+)["']""",
        r"""http-equiv=["']refresh["'][^>]+content=["'][^"']*url=([^"']+)["']""",
        r"""content=["'][^"']*url=([^"']+)["'][^>]+http-equiv=["']refresh["']""",
    ]

    for pattern in patterns:
        match = re.search(pattern, html_text, re.IGNORECASE)
        if not match:
            continue
        candidate = html.unescape(match.group(1)).strip(" '\"")
        if candidate.startswith(("http://", "https://")):
            return candidate
    return ""
