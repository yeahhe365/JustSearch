"""OpenAI SDK client construction for JustSearch."""

import asyncio
from contextlib import asynccontextmanager

import httpx

from openai import AsyncOpenAI

from .version import __version__


OPENAI_USER_AGENT = f"JustSearch/{__version__}"
LOCAL_PROVIDER_API_KEY = "justsearch-local-provider"


def create_openai_client(
    api_key: str,
    base_url: str,
    *,
    timeout: float | None = None,
    connect_timeout: float | None = None,
    max_retries: int = 2,
) -> AsyncOpenAI:
    """Create an AsyncOpenAI client with project-level defaults.

    ``timeout`` is the overall request budget (seconds). When
    ``connect_timeout`` is also set, use an httpx.Timeout so slow gateways
    fail fast on connect while still allowing long generation.

    生命周期契约：返回的客户端持有独立的 httpx 连接池，用完必须关闭——
    简单场景直接用下面的 :func:`openai_client_lifespan`。
    """
    client_timeout = timeout
    if timeout is not None and connect_timeout is not None:
        client_timeout = httpx.Timeout(
            timeout,
            connect=float(connect_timeout),
        )

    return AsyncOpenAI(
        api_key=api_key or LOCAL_PROVIDER_API_KEY,
        base_url=base_url,
        timeout=client_timeout,
        max_retries=max_retries,
        default_headers={"User-Agent": OPENAI_USER_AGENT},
    )


async def aclose_openai_client(client: AsyncOpenAI) -> None:
    """Close an AsyncOpenAI client's underlying httpx pool (idempotent-tolerant)."""
    close = getattr(client, "close", None)
    if close is None:
        return
    result = close()
    if asyncio.iscoroutine(result):
        await result


@asynccontextmanager
async def openai_client_lifespan(**kwargs):
    """Create a client and guarantee its pool closes on exit or exception."""
    client = create_openai_client(**kwargs)
    try:
        yield client
    finally:
        await aclose_openai_client(client)
