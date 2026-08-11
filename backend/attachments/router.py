import asyncio

from fastapi import APIRouter, Depends, HTTPException, Query

from motor.motor_asyncio import AsyncIOMotorDatabase

from core.deps import get_current_user, get_db
from . import service
from .service import (
    AttachmentAccessDeniedError,
    AttachmentQuotaExceededError,
    AttachmentStorageError,
    AttachmentStorageUnavailableError,
    AttachmentTooLargeError,
    UnsupportedAttachmentTypeError,
)
from .schemas import DownloadUrlRequest, PresignRequest

# No prefix: mounted directly on api_router (which already carries "/api"), preserving the
# existing /api/attachments/... contract the client uses.
router = APIRouter(tags=["attachments"])


def _user_id(current_user: dict) -> str:
    return current_user.get("id") or str(current_user.get("_id", ""))


@router.post("/attachments/presign")
async def presign_attachment(
    req: PresignRequest,
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    # to_thread: service.* below call sync boto3, which would otherwise block the event loop -
    # these are the hottest attachment routes (every upload/delete/open), so it matters in
    # aggregate even where a single call is cheap.
    user_id = _user_id(current_user)
    # Usage is read here (async, has the db) and passed in, so presign_upload stays sync and
    # database-free - the router owns the I/O, the service owns the rule.
    used = await service.used_storage_bytes(db, user_id)
    try:
        return await asyncio.to_thread(
            service.presign_upload, user_id, req.filename, req.mime_type, req.size, used
        )
    except AttachmentStorageUnavailableError:
        raise HTTPException(status_code=503, detail="File attachments are not enabled on this server")
    except AttachmentTooLargeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except AttachmentQuotaExceededError as e:
        # 507 rather than 400: the request is well-formed, the account simply has no room.
        raise HTTPException(status_code=507, detail=str(e))
    except UnsupportedAttachmentTypeError:
        raise HTTPException(status_code=400, detail="File type not allowed")
    except AttachmentStorageError as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.delete("/attachments")
async def delete_attachment(key: str = Query(...), current_user: dict = Depends(get_current_user)):
    try:
        await asyncio.to_thread(service.delete_attachment, _user_id(current_user), key)
    except AttachmentStorageUnavailableError:
        raise HTTPException(status_code=503, detail="File attachments are not enabled on this server")
    except AttachmentAccessDeniedError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except AttachmentStorageError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"message": "Attachment deleted"}


@router.post("/attachments/download-url")
async def attachment_download_url(req: DownloadUrlRequest, current_user: dict = Depends(get_current_user)):
    try:
        url = await asyncio.to_thread(service.presign_download, _user_id(current_user), req.key)
    except AttachmentStorageUnavailableError:
        raise HTTPException(status_code=503, detail="File attachments are not enabled on this server")
    except AttachmentAccessDeniedError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except AttachmentStorageError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"url": url}
