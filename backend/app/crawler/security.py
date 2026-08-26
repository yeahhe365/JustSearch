import ipaddress
import socket
import urllib.parse


_PROXY_EXCEPTION_NETWORKS = (
    # 本地代理工具（Surge/Clash 等）可能把域名解析到 198.18.0.0/15。
    ipaddress.ip_network("198.18.0.0/15"),
)


def _is_blocked_ip(ip: ipaddress._BaseAddress) -> bool:
    if any(ip in network for network in _PROXY_EXCEPTION_NETWORKS):
        return False
    return not ip.is_global


def _normalize_ip_literal(hostname: str) -> str | None:
    """将异形 IP 字面量归一化为点分十进制，支持 0x/0 前缀及整数形式。"""
    h = hostname.strip().lower()
    # 纯整数形式: 2130706433 -> 127.0.0.1
    if h.isdigit() or (h.startswith("0x") and all(c in "0123456789abcdef" for c in h[2:])):
        try:
            val = int(h, 0)
            if 0 <= val <= 0xFFFFFFFF:
                return ".".join(str((val >> (8 * i)) & 0xFF) for i in (3, 2, 1, 0))
        except ValueError:
            pass
        return None
    # 四段式，允许每段 0x/0 前缀
    if "." in h:
        parts = h.split(".")
        if 1 <= len(parts) <= 4:
            try:
                nums = []
                for p in parts:
                    p = p.strip()
                    if not p:
                        return None
                    nums.append(int(p, 0))
                    if not 0 <= nums[-1] <= 255:
                        # 超过 255 可能为大端整数的变体，直接按整数处理
                        raise ValueError
                if len(nums) == 4:
                    return ".".join(str(n) for n in nums)
                # 3/2/1 段的简写按 inet_aton 规则展开
                if len(nums) == 1:
                    v = nums[0]
                    return ".".join(str((v >> (8 * i)) & 0xFF) for i in (3, 2, 1, 0))
            except ValueError:
                return None
    return None


def _ip_from_hostname(hostname: str) -> ipaddress._BaseAddress | None:
    # 先归一化异形字面量
    normalized = _normalize_ip_literal(hostname)
    candidate = normalized if normalized is not None else hostname
    try:
        ip = ipaddress.ip_address(candidate)
        return getattr(ip, "ipv4_mapped", None) or ip
    except ValueError:
        return None


def is_private_url(url: str) -> bool:
    """Check if a URL points to a private/internal network address."""
    try:
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in {"http", "https"}:
            return True

        hostname = parsed.hostname
        if not hostname:
            return True

        # localhost 含尾点、大小写不敏感
        normalized_host = hostname.rstrip(".").lower()
        if normalized_host in ("localhost", "localhost.localdomain"):
            return True
        # IPv6 映射的 localhost 形如 ::ffff:127.0.0.1 已在 _ip_from_hostname 覆盖

        direct_ip = _ip_from_hostname(hostname)
        if direct_ip is not None:
            # 与 DNS 解析路径使用同一判定：198.18.0.0/15 fake-IP 代理兼容
            # 在 _is_blocked_ip 内对两条路径统一放行（刻意为之）。
            return _is_blocked_ip(direct_ip)

        addrinfo = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
        for _family, _type, _proto, _canonname, sockaddr in addrinfo:
            ip = ipaddress.ip_address(sockaddr[0])
            if _is_blocked_ip(ip):
                return True
    except (socket.gaierror, ValueError, OSError):
        return True

    return False
