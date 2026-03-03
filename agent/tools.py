from strands import tool
import asyncio
import boto3
import json
import os
import re
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
import httpx
from typing import Optional

@tool
async def http_get(url: str, timeout_sec: int = 10, max_bytes: int = 50_000) -> str:
    """Fetch text from a URL. Use for retrieving web pages or JSON APIs.
    Args:
        url: Target URL (http/https)
        timeout_sec: Request timeout seconds
        max_bytes: Max bytes to read to avoid huge payloads (default 50KB)
    Returns:
        Response text (truncated to max_bytes)
    """
    async with httpx.AsyncClient(timeout=timeout_sec, follow_redirects=True, headers={
        "User-Agent": "AgentCore-Strands-MVP/1.0"
    }) as client:
        r = await client.get(url)
        r.raise_for_status()
        content = r.text
        if len(content) > max_bytes:
            content = content[:max_bytes] + "\n...[truncated]..."
        return content

@tool
async def sleep_seconds(seconds: int = 3) -> str:
    """Sleep for N seconds, then report how long we slept."""
    await asyncio.sleep(max(0, int(seconds)))
    return f"Slept {seconds} seconds"

@tool
def current_time(tz: str = "Asia/Tokyo") -> str:
    """Return the current time in ISO8601 for the given timezone."""
    return datetime.now(ZoneInfo(tz)).isoformat()
