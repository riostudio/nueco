import base64
import logging
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from auth.router import get_current_user
from . import service
from .schemas import TextProcessRequest, TranscribeBase64Request

logger = logging.getLogger(__name__)

# No prefix: mounted directly on api_router (which already carries "/api"), preserving the
# existing /api/transcribe, /api/transcribe-base64, /api/process-text contract the client uses.
router = APIRouter(tags=["textai"])


@router.post("/transcribe-base64")
async def transcribe_audio_base64(request: TranscribeBase64Request, current_user: dict = Depends(get_current_user)):
    """Transcribe audio from base64 encoded data (requires authentication)"""
    try:
        logger.info(
            f"Received base64 transcription request. Extension: {request.file_extension}, "
            f"Base64 length: {len(request.audio_base64)}"
        )
        try:
            audio_bytes = base64.b64decode(request.audio_base64)
            logger.info(f"Decoded {len(audio_bytes)} bytes from base64")
        except Exception as e:
            logger.error(f"Failed to decode base64: {e}")
            raise HTTPException(status_code=400, detail="Invalid base64 audio data")

        text = await service.transcribe_bytes(audio_bytes, request.file_extension, request.language)
        logger.info(f"Transcription successful: {text[:100] if text else 'empty'}...")
        return {"text": text}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Transcription error: {e}")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")


@router.post("/transcribe")
async def transcribe_audio(
    file: UploadFile = File(...),
    language: Optional[str] = Form(None),
    current_user: dict = Depends(get_current_user),
):
    """Transcribe uploaded audio file (requires authentication)"""
    try:
        logger.info(f"Received transcription request. Filename: {file.filename}, Content-Type: {file.content_type}")
        text = await service.transcribe_upload(file, language)
        logger.info(f"Transcription successful: {text[:100]}...")
        return {"text": text}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Transcription error: {e}")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")


@router.post("/process-text")
async def process_text_route(request: TextProcessRequest, current_user: dict = Depends(get_current_user)):
    """Process text using AI - organize, summarize, or detect-and-restructure by note type (requires authentication)"""
    try:
        return await service.process_text(request.text, request.action)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Text processing error: {e}")
        raise HTTPException(status_code=500, detail=f"Text processing failed: {str(e)}")
