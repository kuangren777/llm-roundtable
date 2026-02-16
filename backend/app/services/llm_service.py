"""LLM service — all providers use OpenAI-compatible chat completions API.

Provider type and base_url are configured by the user in Settings.
We just pass them through to the openai SDK.
"""
import logging
from urllib.parse import urlparse
from openai import AsyncOpenAI
from typing import Optional

logger = logging.getLogger(__name__)


def _normalize_base_url(url: Optional[str]) -> Optional[str]:
    """Ensure base_url ends with /v1 for OpenAI-compatible APIs when the path is empty.

    Many providers (OneAPI, New API, etc.) serve an admin panel at the root
    and the actual API at /v1. Without this suffix the SDK gets HTML instead
    of JSON. Only appends /v1 when the URL has no meaningful path — URLs with
    existing paths (e.g. Gemini's /v1beta/openai/) are left untouched.
    """
    if not url:
        return None
    url = url.rstrip("/")
    parsed = urlparse(url)
    # Only append /v1 if the path is empty or just "/"
    if not parsed.path or parsed.path == "/":
        url += "/v1"
    return url


async def call_llm(
    provider: str,
    model: str,
    messages: list[dict],
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    temperature: float = 0.7,
    timeout: float = 180,
) -> str:
    """Call an LLM via the OpenAI-compatible chat completions API."""
    normalized_url = _normalize_base_url(base_url)
    client = AsyncOpenAI(
        api_key=api_key or "sk-placeholder",
        base_url=normalized_url,
        timeout=timeout,
    )

    response = await client.chat.completions.create(
        model=model,
        messages=messages,
        temperature=temperature,
    )

    # Some OpenAI-compatible endpoints return raw strings (e.g. HTML error pages)
    if isinstance(response, str):
        if "<html" in response.lower() or "<!doctype" in response.lower():
            raise ValueError(
                f"Provider {provider}/{model} returned an HTML page instead of a JSON response. "
                f"Check that the base_url is correct (got: {base_url})."
            )
        logger.warning("Provider %s/%s returned raw string instead of ChatCompletion", provider, model)
        return response

    return response.choices[0].message.content


async def call_llm_stream(
    provider: str,
    model: str,
    messages: list[dict],
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    temperature: float = 0.7,
    on_chunk=None,  # async callback(chunk_text: str, total_chars: int)
    timeout: float = 180,
) -> tuple[str, int]:
    """Streaming LLM call with on_chunk progress callback. Returns (full_text, total_chars)."""
    normalized_url = _normalize_base_url(base_url)
    client = AsyncOpenAI(
        api_key=api_key or "sk-placeholder",
        base_url=normalized_url,
        timeout=timeout,
    )

    stream = await client.chat.completions.create(
        model=model,
        messages=messages,
        temperature=temperature,
        stream=True,
    )

    chunks = []
    total_chars = 0
    async for chunk in stream:
        if not chunk.choices:
            continue  # some providers send empty choices on first/last chunk
        delta = chunk.choices[0].delta.content if chunk.choices[0].delta else None
        if delta:
            chunks.append(delta)
            total_chars += len(delta)
            if on_chunk:
                await on_chunk(delta, total_chars)

    return "".join(chunks), total_chars
