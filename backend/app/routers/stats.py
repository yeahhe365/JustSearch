"""
Stats router – /api/stats/github, /api/health, and extension download.
"""

import io
import json
import logging
import os
import re
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from ..version import __version__

logger = logging.getLogger(__name__)

_PROJECT_ROOT = Path(__file__).resolve().parents[3]
_EXTENSION_DIR = _PROJECT_ROOT / "extension"
_ZIP_SKIP_NAMES = {".DS_Store", "Thumbs.db"}
_ZIP_SKIP_DIR_NAMES = {"__pycache__", "node_modules", ".git"}

_bundled_extension_version_cache: tuple[float, Optional[str]] | None = None

# Process start time for uptime tracking
_START_TIME = time.monotonic()

router = APIRouter()

# ---------------------------------------------------------------------------
# GitHub stars cache
# ---------------------------------------------------------------------------
# GitHub star 缓存：时间戳一律用 time.monotonic()（单调时钟），避免系统
# 墙钟在 DST/校时回拨时把 TTL 窗口拉长或缩短。字段存的是 float 秒。
github_stats_cache = {
    "stars": 0,
    "last_updated": None,
    "last_error_at": None,
    "error": "",
}
GITHUB_STATS_CACHE_TTL_SECONDS = 600
GITHUB_STATS_ERROR_CACHE_TTL_SECONDS = 60
GITHUB_REPO_API_URL = "https://api.github.com/repos/yeahhe365/JustSearch"

_httpx_client: httpx.AsyncClient | None = None


def set_httpx_client(client: httpx.AsyncClient | None):
    """Called from main.py lifespan to share the httpx client."""
    global _httpx_client
    _httpx_client = client


def _cache_github_success(stars: int, fetched_at: float) -> dict:
    github_stats_cache["stars"] = stars
    github_stats_cache["last_updated"] = fetched_at
    github_stats_cache["last_error_at"] = None
    github_stats_cache["error"] = ""
    return {"stars": stars}


def _cache_github_error(error: str, failed_at: float) -> dict:
    github_stats_cache["last_error_at"] = failed_at
    # error 只存通用文案；完整异常由调用方写服务端日志，绝不外发/缓存。
    github_stats_cache["error"] = error
    return {"stars": github_stats_cache["stars"], "error": error}


async def _fetch_github_repo_stats():
    if _httpx_client:
        return await _httpx_client.get(GITHUB_REPO_API_URL)
    async with httpx.AsyncClient() as client:
        return await client.get(GITHUB_REPO_API_URL)


@router.get("/api/stats/github")
async def get_github_stats():
    now = time.monotonic()
    if (
        github_stats_cache["last_updated"] is not None
        and now - github_stats_cache["last_updated"] < GITHUB_STATS_CACHE_TTL_SECONDS
    ):
        return {"stars": github_stats_cache["stars"]}

    if (
        github_stats_cache["last_error_at"] is not None
        and now - github_stats_cache["last_error_at"] < GITHUB_STATS_ERROR_CACHE_TTL_SECONDS
    ):
        return {"stars": github_stats_cache["stars"], "error": github_stats_cache.get("error") or "Failed to fetch from GitHub"}

    try:
        response = await _fetch_github_repo_stats()
        if response.status_code == 200:
            data = response.json()
            return _cache_github_success(data.get("stargazers_count", 0), now)
        return _cache_github_error("Failed to fetch from GitHub", now)
    except Exception as e:
        logger.error("GitHub stats fetch failed: %s", e, exc_info=True)
        return _cache_github_error("Failed to fetch from GitHub", now)


@router.get("/api/engines")
async def get_engines():
    """Return list of available search engines."""
    from ..search_engine import get_all_engines
    return {"engines": get_all_engines()}


def _parse_semver_tuple(value: str | None) -> tuple[int, ...]:
    """Parse a loose semver string into comparable integer parts."""
    if not value:
        return (0,)
    cleaned = str(value).strip().lstrip("vV")
    # Drop pre-release / build metadata: 1.2.3-beta+meta -> 1.2.3
    cleaned = re.split(r"[+\-]", cleaned, maxsplit=1)[0]
    parts: list[int] = []
    for chunk in cleaned.split("."):
        if chunk.isdigit():
            parts.append(int(chunk))
        else:
            match = re.match(r"^(\d+)", chunk)
            if match:
                parts.append(int(match.group(1)))
            else:
                break
    return tuple(parts) if parts else (0,)


def compare_extension_versions(left: str | None, right: str | None) -> int:
    """Return -1/0/1 when left is older/equal/newer than right."""
    left_parts = _parse_semver_tuple(left)
    right_parts = _parse_semver_tuple(right)
    width = max(len(left_parts), len(right_parts))
    left_parts = left_parts + (0,) * (width - len(left_parts))
    right_parts = right_parts + (0,) * (width - len(right_parts))
    if left_parts < right_parts:
        return -1
    if left_parts > right_parts:
        return 1
    return 0


def get_bundled_extension_version() -> Optional[str]:
    """Read the server-shipped extension version from extension/manifest.json."""
    global _bundled_extension_version_cache
    manifest_path = _EXTENSION_DIR / "manifest.json"
    try:
        mtime = manifest_path.stat().st_mtime
    except OSError:
        return None

    if (
        _bundled_extension_version_cache is not None
        and _bundled_extension_version_cache[0] == mtime
    ):
        return _bundled_extension_version_cache[1]

    version: Optional[str] = None
    try:
        with open(manifest_path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        raw = payload.get("version") if isinstance(payload, dict) else None
        if raw is not None and str(raw).strip():
            version = str(raw).strip()
    except (OSError, json.JSONDecodeError, TypeError, ValueError) as exc:
        logger.warning("[extension] failed to read bundled version: %s", exc)
        version = None

    _bundled_extension_version_cache = (mtime, version)
    return version


def classify_extension_version(
    installed: str | None,
    latest: str | None,
    *,
    connected: bool,
) -> dict:
    """Compare installed extension version against the server-bundled latest."""
    if not latest:
        return {
            "latest_extension_version": None,
            "extension_version_status": "unknown",
            "update_available": False,
            "is_latest": None,
        }
    if not connected:
        return {
            "latest_extension_version": latest,
            "extension_version_status": "disconnected",
            "update_available": False,
            "is_latest": None,
        }
    if not installed:
        return {
            "latest_extension_version": latest,
            "extension_version_status": "unknown",
            "update_available": False,
            "is_latest": None,
        }

    cmp = compare_extension_versions(installed, latest)
    if cmp < 0:
        status = "outdated"
        update_available = True
        is_latest = False
    elif cmp > 0:
        status = "newer"
        update_available = False
        is_latest = True  # newer than server package still "fine"
    else:
        status = "latest"
        update_available = False
        is_latest = True

    return {
        "latest_extension_version": latest,
        "extension_version_status": status,
        "update_available": update_available,
        "is_latest": is_latest,
    }


def _build_extension_zip_bytes() -> bytes:
    """Zip the on-disk extension/ directory into justsearch-bridge/* entries."""
    if not _EXTENSION_DIR.is_dir():
        raise FileNotFoundError(f"extension directory not found: {_EXTENSION_DIR}")

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(_EXTENSION_DIR.rglob("*")):
            if not path.is_file():
                continue
            if path.name in _ZIP_SKIP_NAMES:
                continue
            if any(part in _ZIP_SKIP_DIR_NAMES for part in path.parts):
                continue
            relative = path.relative_to(_EXTENSION_DIR)
            archive.write(path, arcname=str(Path("justsearch-bridge") / relative))
    return buffer.getvalue()


@router.get("/api/extension/download")
async def download_extension_package():
    """Download a zip of the Chrome bridge extension for local install."""
    try:
        payload = _build_extension_zip_bytes()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="扩展目录不存在，无法打包下载") from exc
    except OSError as exc:
        logger.exception("[extension] failed to build zip")
        raise HTTPException(status_code=500, detail="扩展打包失败") from exc

    headers = {
        "Content-Disposition": 'attachment; filename="justsearch-bridge.zip"',
        "Cache-Control": "no-store",
    }
    return StreamingResponse(
        io.BytesIO(payload),
        media_type="application/zip",
        headers=headers,
    )


@router.get("/api/health")
async def health_check():
    from ..extension_bridge import get_bridge_client, get_extension_info, get_ws_endpoint, is_extension_connected
    from ..database import _DB_PATH, _engine

    # Memory usage info
    mem_mb = 0
    db_size_mb = 0
    try:
        import psutil
        process = psutil.Process(os.getpid())
        mem_info = process.memory_info()
        mem_mb = round(mem_info.rss / 1024 / 1024, 1)
    except ImportError:
        pass
    except Exception:
        pass

    # Database file size
    try:
        if os.path.exists(_DB_PATH):
            db_size_mb = round(os.path.getsize(_DB_PATH) / 1024 / 1024, 2)
    except Exception:
        pass

    # Uptime calculation
    uptime_seconds = int(time.monotonic() - _START_TIME)

    extension_connected = is_extension_connected()
    extension_info = get_extension_info()
    # If the extension is online but hasn't sent hello/version yet, probe once.
    if extension_connected and not extension_info.get("version"):
        try:
            await get_bridge_client().health_check()
            extension_info = get_extension_info()
        except Exception:
            pass
    ws_url = get_ws_endpoint()
    # For Docker/host mapping the extension always connects via loopback on the host.
    extension_ws_url = ws_url
    if "0.0.0.0" in extension_ws_url:
        extension_ws_url = extension_ws_url.replace("0.0.0.0", "127.0.0.1")

    latest_extension_version = get_bundled_extension_version()
    version_meta = classify_extension_version(
        extension_info.get("version"),
        latest_extension_version,
        connected=extension_connected,
    )

    return {
        "status": "ok",
        "version": __version__,
        "browser": extension_connected,
        "bridge": {
            "extension_connected": extension_connected,
            "extension_name": extension_info.get("name"),
            "extension_version": extension_info.get("version"),
            "extension_instance_id": extension_info.get("instance_id"),
            "conn_id": extension_info.get("conn_id"),
            **version_meta,
            "ws_url": extension_ws_url,
            "download_url": "/api/extension/download",
            "install_hint": (
                "Chrome → chrome://extensions → 开发者模式 → "
                "加载已解压的扩展程序 → 选择 justsearch-bridge 目录"
            ),
        },
        "db_pool_size": (getattr(_engine.pool, "size", lambda: 0)() if _engine and hasattr(_engine, 'pool') else 0),
        "db_pool_checked_out": (getattr(_engine.pool, "checkedout", lambda: 0)() if _engine and hasattr(_engine, 'pool') else 0),
        "memory_mb": mem_mb,
        "db_size_mb": db_size_mb,
        "uptime_seconds": uptime_seconds,
        # 全库统一 naive-UTC 约定（见 database.py），加 Z 后缀明确语义；
        # 用 timezone-aware now 再剥掉 tzinfo，避免 utcnow() 的弃用告警
        "timestamp": datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z",
    }
