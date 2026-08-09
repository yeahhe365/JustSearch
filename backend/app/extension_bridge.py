"""JustSearch 浏览器桥接服务端 + JSON-RPC 客户端 + tab 池。

借鉴 browser-control-bridge 的架构,但简化为 JustSearch 自用:
- WebSocket 与 HTTP 共用同一 uvicorn 端口（默认 8000），路径 /justsearch。
  Chrome 扩展主动连进来,JSON-RPC 2.0 over WS。
- `BridgeClient` 把工具调用封装成 Python 异步方法,供 `browser_manager` /
  `page_crawler` 使用。所有现有的 `page.evaluate(JS)` 改走 `bridge.evaluate`。
- `TabPool` 管理并发标签数,用完即关,不在用户浏览器残留。

无 MCP 层、无 CDP allowlist(自用,信任后端发的命令)。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from typing import Any, Optional

from fastapi import WebSocket, WebSocketDisconnect

from .auth import _LOOPBACK_HOSTS, authorize_websocket

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------

DEFAULT_WS_HOST = "127.0.0.1"
DEFAULT_WS_PORT = 8000
DEFAULT_WS_PATH = "/justsearch"
DEFAULT_REQUEST_TIMEOUT_MS = 30_000

_WS_HOST = os.getenv("JUSTSEARCH_BRIDGE_WS_HOST", DEFAULT_WS_HOST).strip() or DEFAULT_WS_HOST
_WS_PORT = int(os.getenv("JUSTSEARCH_BRIDGE_WS_PORT", str(DEFAULT_WS_PORT)))
_WS_PATH = os.getenv("JUSTSEARCH_BRIDGE_WS_PATH", DEFAULT_WS_PATH).strip() or DEFAULT_WS_PATH
_REQUEST_TIMEOUT_MS = int(os.getenv("BRIDGE_REQUEST_TIMEOUT_MS", str(DEFAULT_REQUEST_TIMEOUT_MS)))
# 绑定 0.0.0.0（Docker 部署需要）时,跳过来源 loopback 校验——
# 端口映射已限定 127.0.0.1 暴露,来源一定是宿主机 loopback 上的 docker-proxy。
_REQUIRE_LOOPBACK = _WS_HOST in _LOOPBACK_HOSTS


# ---------------------------------------------------------------------------
# WS 服务端:接收扩展连接
# ---------------------------------------------------------------------------

class ExtensionConnection:
    """一条扩展 WebSocket 连接。后端通过它向扩展发 JSON-RPC 请求。"""

    def __init__(self, websocket: WebSocket):
        self.websocket = websocket
        self.id = uuid.uuid4().hex[:12]
        self.extension_instance_id: Optional[str] = None
        self.extension_name: Optional[str] = None
        self.extension_version: Optional[str] = None
        self.extension_last_hello_at: Optional[float] = None
        self._closed = False
        # JSON-RPC 客户端侧:pending 请求的 Future。
        self._next_id = 1
        self._pending: dict[int, asyncio.Future] = {}

    def apply_extension_meta(self, params: Any) -> None:
        """Update identity fields from extension hello/ping payloads."""
        if not isinstance(params, dict):
            return
        version = params.get("version") or params.get("extension_version")
        if version is not None and str(version).strip():
            self.extension_version = str(version).strip()
        name = params.get("name") or params.get("extension_name")
        if name is not None and str(name).strip():
            self.extension_name = str(name).strip()
        instance_id = (
            params.get("instance_id")
            or params.get("extension_instance_id")
            or params.get("extensionInstanceId")
        )
        if instance_id is not None and str(instance_id).strip():
            self.extension_instance_id = str(instance_id).strip()
        self.extension_last_hello_at = time.time()

    async def serve(self) -> None:
        """读循环:收扩展发来的消息,分发到响应/通知 handler。"""
        try:
            while True:
                raw = await self.websocket.receive_text()
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if not isinstance(msg, dict):
                    continue
                await self._on_message(msg)
        except WebSocketDisconnect:
            pass
        except Exception as e:
            logger.debug("[bridge] extension reader exited: %s", e)
        finally:
            self._reject_all("extension disconnected")

    def _on_message(self, msg: dict) -> asyncio.Task:
        return asyncio.create_task(self._handle_message(msg))

    async def _handle_message(self, msg: dict) -> None:
        # 响应:匹配 pending 请求。
        if "id" in msg and ("result" in msg or "error" in msg):
            mid = msg["id"]
            fut = self._pending.pop(mid, None)
            if fut is None or fut.done():
                return
            if "error" in msg:
                err = msg["error"]
                msg_text = err.get("message") if isinstance(err, dict) else str(err)
                fut.set_exception(RuntimeError(f"extension error: {msg_text}"))
            else:
                fut.set_result(msg.get("result"))
            return

        # 通知(无 id,有 method):如 hello / ping。
        method = msg.get("method")
        if method and "id" not in msg:
            params = msg.get("params") or {}
            if method in ("hello", "ping", "register"):
                self.apply_extension_meta(params)
                if method == "hello":
                    logger.info(
                        "[bridge] extension hello conn_id=%s name=%s version=%s instance=%s",
                        self.id,
                        self.extension_name,
                        self.extension_version,
                        self.extension_instance_id,
                    )
            return

        # 请求(有 id,有 method):扩展主动发来的请求。首版几乎不用,但支持 ping 响应。
        if method and "id" in msg:
            try:
                result: Any = None
                if method == "ping":
                    result = {"ok": True}
                self._send_fire_and_forget({"jsonrpc": "2.0", "id": msg["id"], "result": result})
            except Exception as e:
                self._send_fire_and_forget({
                    "jsonrpc": "2.0",
                    "id": msg["id"],
                    "error": {"code": -32603, "message": str(e)},
                })

    # --- 客户端侧:发请求 ---

    async def call(self, method: str, params: Optional[dict] = None, timeout_ms: Optional[int] = None) -> Any:
        if self._closed:
            raise RuntimeError("extension connection closed")
        mid = self._next_id
        self._next_id += 1
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[mid] = fut
        # 请求帧必须可靠送达：await 发送，避免连接在排队与 flush 之间断开时
        # 请求静默丢失、调用方只能等满超时。
        try:
            await self._send({"jsonrpc": "2.0", "id": mid, "method": method, "params": params or {}})
        except Exception as e:
            self._pending.pop(mid, None)
            raise RuntimeError(f"bridge request '{method}' failed to send: {e}") from e
        timeout = (timeout_ms or _REQUEST_TIMEOUT_MS) / 1000
        try:
            return await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending.pop(mid, None)
            raise RuntimeError(f"bridge request '{method}' timed out after {timeout}s")
        except Exception:
            self._pending.pop(mid, None)
            raise

    async def _send(self, msg: dict) -> None:
        if self._closed:
            raise RuntimeError("extension connection closed")
        try:
            await self.websocket.send_text(json.dumps(msg))
        except Exception as e:
            self._closed = True
            self._reject_all(f"send failed: {e}")
            raise

    def _send_fire_and_forget(self, msg: dict) -> None:
        """同步 fire-and-forget 发送，仅用于扩展主动发来的通知响应。

        这些消息没有等待方，若阻塞发送会拖住接收循环；发送失败时的
        _reject_all 与 _send 一致。
        """
        try:
            asyncio.get_running_loop().create_task(self._send(msg))
        except RuntimeError:
            # 无运行循环(关闭中),忽略。
            pass

    def _reject_all(self, reason: str) -> None:
        self._closed = True
        for fut in list(self._pending.values()):
            if not fut.done():
                try:
                    fut.set_exception(RuntimeError(reason))
                except (InvalidStateError, asyncio.InvalidStateError):
                    # Future was already completed between the check and set_exception
                    pass
        self._pending.clear()


# 全局唯一扩展连接。同一时刻只允许一个扩展连接(后连的顶掉先连的)。
_extension_connection: Optional[ExtensionConnection] = None
_connection_lock = asyncio.Lock()
_connection_event = asyncio.Event()


async def handle_extension_websocket(websocket: WebSocket) -> None:
    """FastAPI WebSocket 路由的处理函数。需通过 auth（token 或受信 loopback/网关）。"""
    global _extension_connection

    if not await authorize_websocket(websocket):
        logger.warning("[bridge] reject unauthorized extension websocket")
        return

    # loopback 校验:仅当后端绑定的就是 loopback 时才检查来源。
    # 绑 0.0.0.0（Docker）时,docker-proxy 已在宿主机用 127.0.0.1 限制暴露,
    # 容器内看到的来源是宿主机 docker 网关地址;鉴权由 authorize_websocket 负责。
    if _REQUIRE_LOOPBACK:
        client = websocket.client
        host = getattr(client, "host", None) if client else None
        if host not in _LOOPBACK_HOSTS:
            logger.warning("[bridge] reject non-loopback extension connection from %s", host)
            await websocket.close(code=4003)
            return

    await websocket.accept()
    conn = ExtensionConnection(websocket)

    async with _connection_lock:
        prev = _extension_connection
        if prev is not None:
            # 顶掉旧连接：直接关闭旧 websocket，serve 循环随之退出。
            try:
                await prev.websocket.close(code=4000, reason="replaced by new connection")
            except Exception:
                pass
            prev._reject_all("replaced by new connection")
        _extension_connection = conn
        _connection_event.set()
    logger.info("[bridge] extension connected (conn_id=%s)", conn.id)

    try:
        await conn.serve()
    finally:
        async with _connection_lock:
            if _extension_connection is conn:
                _extension_connection = None
                _connection_event.clear()
        logger.info("[bridge] extension disconnected (conn_id=%s)", conn.id)


# ---------------------------------------------------------------------------
# BridgeClient:给 browser_manager / page_crawler 用的客户端
# ---------------------------------------------------------------------------

class BridgeClient:
    """对扩展发 JSON-RPC 调用的高级封装。"""

    async def init(self, wait_timeout: float = 0.0) -> bool:
        """初始化。WS 服务由 FastAPI 路由承载,这里只等扩展连入。

        wait_timeout > 0 时最多等这么多秒;为 0 时不阻塞(扩展后连也能补上)。
        """
        if _extension_connection is not None:
            return True
        if wait_timeout <= 0:
            logger.warning("[bridge] extension not connected at init; will pick up when it connects")
            return False
        try:
            await asyncio.wait_for(_connection_event.wait(), timeout=wait_timeout)
            return True
        except asyncio.TimeoutError:
            logger.warning("[bridge] extension did not connect within %.1fs", wait_timeout)
            return False

    async def shutdown(self) -> None:
        global _extension_connection
        async with _connection_lock:
            if _extension_connection is not None:
                try:
                    await _extension_connection.websocket.close(code=1001)
                except Exception:
                    pass
                _extension_connection._reject_all("shutdown")
                _extension_connection = None
                _connection_event.clear()

    def _conn(self) -> ExtensionConnection:
        conn = _extension_connection
        if conn is None or conn._closed:
            raise RuntimeError("JustSearch 浏览器桥接不可用:扩展未连接,请在 Chrome 中加载 JustSearch Bridge 扩展并保持其弹出页连接")
        return conn

    async def health_check(self) -> bool:
        try:
            conn = _extension_connection
            if conn is None or conn._closed:
                return False
            result = await asyncio.wait_for(conn.call("ping", {}, timeout_ms=3000), timeout=5.0)
            if isinstance(result, dict):
                conn.apply_extension_meta(result)
            return True
        except Exception:
            return False

    # --- tab 生命周期 ---

    async def create_tab(self, url: Optional[str] = None, session_id: Optional[str] = None) -> dict:
        params: dict = {}
        if url:
            params["url"] = url
        if session_id:
            params["session_id"] = session_id
        return await self._conn().call("createTab", params)

    async def close_tab(self, tab_id: int) -> None:
        try:
            await self._conn().call("closeTab", {"tabId": tab_id}, timeout_ms=10000)
        except Exception as e:
            logger.debug("[bridge] closeTab(%s) error: %s", tab_id, e)

    async def finalize_tabs(self, tab_ids: list[int], session_id: Optional[str] = None) -> None:
        if not tab_ids:
            return
        params: dict = {"tabIds": tab_ids}
        if session_id:
            params["session_id"] = session_id
        try:
            await self._conn().call("finalizeTabs", params, timeout_ms=15000)
        except Exception as e:
            logger.warning("[bridge] finalizeTabs error: %s", e)

    # --- 导航 / 元信息 ---

    async def navigate(self, tab_id: int, url: str, timeout_ms: int = 20000) -> dict:
        return await self._conn().call("navigate", {"tabId": tab_id, "url": url, "timeoutMs": timeout_ms}, timeout_ms=timeout_ms + 5000)

    async def get_tab_url(self, tab_id: int) -> str:
        r = await self._conn().call("getTabUrl", {"tabId": tab_id}, timeout_ms=5000)
        return r.get("url", "") if isinstance(r, dict) else ""

    # --- 核心:执行 JS ---

    async def evaluate(self, tab_id: int, expression: str, timeout_ms: int = 30_000) -> Any:
        """在 tab 里跑任意 JS,返回 Runtime.evaluate 的 value。

        所有原本的 page.evaluate(JS) 都走这里。JS 字符串逐字保留。
        """
        result = await self._conn().call(
            "evaluate",
            {"tabId": tab_id, "expression": expression, "awaitPromise": True, "returnByValue": True, "timeoutMs": timeout_ms},
            timeout_ms=timeout_ms + 5000,
        )
        if isinstance(result, dict):
            return result.get("value")
        return result

    async def extract_content(self, tab_id: int, timeout_ms: int = 45_000) -> dict:
        """用扩展侧 Defuddle 抽取主正文(Markdown),不经 CDP evaluate。

        返回 dict: {ok, text, strategy, useful, title, author, thin, ...}
        旧扩展无此方法时抛异常,由 content.extract_page_content 回退到启发式 JS。
        """
        result = await self._conn().call(
            "extractContent",
            {"tabId": tab_id, "timeoutMs": timeout_ms},
            timeout_ms=timeout_ms + 5000,
        )
        return result if isinstance(result, dict) else {}

    # --- 交互 ---

    async def click_at(self, tab_id: int, x: float, y: float) -> None:
        await self._conn().call("clickAt", {"tabId": tab_id, "x": x, "y": y}, timeout_ms=15000)

    async def scroll_by(self, tab_id: int, delta_x: float = 0, delta_y: float = 0, x: float = 0, y: float = 0) -> None:
        await self._conn().call("scrollBy", {"tabId": tab_id, "deltaX": delta_x, "deltaY": delta_y, "x": x, "y": y}, timeout_ms=10000)

    async def move_mouse(
        self,
        tab_id: int,
        x: float,
        y: float,
        session_id: str = "default",
        move_sequence: int = 0,
        turn_id: Optional[str] = None,
        wait_for_arrival: bool = True,
    ) -> bool:
        """驱动虚拟光标动画到 (x,y),复刻 browser-control-bridge 的弹簧/贝塞尔光标。

        turn_id 标识当前一轮交互(同一 turn 内多次 move 共享),move_sequence 单调递增,
        扩展端用 (turn_id, move_sequence) 去重路径并上报到达。wait_for_arrival=True 时
        等待 content script 上报光标到达终点(最多 ~1.5s)。真实点击用 click_at。
        """
        params = {
            "tabId": tab_id,
            "x": x,
            "y": y,
            "session_id": session_id,
            "move_sequence": move_sequence,
            "turn_id": turn_id or f"{session_id}:{move_sequence}",
            "wait_for_arrival": wait_for_arrival,
        }
        try:
            result = await self._conn().call("moveMouse", params, timeout_ms=5000)
            return bool(result.get("arrived")) if isinstance(result, dict) else False
        except Exception:
            # 虚拟光标失败不应阻断真实点击流程。
            return False

    async def detach_tab(self, tab_id: int) -> None:
        try:
            await self._conn().call("detachTab", {"tabId": tab_id}, timeout_ms=5000)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# TabPool:后台标签生命周期管理(创建/归还/批量关闭),无并发上限。
# ---------------------------------------------------------------------------

class TabPool:
    """acquire 创建一个后台 tab,release 归还并标记待清理。

    爬取并发由 workflow 的 JUSTSEARCH_CRAWL_CONCURRENCY（默认 2）限制；
    交互点击另有 page_crawler 全局锁串行化 CDP。
    """

    def __init__(self, client: BridgeClient):
        self.client = client
        self._pending_close: list[int] = []
        self._acquired: list[int] = []

    async def acquire(self, session_id: Optional[str] = None) -> dict:
        result = await self.client.create_tab(session_id=session_id)
        tab_id = result.get("tabId") if isinstance(result, dict) else None
        if tab_id is None:
            raise RuntimeError("create_tab returned no tabId")
        tab = {"tab_id": tab_id, **result}
        self._acquired.append(tab_id)
        return tab

    async def release(self, tab: dict) -> None:
        tab_id = tab.get("tab_id")
        if tab_id is None:
            return
        if tab_id in self._acquired:
            self._acquired.remove(tab_id)
        self._pending_close.append(tab_id)
        # detach debugger,避免黄条残留;关闭交给 close_all_pending 批量做。
        await self.client.detach_tab(tab_id)

    async def close_all_pending(self, session_id: Optional[str] = None) -> None:
        """关闭所有已 release 但尚未关闭的 tab。workflow 一轮结束 + 周期清理都调。"""
        ids = self._pending_close
        self._pending_close = []
        if ids:
            await self.client.finalize_tabs(ids, session_id=session_id)


# ---------------------------------------------------------------------------
# 模块级单例
# ---------------------------------------------------------------------------

_bridge_client: Optional[BridgeClient] = None


def get_bridge_client() -> BridgeClient:
    global _bridge_client
    if _bridge_client is None:
        _bridge_client = BridgeClient()
    return _bridge_client


async def init_bridge() -> None:
    """FastAPI lifespan 启动钩子。WS 路由由 main.py 注册,这里只初始化客户端。"""
    global _bridge_client
    _bridge_client = BridgeClient()
    # 不阻塞启动:扩展后连也能补上。给 0.5s 让已连的快速确认。
    await _bridge_client.init(wait_timeout=0.5)
    logger.info(
        "[bridge] initialized (ws=%s:%d%s)",
        _WS_HOST, _WS_PORT, _WS_PATH,
    )


async def shutdown_bridge() -> None:
    global _bridge_client
    if _bridge_client is not None:
        await _bridge_client.shutdown()
        _bridge_client = None
    logger.info("[bridge] shut down")


def get_ws_endpoint() -> str:
    return f"ws://{_WS_HOST}:{_WS_PORT}{_WS_PATH}"


def get_ws_route_path() -> str:
    return _WS_PATH


def is_extension_connected() -> bool:
    conn = _extension_connection
    return conn is not None and not conn._closed


def get_extension_info() -> dict:
    """Return connection identity for /api/health and settings UI."""
    conn = _extension_connection
    if conn is None or conn._closed:
        return {
            "connected": False,
            "conn_id": None,
            "name": None,
            "version": None,
            "instance_id": None,
        }
    return {
        "connected": True,
        "conn_id": conn.id,
        "name": conn.extension_name,
        "version": conn.extension_version,
        "instance_id": conn.extension_instance_id,
    }
