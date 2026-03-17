import asyncio
import httpx
from typing import Callable, Awaitable

async def with_retries(fn: Callable[[], Awaitable[httpx.Response]], max_attempts: int = 5):
    delay = 1.0
    for attempt in range(1, max_attempts + 1):
        try:
            resp = await fn()
            if resp.status_code == 429:
                await asyncio.sleep(delay)
                delay = min(delay * 2, 15)
                continue
            if 400 <= resp.status_code < 500 and resp.status_code != 429:
                return resp
            if resp.status_code >= 500:
                await asyncio.sleep(delay)
                delay = min(delay * 2, 15)
                continue
            return resp
        except Exception as e:
            if attempt == max_attempts:
                print(f"Error after {max_attempts} attempts: {e}")
                raise
            await asyncio.sleep(delay)
            delay = min(delay * 2, 15)
