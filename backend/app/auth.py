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


def _is_docker_bridge_gateway(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """True only for typical Docker/libnetwork bridge gateways (last octet == 1).

    Peer containers get addresses like 172.17.0.2 and must still present a token.
    """
    if not isinstance(ip, ipaddress.IPv4Address):
        return False
    if not any(ip in network for network in _DOCKER_BRIDGE_GATEWAY_NETWORKS):
        return False
    return int(ip.packed[-1]) == 1


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


def is_trusted_websocket_origin(origin: str | None) -> bool:
    """Allow empty origin, loopback pages, and Chrome extension bridge clients."""
    if not origin:
        return True
    if is_trusted_loopback_origin(origin):
        return True
    parsed = urlparse(origin)
    return parsed.scheme == "chrome-extension"


def is_http_request_authorized(
    request: Request,
    token_provider: Callable[[], str] = get_auth_token,
) -> bool:
    if not is_auth_enabled():
        return True
    client_host = request.client.host if request.client else None
    if is_loopback_host(client_host):
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
    trusted_local_page = is_loopback_host(client_host)
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
