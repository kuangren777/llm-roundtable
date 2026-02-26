"""Tests for llm_service — verifies call_llm uses openai SDK correctly."""
import sys
import os
import pytest
from unittest.mock import AsyncMock, patch, MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def _chunk(content: str):
    chunk = MagicMock()
    choice = MagicMock()
    choice.delta = MagicMock()
    choice.delta.content = content
    chunk.choices = [choice]
    return chunk


class _FakeStream:
    def __init__(self, chunks):
        self._chunks = chunks

    def __aiter__(self):
        return self._gen()

    async def _gen(self):
        for item in self._chunks:
            yield item


class TestCallLlm:
    @pytest.mark.asyncio
    async def test_passes_model_and_messages(self):
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = "test response"

        with patch("backend.app.services.llm_service.AsyncOpenAI") as MockClient:
            instance = MockClient.return_value
            instance.chat.completions.create = AsyncMock(return_value=mock_response)
            instance.close = AsyncMock()

            from backend.app.services.llm_service import call_llm
            result = await call_llm(
                provider="openai",
                model="gpt-4o",
                messages=[{"role": "user", "content": "hello"}],
                api_key="sk-test",
                base_url="https://api.openai.com/v1",
            )

            assert result == "test response"
            instance.chat.completions.create.assert_called_once()
            instance.close.assert_awaited_once()
            call_kwargs = instance.chat.completions.create.call_args[1]
            assert call_kwargs["model"] == "gpt-4o"
            assert call_kwargs["messages"] == [{"role": "user", "content": "hello"}]

    @pytest.mark.asyncio
    async def test_uses_user_base_url(self):
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = "ok"

        with patch("backend.app.services.llm_service.AsyncOpenAI") as MockClient:
            instance = MockClient.return_value
            instance.chat.completions.create = AsyncMock(return_value=mock_response)
            instance.close = AsyncMock()

            from backend.app.services.llm_service import call_llm
            await call_llm(
                provider="deepseek",
                model="deepseek-chat",
                messages=[{"role": "user", "content": "hi"}],
                api_key="sk-ds",
                base_url="https://api.deepseek.com",
            )

            # _normalize_base_url appends /v1 when path is empty
            MockClient.assert_called_once_with(api_key="sk-ds", base_url="https://api.deepseek.com/v1", timeout=180)

    @pytest.mark.asyncio
    async def test_gemini_via_openai_compat(self):
        """Gemini calls go through the same openai SDK, just different base_url."""
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = "gemini says hi"

        with patch("backend.app.services.llm_service.AsyncOpenAI") as MockClient:
            instance = MockClient.return_value
            instance.chat.completions.create = AsyncMock(return_value=mock_response)
            instance.close = AsyncMock()

            from backend.app.services.llm_service import call_llm
            result = await call_llm(
                provider="gemini",
                model="gemini-2.0-flash",
                messages=[{"role": "user", "content": "hi"}],
                api_key="AIza-test",
                base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
            )

            assert result == "gemini says hi"
            # URL already has a path — _normalize_base_url strips trailing / but doesn't append /v1
            MockClient.assert_called_once_with(
                api_key="AIza-test",
                base_url="https://generativelanguage.googleapis.com/v1beta/openai",
                timeout=180,
            )

    @pytest.mark.asyncio
    async def test_no_base_url_passes_none(self):
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = "ok"

        with patch("backend.app.services.llm_service.AsyncOpenAI") as MockClient:
            instance = MockClient.return_value
            instance.chat.completions.create = AsyncMock(return_value=mock_response)
            instance.close = AsyncMock()

            from backend.app.services.llm_service import call_llm
            await call_llm(
                provider="openai",
                model="gpt-4o",
                messages=[{"role": "user", "content": "hi"}],
                api_key="sk-test",
            )

            MockClient.assert_called_once_with(api_key="sk-test", base_url=None, timeout=180)

    @pytest.mark.asyncio
    async def test_no_api_key_uses_placeholder(self):
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = "ok"

        with patch("backend.app.services.llm_service.AsyncOpenAI") as MockClient:
            instance = MockClient.return_value
            instance.chat.completions.create = AsyncMock(return_value=mock_response)
            instance.close = AsyncMock()

            from backend.app.services.llm_service import call_llm
            await call_llm(
                provider="ollama",
                model="llama3",
                messages=[{"role": "user", "content": "hi"}],
                base_url="http://localhost:11434/v1",
            )

            MockClient.assert_called_once_with(api_key="sk-placeholder", base_url="http://localhost:11434/v1", timeout=180)

    @pytest.mark.asyncio
    async def test_retries_10_times_with_exponential_backoff(self):
        with patch("backend.app.services.llm_service.AsyncOpenAI") as MockClient, \
             patch("backend.app.services.llm_service.asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            instance = MockClient.return_value
            instance.chat.completions.create = AsyncMock(side_effect=Exception("boom"))
            instance.close = AsyncMock()

            from backend.app.services.llm_service import call_llm, MAX_RETRIES

            with pytest.raises(Exception, match="boom"):
                await call_llm(
                    provider="openai",
                    model="gpt-4o",
                    messages=[{"role": "user", "content": "hi"}],
                    api_key="sk-test",
                )

            assert MAX_RETRIES == 10
            assert instance.chat.completions.create.call_count == MAX_RETRIES
            instance.close.assert_awaited_once()
            assert mock_sleep.await_count == MAX_RETRIES - 1
            delays = [c.args[0] for c in mock_sleep.await_args_list]
            assert delays == [2 ** i for i in range(MAX_RETRIES - 1)]


class TestCallLlmStream:
    @pytest.mark.asyncio
    async def test_stream_returns_text_and_closes_client(self):
        with patch("backend.app.services.llm_service.AsyncOpenAI") as MockClient:
            instance = MockClient.return_value
            instance.close = AsyncMock()
            instance.chat.completions.create = AsyncMock(
                return_value=_FakeStream([_chunk("你"), _chunk("好")])
            )

            from backend.app.services.llm_service import call_llm_stream

            chunks = []

            async def on_chunk(delta, total):
                chunks.append((delta, total))

            text, total_chars = await call_llm_stream(
                provider="openai",
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": "hi"}],
                api_key="sk-test",
                on_chunk=on_chunk,
            )

            assert text == "你好"
            assert total_chars == 2
            assert chunks == [("你", 1), ("好", 2)]
            instance.close.assert_awaited_once()
