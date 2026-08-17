"""Unit tests for the transcription provider abstraction (textai/transcription.py).

Pure unit tests - no network, no live infra. The module-level sys.path tweak makes
backend/ importable without depending on tests/conftest.py's simulation harness.
"""
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

BACKEND = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND))

from textai import transcription as t  # noqa: E402
from textai import service as svc  # noqa: E402


def test_default_provider_is_openai(monkeypatch):
    monkeypatch.delenv("TRANSCRIPTION_PROVIDER", raising=False)
    provider = t.get_transcription_provider()
    assert provider.name == "openai"


def test_unknown_provider_fails_loudly(monkeypatch):
    monkeypatch.setenv("TRANSCRIPTION_PROVIDER", "nope")
    with pytest.raises(t.TranscriptionConfigError) as excinfo:
        t.get_transcription_provider()
    assert "nope" in str(excinfo.value)
    assert "openai" in str(excinfo.value)


class _StubProvider:
    name = "stub"

    def __init__(self):
        self.calls = []

    async def transcribe(self, audio_bytes, file_extension, language=None, diarization=None):
        self.calls.append((audio_bytes, file_extension, language, diarization))
        return t.Transcript(
            text="hello world",
            words=[t.WordTimestamp(word="hello", start=0.0, end=0.4), t.WordTimestamp(word="world", start=0.5, end=0.9)],
        )


@pytest.mark.asyncio
async def test_transcribe_bytes_routes_through_provider(monkeypatch):
    stub = _StubProvider()
    monkeypatch.setitem(t._PROVIDERS, "stub", lambda: stub)
    monkeypatch.setenv("TRANSCRIPTION_PROVIDER", "stub")
    out = await svc.transcribe_bytes(b"fake-audio", "caf", language="en")
    # Now returns the full Transcript (text + word timestamps), not just the text string.
    assert out.text == "hello world"
    assert [(w.word, w.start, w.end) for w in out.words] == [("hello", 0.0, 0.4), ("world", 0.5, 0.9)]
    # .caf is normalized to .m4a before reaching the provider; language passes through.
    assert stub.calls == [(b"fake-audio", ".m4a", "en", None)]


def _segment(text, no_speech_prob, avg_logprob):
    return SimpleNamespace(text=text, no_speech_prob=no_speech_prob, avg_logprob=avg_logprob)


def test_silent_hallucinations_dropped():
    response = SimpleNamespace(
        text="Thanks for watching!",
        segments=[
            _segment("Real speech here.", 0.1, -0.3),
            _segment(" Thanks for watching!", 0.9, -1.5),  # silent hallucination: both thresholds trip
        ],
    )
    out = t.OpenAITranscriptionProvider._drop_silent_hallucinations(response)
    assert out == "Real speech here."


def test_quiet_real_speech_kept():
    # Only one threshold trips - must NOT be dropped (could be quiet/mumbled speech).
    response = SimpleNamespace(
        text="mumbled words",
        segments=[_segment("mumbled words", 0.9, -0.5)],
    )
    out = t.OpenAITranscriptionProvider._drop_silent_hallucinations(response)
    assert out == "mumbled words"


def test_no_segments_falls_back_to_plain_text():
    response = SimpleNamespace(text="plain text", segments=None)
    out = t.OpenAITranscriptionProvider._drop_silent_hallucinations(response)
    assert out == "plain text"


def _sm_word(content, start, end, confidence=0.99, speaker=None):
    return SimpleNamespace(
        type="word", start_time=start, end_time=end,
        alternatives=[SimpleNamespace(content=content, confidence=confidence, speaker=speaker)],
    )


def _sm_punct(content, at):
    return SimpleNamespace(
        type="punctuation", start_time=at, end_time=at,
        alternatives=[SimpleNamespace(content=content, confidence=0.99, speaker=None)],
    )


def test_speechmatics_flatten_keeps_word_timestamps():
    result = SimpleNamespace(results=[
        _sm_word("Hello", 0.0, 0.5),
        _sm_punct(".", 0.5),
        _sm_word("World", 0.6, 1.0),
        SimpleNamespace(type="word", start_time=1.1, end_time=1.2, alternatives=[]),  # skipped
    ])
    transcript = t.SpeechmaticsTranscriptionProvider._flatten(result)
    assert transcript.text == "Hello. World"
    assert [(w.word, w.start, w.end) for w in transcript.words] == [
        ("Hello", 0.0, 0.5), ("World", 0.6, 1.0),
    ]


def test_speechmatics_flatten_empty():
    transcript = t.SpeechmaticsTranscriptionProvider._flatten(SimpleNamespace(results=[]))
    assert transcript.text == ""
    assert transcript.words is None


@pytest.mark.asyncio
async def test_speechmatics_requires_api_key(monkeypatch):
    monkeypatch.delenv("SPEECHMATICS_API_KEY", raising=False)
    provider = t.SpeechmaticsTranscriptionProvider()
    with pytest.raises(t.TranscriptionConfigError) as excinfo:
        await provider.transcribe(b"audio", ".m4a")
    assert "SPEECHMATICS_API_KEY" in str(excinfo.value)


@pytest.mark.asyncio
async def test_speechmatics_retries_on_rate_limit(monkeypatch):
    monkeypatch.setattr(t.asyncio, "sleep", _no_sleep)
    from speechmatics.batch import TransportError

    calls = []

    class FakeClient:
        async def submit_job(self, audio_file, transcription_config=None):
            calls.append(transcription_config)
            if len(calls) < 3:
                raise TransportError("HTTP 429: Too Many Requests")
            return SimpleNamespace(id="job-1")

    provider = t.SpeechmaticsTranscriptionProvider()
    job = await provider._submit_with_backoff(FakeClient(), _FakeBytesIO(), object())
    assert job.id == "job-1"
    assert len(calls) == 3


@pytest.mark.asyncio
async def test_speechmatics_no_retry_on_non_429():
    from speechmatics.batch import TransportError

    class FakeClient:
        async def submit_job(self, audio_file, transcription_config=None):
            raise TransportError("HTTP 500: Internal Server Error")

    provider = t.SpeechmaticsTranscriptionProvider()
    with pytest.raises(TransportError):
        await provider._submit_with_backoff(FakeClient(), _FakeBytesIO(), object())


class _FakeBytesIO:
    def seek(self, _):
        pass


async def _no_sleep(_):
    pass


def test_transcript_response_includes_words():
    from textai import router as r
    transcript = t.Transcript(
        text="hello world",
        words=[
            t.WordTimestamp(word="hello", start=0.0, end=0.4),
            t.WordTimestamp(word="world", start=0.5, end=0.9, speaker="S1"),
        ],
    )
    body = r._transcript_response(transcript)
    assert body["text"] == "hello world"
    assert body["words"] == [
        {"word": "hello", "start": 0.0, "end": 0.4},
        {"word": "world", "start": 0.5, "end": 0.9, "speaker": "S1"},
    ]


def test_transcript_response_omits_words_when_absent():
    from textai import router as r
    # OpenAI returns text-only; the words key must be absent so the client degrades gracefully.
    body = r._transcript_response(t.Transcript(text="just text"))
    assert body == {"text": "just text"}
    assert "words" not in body

