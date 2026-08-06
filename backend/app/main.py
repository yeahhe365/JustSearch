import asyncio
import os
import logging
import httpx
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from starlette.requests import Request

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Load project .env before importing app modules that read environment variables at import time.
load_dotenv(os.path.join(_PROJECT_ROOT, ".env"))

from .auth import (
    AccessControlMiddleware,
    build_html_bootstrap_payload,
    get_auth_token,
    inject_html_bootstrap,
)
from .database import init_db
from .extension_bridge import (
    get_ws_route_path,
    handle_extension_websocket,
    init_bridge,
    shutdown_bridge,
)
from .routers import chat as chat_router
from .routers import history as history_router
from .routers import settings as settings_router
from .routers import stats as stats_router
from .version import __version__

# Background cleanup task
_cleanup_task = None


async def _periodic_cleanup():
    """Periodically clean up in-memory caches."""
    while True:
        try:
            await asyncio.sleep(300)  # Every 5 minutes
            # Clean expired search cache
            from .browser_manager import _search_cache, _SEARCH_CACHE_TTL
            import time
            now = time.time()
            expired = [k for k, (_, ts) in _search_cache.items() if now - ts > _SEARCH_CACHE_TTL]
            for k in expired:
                del _search_cache[k]
            if expired:
                logger.debug("Cleaned %d expired search cache entries", len(expired))
            # 关闭桥接中残留的临时 tab。
            from .extension_bridge import get_bridge_client
            try:
                client = get_bridge_client()
                # 无需操作,TabPool 是每任务建;这里只是确认连接。
                _ = client
            except Exception:
                pass
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error("Cleanup task error: %s", e)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Shared httpx client (used by stats router)
# ---------------------------------------------------------------------------
_httpx_client: httpx.AsyncClient | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _httpx_client

    # Startup
    from .logging_utils import setup_logging
    setup_logging(
        level=logging.DEBUG if os.getenv("DEBUG", "").lower() == "true" else logging.INFO
    )
    logger.info("Startup: Loaded app from %s", __file__)

    # Initialise database (creates tables, runs legacy migration)
    await init_db()

    _httpx_client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=10.0))
    stats_router.set_httpx_client(_httpx_client)

    await init_bridge()

    # Start periodic cleanup
    global _cleanup_task
    _cleanup_task = asyncio.create_task(_periodic_cleanup())

    logger.debug("Registered routes:")
    for route in app.routes:
        if hasattr(route, "path"):
            logger.debug("  %s", route.path)

    yield

    # Shutdown
    if _cleanup_task:
        _cleanup_task.cancel()
        try:
            await _cleanup_task
        except asyncio.CancelledError:
            pass

    if _httpx_client:
        await _httpx_client.aclose()
        _httpx_client = None
        stats_router.set_httpx_client(None)
    await shutdown_bridge()


app = FastAPI(title="JustSearch", lifespan=lifespan)

# ---------------------------------------------------------------------------
# GZip compression
# ---------------------------------------------------------------------------
from starlette.middleware.gzip import GZipMiddleware
app.add_middleware(GZipMiddleware, minimum_size=500)

# ---------------------------------------------------------------------------
# CORS
# ---------------------------------------------------------------------------
_cors_origins_str = os.getenv(
    "CORS_ORIGINS",
    "http://localhost:8000,http://127.0.0.1:8000,http://localhost,http://127.0.0.1",
)
_cors_origins = [o.strip() for o in _cors_origins_str.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(AccessControlMiddleware, token_provider=get_auth_token)


# ---------------------------------------------------------------------------
# Cache headers for static assets
# ---------------------------------------------------------------------------
@app.middleware("http")
async def cache_control_middleware(request, call_next):
    """Add cache and security headers + request timing."""
    import time as _time
    import uuid as _uuid
    start = _time.monotonic()
    response = await call_next(request)
    elapsed = _time.monotonic() - start
    request_id = str(_uuid.uuid4())[:8]
    response.headers["X-Response-Time"] = f"{elapsed:.3f}s"
    response.headers["X-Request-ID"] = request_id
    # Log slow requests
    if elapsed > 5.0:
        logger.warning("Slow request: %s %s (%.2fs) [%s]", request.method, request.url.path, elapsed, request_id)
    path = request.url.path
    if path.startswith("/static/"):
        if path.endswith((".js", ".css")):
            # JS/CSS 文件名带版本号(?v=57),改代码后版本号会变,浏览器会拉新文件
            # 用 max-age 缓存,避免每次刷新都发 30+ 个请求
            response.headers["Cache-Control"] = "public, max-age=3600"  # 1 hour
        elif path.endswith((".png", ".jpg", ".svg", ".ico", ".woff2")):
            response.headers["Cache-Control"] = "public, max-age=604800"  # 1 week
        else:
            response.headers["Cache-Control"] = "public, max-age=3600"  # 1 hour
    # Security headers
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response

# ---------------------------------------------------------------------------
# Static Files
# ---------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC_DIR = os.path.join(BASE_DIR, "static")

if not os.path.exists(STATIC_DIR):
    os.makedirs(STATIC_DIR)

# ---------------------------------------------------------------------------
# Include routers
# ---------------------------------------------------------------------------
app.include_router(chat_router.router)
app.include_router(history_router.router)
app.include_router(settings_router.router)
app.include_router(stats_router.router)

# ---------------------------------------------------------------------------
# WebSocket Routes:浏览器桥接扩展连接
# ---------------------------------------------------------------------------
@app.websocket(get_ws_route_path())
async def extension_websocket(websocket: WebSocket):
    await handle_extension_websocket(websocket)


# ---------------------------------------------------------------------------
# Root route
# ---------------------------------------------------------------------------


def _render_index_html(request: Request) -> HTMLResponse:
    # Prefer the production build (backend/static/dist/) when present; otherwise
    # fall back to the source index.html for development.
    dist_html = os.path.join(STATIC_DIR, "dist", "index.html")
    html_path = dist_html if os.path.exists(dist_html) else os.path.join(STATIC_DIR, "index.html")
    with open(html_path, "r", encoding="utf-8") as f:
        html = f.read()
    html = inject_html_bootstrap(html, build_html_bootstrap_payload(request))
    # HTML injects a local auth bootstrap payload, so never cache the document.
    # Do NOT send Clear-Site-Data here: wiping the origin cache on every navigation
    # forces Chrome to re-download all static assets and makes refresh feel very slow
    # on long-lived profiles (incognito stays fast because the cache is empty).
    return HTMLResponse(
        content=html,
        headers={
            "Cache-Control": "no-store",
        },
    )


@app.get("/")
async def read_index(request: Request):
    return _render_index_html(request)


@app.get("/c/{session_id}")
async def read_chat_session(request: Request, session_id: str):
    """Serve the same SPA index for any chat URL — client-side routing handles the rest."""
    return _render_index_html(request)


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
