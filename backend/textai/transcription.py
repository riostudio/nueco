"""Audio transcription provider abstraction.

Audio bytes in, plain text plus optional word-level metadata out. The rest of the
backend only talks to `get_transcription_provider()`; swapping or adding providers
is a config change behind `TRANSCRIPTION_PROVIDER`, never a call-site change.
Framework-agnostic like every service-layer module: no fastapi imports, plain
exceptions only.
"""
import asyncio
import io
import logging
import os
import random
import tempfile
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Optional, Protocol

import openai_client
from core import regions

logger = logging.getLogger(__name__)


@dataclass
class WordTimestamp:
    """One transcribed word with its position in the audio, in seconds.

    `confidence` and `speaker` are provider-dependent and optional - Speechmatics
    supplies both, OpenAI supplies neither. `speaker` only ever carries the generic
    label the provider returned (e.g. "S1"); renaming is a client-side concern.
    """
    word: str
    start: float
    end: float
    confidence: Optional[float] = None
    speaker: Optional[str] = None


@dataclass
class Transcript:
    """Provider-neutral transcription result.

    `words` is None (not empty) when the provider does not supply word-level
    timestamps - callers use that distinction to know tap-to-seek is unavailable
    rather than assuming an empty transcript.
    """
    text: str
    words: Optional[list[WordTimestamp]] = field(default=None)


class TranscriptionProvider(Protocol):
    name: str
    supports_diarization: bool

    async def transcribe(
        self,
        audio_bytes: bytes,
        file_extension: str,
        language: Optional[str] = None,
        diarization: Optional[str] = None,
    ) -> Transcript: ...


class TranscriptionConfigError(Exception):
    """Raised when a provider is unknown, unconfigured, or its SDK is missing."""


# Thresholds per TranscriptionSegment's own field docs (avg_logprob "lower than -1, consider
# the logprobs failed") plus the commonly-used no_speech_prob cutoff for this exact failure
# mode. Requiring BOTH conditions (not just one) avoids discarding real quiet/mumbled speech
# that only trips one of the two.
_NO_SPEECH_PROB_THRESHOLD = 0.6
_AVG_LOGPROB_THRESHOLD = -1.0


class OpenAITranscriptionProvider:
    """Whisper via the OpenAI API - the original transcription path."""

    name = "openai"
    supports_diarization = False

    async def transcribe(
        self,
        audio_bytes: bytes,
        file_extension: str,
        language: Optional[str] = None,
        diarization: Optional[str] = None,
    ) -> Transcript:
        if diarization:
            logger.warning("diarization requested but not supported by the OpenAI provider; ignoring")
        client = openai_client.get_openai_client()

        with tempfile.NamedTemporaryFile(delete=False, suffix=file_extension) as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name

        try:
            with open(tmp_path, "rb") as audio_file:
                kwargs = {
                    "model": "whisper-1",
                    "file": audio_file,
                    # verbose_json is the only response format exposing per-segment
                    # no_speech_prob/avg_logprob - needed by _drop_silent_hallucinations below.
                    # Whisper is well-documented to hallucinate plausible-looking text (often in a
                    # random detected language, since there's no real speech to anchor language
                    # detection) instead of an empty string when fed silence/near-silent audio - a
                    # tap on the mic with nothing said would otherwise insert fabricated text.
                    "response_format": "verbose_json",
                }
                # Only pass language when we actually have a hint - an empty/unrecognized value
                # would force Whisper into that language instead of just falling back to auto-detect.
                if language:
                    kwargs["language"] = language
                response = await client.audio.transcriptions.create(**kwargs)
            return Transcript(text=self._drop_silent_hallucinations(response))
        finally:
            os.unlink(tmp_path)

    @staticmethod
    def _drop_silent_hallucinations(response) -> str:
        segments = response.segments
        if not segments:
            # No segment data to filter on (shouldn't happen with verbose_json) - trust the plain
            # transcript rather than silently dropping real speech.
            return response.text or ""
        kept = [
            seg.text for seg in segments
            if not (seg.no_speech_prob > _NO_SPEECH_PROB_THRESHOLD and seg.avg_logprob < _AVG_LOGPROB_THRESHOLD)
        ]
        return "".join(kept).strip()


# Speechmatics rate limit is 10 jobs/sec on POST /v2/jobs; we only ever submit one job per
# request, so a modest retry budget with jitter is enough for shared-backend bursts.
_SM_MAX_RETRIES = 5
_SM_BACKOFF_BASE_SECONDS = 1.0
_SM_BACKOFF_CAP_SECONDS = 30.0
_SM_JOB_TIMEOUT_SECONDS = 300.0
_SM_POLL_INTERVAL_SECONDS = 2.0
# Default retention for undeleted Speechmatics jobs is 7 days, so a failed inline delete must
# be repaired within minutes, not hours - the reconciliation sweep uses this cutoff.
_SM_STALE_JOB_MINUTES = 10
_SM_SWEEP_INTERVAL_SECONDS = 600


def _get_speechmatics_api_key() -> str:
    api_key = os.getenv("SPEECHMATICS_API_KEY")
    if not api_key:
        raise TranscriptionConfigError("SPEECHMATICS_API_KEY not configured")
    return api_key


def _import_speechmatics():
    try:
        from speechmatics.batch import AsyncClient, TranscriptionConfig
        from speechmatics.batch import TransportError
    except ImportError as e:
        raise TranscriptionConfigError(
            "speechmatics-batch package is not installed (pip install speechmatics-batch)"
        ) from e
    return AsyncClient, TranscriptionConfig, TransportError


class _NamedBytesIO(io.BytesIO):
    """BytesIO with a .name - submit_job derives the upload filename from it, and the
    extension is how Speechmatics detects the audio container."""


class SpeechmaticsTranscriptionProvider:
    """Speechmatics batch API with immediate job deletion.

    The job DELETE in `finally` is the core of the retention story: Speechmatics keeps
    submitted audio for up to 7 days unless the job is deleted, so deletion runs on every
    path including errors, and failures are logged loudly for the reconciliation sweep.
    """

    name = "speechmatics"
    supports_diarization = True

    async def transcribe(
        self,
        audio_bytes: bytes,
        file_extension: str,
        language: Optional[str] = None,
        diarization: Optional[str] = None,
    ) -> Transcript:
        AsyncClient, TranscriptionConfig, _ = _import_speechmatics()

        # Explicit language rather than auto-detect: the app captures single-language
        # dictation, and detection adds latency plus a failure mode on short clips.
        # Diarization stays off for ordinary capture - it's enabled per-call for
        # conversation mode only.
        # Conversation capture is two people (plan/10); telling Speechmatics the speaker
        # ceiling measurably improves turn attribution vs. leaving it unbounded.
        speaker_diarization_config = {"max_speakers": 2} if diarization else None
        config = TranscriptionConfig(
            language=language or "en",
            diarization=diarization,
            speaker_diarization_config=speaker_diarization_config,
        )

        # The endpoint is pinned explicitly from the residency-checked declaration -
        # left to itself the SDK uses its compiled-in default URL (or an ambient env
        # read), bypassing the Australian-region gate.
        async with AsyncClient(
            api_key=_get_speechmatics_api_key(), url=regions.speechmatics_base_url()
        ) as client:
            job_id = None
            try:
                audio_file = _NamedBytesIO(audio_bytes)
                audio_file.name = f"recording{file_extension}"
                job = await self._submit_with_backoff(client, audio_file, config)
                job_id = job.id
                result = await client.wait_for_completion(
                    job_id,
                    polling_interval=_SM_POLL_INTERVAL_SECONDS,
                    timeout=_SM_JOB_TIMEOUT_SECONDS,
                )
                return self._flatten(result)
            finally:
                if job_id is not None:
                    try:
                        await client.delete_job(job_id)
                    except Exception:
                        # A delete that silently fails leaves the user's audio sitting at the
                        # processor for up to 7 days - this must be impossible to miss.
                        logger.error(
                            "CRITICAL: failed to delete Speechmatics job %s after transcription; "
                            "audio is retained at the provider until the reconciliation sweep runs",
                            job_id, exc_info=True,
                        )

    @staticmethod
    async def _submit_with_backoff(client, audio_file, config):
        from speechmatics.batch import TransportError
        for attempt in range(_SM_MAX_RETRIES):
            try:
                audio_file.seek(0)
                return await client.submit_job(audio_file, transcription_config=config)
            except TransportError as e:
                if "HTTP 429" not in str(e) or attempt == _SM_MAX_RETRIES - 1:
                    raise
                delay = min(_SM_BACKOFF_BASE_SECONDS * (2 ** attempt), _SM_BACKOFF_CAP_SECONDS)
                delay += random.uniform(0, delay / 2)
                logger.warning(
                    "Speechmatics rate limited on job submit (attempt %d/%d); retrying in %.1fs",
                    attempt + 1, _SM_MAX_RETRIES, delay,
                )
                await asyncio.sleep(delay)

    @staticmethod
    def _flatten(result) -> Transcript:
        """Speechmatics structured JSON -> flat text plus word timestamps.

        The downstream schema-structuring step expects plain text, but the note editor's
        tap-to-seek needs the per-word timing, so both are produced here from one pass.
        Word items are space-joined; punctuation items attach to the preceding word.
        """
        words: list[WordTimestamp] = []
        tokens: list[str] = []
        for item in result.results or []:
            if not item.alternatives:
                continue
            best = item.alternatives[0]
            content = best.content
            if not content:
                continue
            if item.type == "word":
                tokens.append(content)
                words.append(WordTimestamp(
                    word=content,
                    start=item.start_time,
                    end=item.end_time,
                    confidence=best.confidence,
                    speaker=best.speaker,
                ))
            else:
                # punctuation (or other non-word items): no standalone timestamp use
                if tokens:
                    tokens[-1] += content
                else:
                    tokens.append(content)
        return Transcript(text=" ".join(tokens).strip(), words=words or None)


_PROVIDERS = {
    "openai": OpenAITranscriptionProvider,
    "speechmatics": SpeechmaticsTranscriptionProvider,
}


def get_transcription_provider() -> TranscriptionProvider:
    """Resolve the active provider from TRANSCRIPTION_PROVIDER (default: openai).

    Read per request rather than cached at import so an env change plus a process
    restart flips or rolls back the provider without a code change.
    """
    name = (os.getenv("TRANSCRIPTION_PROVIDER") or "openai").strip().lower()
    provider_cls = _PROVIDERS.get(name)
    if provider_cls is None:
        raise TranscriptionConfigError(
            f"Unknown transcription provider '{name}' (TRANSCRIPTION_PROVIDER); "
            f"valid values: {', '.join(sorted(_PROVIDERS))}"
        )
    return provider_cls()


def resolve_transcription_provider(diarization: Optional[str] = None) -> TranscriptionProvider:
    """The primary provider, except when diarization is requested that it cannot do and
    Speechmatics is configured - conversation captures then get speaker labels even before
    the global TRANSCRIPTION_PROVIDER cutover (plan M3). Without the key, the primary
    stands and the request degrades to single-voice (the client surfaces that)."""
    provider = get_transcription_provider()
    if not diarization or provider.supports_diarization:
        return provider
    if not os.getenv("SPEECHMATICS_API_KEY"):
        return provider
    return _PROVIDERS["speechmatics"]()


async def sweep_stale_speechmatics_jobs(max_age_minutes: int = _SM_STALE_JOB_MINUTES) -> int:
    """Reconciliation: delete any Speechmatics jobs older than max_age_minutes.

    Catches the rare case where the inline delete after transcription failed. Only acts
    when Speechmatics is configured. Returns the number of jobs deleted. Never raises -
    a failed sweep is logged and retried on the next run, it must not take down whatever
    schedules it.
    """
    try:
        api_key = os.getenv("SPEECHMATICS_API_KEY")
        if not api_key:
            return 0
        AsyncClient, _, _ = _import_speechmatics()
        cutoff = (datetime.now(timezone.utc) - timedelta(minutes=max_age_minutes)).isoformat()
        deleted = 0
        async with AsyncClient(api_key=api_key, url=regions.speechmatics_base_url()) as client:
            jobs = await client.list_jobs(created_before=cutoff)
            for job in jobs:
                try:
                    await client.delete_job(job.id)
                    deleted += 1
                except Exception:
                    logger.error("Reconciliation sweep failed to delete Speechmatics job %s", job.id, exc_info=True)
        if deleted:
            logger.warning("Reconciliation sweep deleted %d stale Speechmatics job(s)", deleted)
        return deleted
    except Exception:
        logger.error("Speechmatics reconciliation sweep failed", exc_info=True)
        return 0


async def run_speechmatics_sweeper() -> None:
    """Started once from server.py's startup event; intentionally never awaited/joined - it's
    meant to run for the life of the process. Mirrors featureflags' run_flag_refresher.
    No-op on every tick unless SPEECHMATICS_API_KEY is configured."""
    while True:
        await asyncio.sleep(_SM_SWEEP_INTERVAL_SECONDS)
        await sweep_stale_speechmatics_jobs()


# --- Shadow mode (migration validation) ---

# Shadow records deliberately contain transcript content - the migration comparison is
# impossible without it. They live in a dedicated collection with a 7-day TTL index
# (created in server.py) and are never written to application logs.
SHADOW_COLLECTION = "transcription_shadow"
SHADOW_RETENTION_SECONDS = 7 * 24 * 3600


def get_shadow_provider_name() -> Optional[str]:
    """The provider named by TRANSCRIPTION_SHADOW, or None when shadow mode is off or it
    would just re-run the primary."""
    shadow = (os.getenv("TRANSCRIPTION_SHADOW") or "").strip().lower()
    if not shadow:
        return None
    primary = (os.getenv("TRANSCRIPTION_PROVIDER") or "openai").strip().lower()
    if shadow == primary:
        return None
    if shadow not in _PROVIDERS:
        logger.warning("TRANSCRIPTION_SHADOW names unknown provider '%s'; shadow mode disabled", shadow)
        return None
    return shadow


async def _run_shadow_transcription(
    audio_bytes: bytes,
    file_extension: str,
    language: Optional[str],
    diarization: Optional[str],
    primary_name: str,
    primary_text: str,
    primary_latency_ms: float,
) -> None:
    """Fire-and-forget shadow run: transcribe the same audio with the shadow provider and
    persist both results for offline comparison (plan/transcription_eval.py). Errors are
    logged and swallowed - shadow mode must never affect the user's request."""
    shadow_name = get_shadow_provider_name()
    if not shadow_name:
        return
    record = {
        "created_at": datetime.now(timezone.utc),
        "primary_provider": primary_name,
        "shadow_provider": shadow_name,
        "primary_text": primary_text,
        "primary_latency_ms": round(primary_latency_ms, 1),
        "shadow_text": None,
        "shadow_latency_ms": None,
        "shadow_error": None,
    }
    try:
        provider_cls = _PROVIDERS[shadow_name]
        started = time.monotonic()
        transcript = await provider_cls().transcribe(audio_bytes, file_extension, language, diarization)
        record["shadow_text"] = transcript.text
        record["shadow_latency_ms"] = round((time.monotonic() - started) * 1000, 1)
    except Exception as e:
        record["shadow_error"] = f"{type(e).__name__}: {e}"
        logger.warning("Shadow transcription failed (%s): %s", shadow_name, e)
    try:
        from server import db
        await db[SHADOW_COLLECTION].insert_one(record)
    except Exception as e:
        logger.warning("Failed to persist shadow transcription record: %s", e)


def launch_shadow_transcription(
    audio_bytes: bytes,
    file_extension: str,
    language: Optional[str],
    diarization: Optional[str],
    primary_name: str,
    primary_text: str,
    primary_latency_ms: float,
) -> None:
    """Schedule the shadow run without blocking the caller; no-op when shadow mode is off."""
    if get_shadow_provider_name() is None:
        return
    task = asyncio.create_task(_run_shadow_transcription(
        audio_bytes, file_extension, language, diarization,
        primary_name, primary_text, primary_latency_ms,
    ))
    # Keep a reference so the task isn't garbage-collected mid-flight.
    _SHADOW_TASKS.add(task)
    task.add_done_callback(_SHADOW_TASKS.discard)


_SHADOW_TASKS: set[asyncio.Task] = set()
