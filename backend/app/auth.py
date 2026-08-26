import ipaddress
import json
import os
import secrets
from urllib.parse import urlparse
from pathlib import Path
from typing import Callable

from fastapi import WebSocket
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

_AUTH_TOKEN_CACHE: str | None = None
_TOKEN_ENV_VAR = "JUSTSEARCH_AUTH_TOKEN"
_TOKEN_FILE_ENV_VAR = "JUSTSEARCH_AUTH_TOKEN_FILE"
_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}
# Host → Docker published port 在容器内表现为 bridge 网关 (通常 *.*.*.1)。
# 绝不能信任整个 172.16.0.0/12：同网其它容器 / 云 VPC 也会落在该段。
_DOCKER_BRIDGE_GATEWAY_NETWORKS = (
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("10.0.0.0/8"),
)
_PROTECTED_HTTP_PREFIXES = ("/api",)
_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_DATA_DIR = _PROJECT_ROOT / "data"
_LEGACY_AUTH_TOKEN_PATH = Path(__file__).resolve().parents[1] / ".auth_token"


def get_auth_token_path() -> Path:
    configured = os.getenv(_TOKEN_FILE_ENV_VAR, "").strip()
    if configured:
        return Path(configured).expanduser()
    return _DATA_DIR / ".auth_token"


def get_legacy_auth_token_path() -> Path:
    return _LEGACY_AUTH_TOKEN_PATH


def is_auth_enabled() -> bool:
    val = os.getenv("JUSTSEARCH_AUTH_ENABLED", "").strip().lower()
    if val in ("false", "0", "no", "off"):
        return False
    return True


def _parse_ip_host(host: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    try:
        return ipaddress.ip_address(host)
    except ValueError:
        return None


def _running_in_container() -> bool:
    """是否运行在容器内——决定 bridge 网关信任规则是否启用。

    网关规则的前提（宿主机→发布端口的连接表现为 x.x.x.1）只在容器内成立；
    裸机上源地址恰为 10/8、172.16/12 内 .1 的对端是真实路由器/VPC 网关，
    绝不能免 token 信任。判定顺序：显式环境变量 > /.dockerenv 存在性。
    """
    raw = os.getenv("JUSTSEARCH_TRUST_BRIDGE_GATEWAY", "").strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    return Path("/.dockerenv").exists()


def _is_docker_bridge_gateway(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """True only for typical Docker/libnetwork bridge gateways (last octet == 1).

    Peer containers get addresses like 172.17.0.2 and must still present a token.
    仅当运行在容器内时生效（见 _running_in_container）。
    """
    if not _running_in_container():
        return False
    if not isinstance(ip, ipaddress.IPv4Address):
        return False
    if not any(ip in network for network in _DOCKER_BRIDGE_GATEWAY_NETWORKS):
        return False
    return int(ip.packed[-1]) == 1


def _is_loopback_host_value(host: str | None) -> bool:
    """严格回环判定（localhost / 127.0.0.0/8 / ::1），不含 Docker 网关规则。

    与 ``is_loopback_host`` 的区别：后者额外信任 Docker bridge 网关地址
    (*.*.*.1)，适用于“客户端 IP”判定；而 Host 头（页面所在主机名）必须
    严格回环，才能走免 token 的本地直连流程。
    """
    if not host:
        return False
    normalized = str(host).strip().lower()
    if normalized.startswith("::ffff:"):
        normalized = normalized[7:]
    if normalized in _LOOPBACK_HOSTS:
        return True
    ip = _parse_ip_host(normalized)
    return ip is not None and ip.is_loopback


def is_loopback_host(host: str | None) -> bool:
    if not host:
        return False
    normalized = host.strip().lower()
    if normalized in _LOOPBACK_HOSTS:
        return True
    if normalized.startswith("::ffff:"):
        normalized = normalized[7:]
    if normalized in _LOOPBACK_HOSTS:
        return True
    ip = _parse_ip_host(normalized)
    if ip is None:
        return False
    if ip.is_loopback:
        return True
    # Docker published-port clients appear as the bridge gateway (e.g. 172.17.0.1).
    return _is_docker_bridge_gateway(ip)


def _is_trusted_local_client(client_host: str | None) -> bool:
    """客户端 IP 可信：严格回环，或 Docker bridge 网关（宿主机→发布端口）。"""
    if not client_host:
        return False
    normalized = client_host.strip().lower()
    if normalized.startswith("::ffff:"):
        normalized = normalized[7:]
    ip = _parse_ip_host(normalized)
    if ip is None:
        return False
    return ip.is_loopback or _is_docker_bridge_gateway(ip)


def _request_host_is_loopback(request) -> bool:
    """请求 Host 头的 hostname 必须是回环，才允许免 token 的本地直连流程。

    防 DNS rebinding：Host 为外部域名（即使解析到 127.0.0.1）时，浏览器同站
    导航通常不带 Origin 头，仅凭可信客户端 IP 无法区分真实本机用户与重绑定
    攻击；此时一律退回正常的 token 校验流程。
    """
    host_value = (request.headers.get("host") or "").strip().lower()
    if not host_value:
        return False
    # 去掉端口：IPv6 形如 [::1]:8000，其余按最后一个 ':' 分割。
    if host_value.startswith("["):
        end = host_value.find("]")
        raw_hostname = host_value[1:end] if end != -1 else ""
    else:
        raw_hostname = host_value.rsplit(":", 1)[0]
    return _is_loopback_host_value(raw_hostname)


def get_auth_token() -> str:
    global _AUTH_TOKEN_CACHE

    env_token = os.getenv(_TOKEN_ENV_VAR, "").strip()
    if env_token:
        _AUTH_TOKEN_CACHE = env_token
        return env_token

    if _AUTH_TOKEN_CACHE:
        return _AUTH_TOKEN_CACHE

    token_path = get_auth_token_path()
    token_path.parent.mkdir(parents=True, exist_ok=True)

    existing = _read_token_file(token_path)
    if existing:
        _AUTH_TOKEN_CACHE = existing
        return existing

    migrated = _migrate_legacy_auth_token(token_path)
    if migrated:
        _AUTH_TOKEN_CACHE = migrated
        return migrated

    token = secrets.token_urlsafe(32)
    _write_token_file(token_path, token)

    _AUTH_TOKEN_CACHE = token
    return token


def _read_token_file(token_path: Path) -> str:
    if not token_path.exists():
        return ""
    return token_path.read_text(encoding="utf-8").strip()


def _write_token_file(token_path: Path, token: str) -> None:
    token_path.parent.mkdir(parents=True, exist_ok=True)
    token_path.write_text(token, encoding="utf-8")
    try:
        os.chmod(token_path, 0o600)
    except OSError:
        pass


def _migrate_legacy_auth_token(token_path: Path) -> str:
    legacy_path = get_legacy_auth_token_path()
    if legacy_path == token_path:
        return ""

    existing = _read_token_file(legacy_path)
    if not existing:
        return ""

    _write_token_file(token_path, existing)
    return existing


def get_bearer_token(headers) -> str:
    auth_header = headers.get("authorization", "").strip()
    if not auth_header.lower().startswith("bearer "):
        return ""
    return auth_header.split(" ", 1)[1].strip()


def get_request_token(request: Request) -> str:
    return get_bearer_token(request.headers) or request.query_params.get("token", "").strip()


def is_trusted_loopback_origin(origin: str | None) -> bool:
    if not origin:
        return True

    parsed = urlparse(origin)
    return is_loopback_host(parsed.hostname)


_ALLOWED_EXTENSION_IDS = {s.strip().lower() for s in os.getenv("JUSTSEARCH_ALLOWED_EXTENSION_IDS", "").split(",") if s.strip()}

def is_trusted_websocket_origin(origin: str | None) -> bool:
    """Allow empty origin, loopback pages, and Chrome extension bridge clients."""
    if not origin:
        return True
    if is_trusted_loopback_origin(origin):
        return True
    parsed = urlparse(origin)
    if parsed.scheme != "chrome-extension":
        return False
    # 若配置了白名单，则校验扩展 ID
    if _ALLOWED_EXTENSION_IDS:
        ext_id = (parsed.hostname or "").lower()
        return ext_id in _ALLOWED_EXTENSION_IDS
    # 未配置白名单时仍允许任意扩展（兼容现有部署），但需 loopback IP 已校验
    return True


def is_http_request_authorized(
    request: Request,
    token_provider: Callable[[], str] = get_auth_token,
) -> bool:
    if not is_auth_enabled():
        return True
    client_host = request.client.host if request.client else None
    # 双重门槛：客户端 IP 可信（严格回环或 Docker 网关）**且** Host 头为回环，
    # 才允许走免 token 的本地直连流程；Host 为外部域名（DNS rebinding）时
    # 一律要求正常 token。
    if _is_trusted_local_client(client_host) and _request_host_is_loopback(request):
        return is_trusted_loopback_origin(request.headers.get("origin"))

    expected = token_provider()
    provided = get_request_token(request)
    return bool(provided) and secrets.compare_digest(provided, expected)


async def authorize_websocket(
    websocket: WebSocket,
    token_provider: Callable[[], str] = get_auth_token,
) -> bool:
    if not is_auth_enabled():
        return True
    client_host = websocket.client.host if websocket.client else None
    if is_loopback_host(client_host):
        if is_trusted_websocket_origin(websocket.headers.get("origin")):
            return True
        await websocket.close(code=4401, reason="Unauthorized")
        return False

    expected = token_provider()
    provided = get_bearer_token(websocket.headers) or websocket.query_params.get("token", "").strip()
    if provided and secrets.compare_digest(provided, expected):
        return True

    await websocket.close(code=4401, reason="Unauthorized")
    return False


def build_html_bootstrap_payload(request: Request) -> dict:
    if not is_auth_enabled():
        return {
            "authEnabled": False,
            "clientIsLoopback": False,
        }
    client_host = request.client.host if request.client else None
    # 与 is_http_request_authorized 相同的双重门槛：真实 token 只注入给
    # “可信客户端 IP + 回环 Host”的页面，防止 DNS rebinding 页面拿到 token。
    trusted_local_page = _is_trusted_local_client(client_host) and _request_host_is_loopback(request)
    payload = {
        "authEnabled": True,
        "clientIsLoopback": trusted_local_page,
    }
    if trusted_local_page:
        payload["authToken"] = get_auth_token()
    return payload


def inject_html_bootstrap(html: str, payload: dict) -> str:
    script = (
        "<script>"
        f"window.__JUSTSEARCH_BOOTSTRAP__ = {json.dumps(payload, ensure_ascii=False)};"
        "</script>"
    )
    if "</head>" in html:
        return html.replace("</head>", f"{script}\n</head>", 1)
    return f"{script}\n{html}"


class AccessControlMiddleware(BaseHTTPMiddleware):
    def __init__(
        self,
        app,
        token_provider: Callable[[], str] = get_auth_token,
        protected_prefixes: tuple[str, ...] = _PROTECTED_HTTP_PREFIXES,
    ):
        super().__init__(app)
        self.token_provider = token_provider
        self.protected_prefixes = protected_prefixes

    def _is_protected_path(self, path: str) -> bool:
        for prefix in self.protected_prefixes:
            if path == prefix or path.startswith(f"{prefix}/"):
                return True
        return False

    async def dispatch(self, request: Request, call_next):
        if not is_auth_enabled():
            return await call_next(request)

        if request.method == "OPTIONS" or not self._is_protected_path(request.url.path):
            return await call_next(request)

        if is_http_request_authorized(request, self.token_provider):
            return await call_next(request)
        return JSONResponse(
            {"detail": "Unauthorized. Provide a valid Bearer token."},
            status_code=401,
            headers={"WWW-Authenticate": "Bearer"},
        )
