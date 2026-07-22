from fastapi import APIRouter, Depends, Query

from auth.router import get_current_user
from . import service
from .schemas import DownloadUrlRequest, PresignRequest

# No prefix: mounted directly on api_router (which already carries "/api"), preserving the
# existing /api/attachments/... contract the client uses.
router = APIRouter(tags=["attachments"])


def _user_id(current_user: dict) -> str:
    return current_user.get("id") or str(current_user.get("_id", ""))


@router.post("/attachments/presign")
async def presign_attachment(req: PresignRequest, current_user: dict = Depends(get_current_user)):
    return service.presign_upload(_user_id(current_user), req.filename, req.mime_type, req.size)


@router.delete("/attachments")
async def delete_attachment(key: str = Query(...), current_user: dict = Depends(get_current_user)):
    service.delete_attachment(_user_id(current_user), key)
    return {"message": "Attachment deleted"}


@router.post("/attachments/download-url")
async def attachment_download_url(req: DownloadUrlRequest, current_user: dict = Depends(get_current_user)):
    url = service.presign_download(_user_id(current_user), req.key)
    return {"url": url}
