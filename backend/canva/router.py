import os
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse
from motor.motor_asyncio import AsyncIOMotorDatabase

from core.deps import get_current_user, get_db
from .service import CanvaService
from .schemas import (
    CanvaConnectResponse, CanvaStatusResponse, CanvaDesignsResponse,
    CanvaExportCreateResponse, CanvaExportStatusResponse,
)

router = APIRouter(prefix="/canva", tags=["canva"])

# The mobile app deep-links back in via this scheme once the backend has finished the OAuth
# exchange - see app.json's `scheme` and ShareIntentProvider's config for the same "memopad" URI
# scheme used elsewhere in this app.
APP_DEEP_LINK_SUCCESS = "memopad://canva-connected?status=success"
APP_DEEP_LINK_FAILURE = "memopad://canva-connected?status=error"


def _callback_redirect_uri() -> str:
    app_url = os.getenv("APP_BASE_URL")
    if not app_url:
        raise HTTPException(status_code=500, detail="APP_BASE_URL environment variable is required")
    return f"{app_url.rstrip('/')}/api/canva/callback"


@router.get("/connect", response_model=CanvaConnectResponse)
async def connect(
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    """Returns the Canva authorize URL to open in an in-app browser session
    (WebBrowser.openAuthSessionAsync on the client)."""
    service = CanvaService(db)
    url = service.build_authorize_url(current_user["id"], _callback_redirect_uri())
    return CanvaConnectResponse(authorize_url=url)


@router.get("/callback")
async def callback(
    code: str = Query(default=""),
    state: str = Query(default=""),
    error: str = Query(default=""),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    """OAuth redirect target registered with Canva. Not called by the app directly - Canva
    redirects the in-app browser here, then this redirects onward to the app's own URI scheme
    to close that browser session and hand control back (see APP_DEEP_LINK_SUCCESS/FAILURE)."""
    if error or not code or not state:
        return RedirectResponse(APP_DEEP_LINK_FAILURE)

    service = CanvaService(db)
    success, _ = await service.exchange_code(code, state, _callback_redirect_uri())
    return RedirectResponse(APP_DEEP_LINK_SUCCESS if success else APP_DEEP_LINK_FAILURE)


@router.get("/status", response_model=CanvaStatusResponse)
async def status(
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    service = CanvaService(db)
    return CanvaStatusResponse(**await service.get_status(current_user["id"]))


@router.delete("/disconnect")
async def disconnect(
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    service = CanvaService(db)
    await service.disconnect(current_user["id"])
    return {"success": True}


@router.get("/designs", response_model=CanvaDesignsResponse)
async def list_designs(
    query: str = Query(default=""),
    continuation: str = Query(default=""),
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    service = CanvaService(db)
    success, data = await service.list_designs(current_user["id"], query or None, continuation or None)
    if not success:
        raise HTTPException(status_code=409, detail=data.get("detail", "Not connected to Canva"))
    return CanvaDesignsResponse(**data)


@router.post("/designs/{design_id}/export", response_model=CanvaExportCreateResponse)
async def export_design(
    design_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    service = CanvaService(db)
    success, data = await service.create_export(current_user["id"], design_id)
    if not success:
        raise HTTPException(status_code=409, detail=data.get("detail", "Export failed"))
    return CanvaExportCreateResponse(**data)


@router.get("/exports/{job_id}", response_model=CanvaExportStatusResponse)
async def export_status(
    job_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    service = CanvaService(db)
    success, data = await service.get_export_status(current_user["id"], job_id)
    if not success:
        raise HTTPException(status_code=409, detail=data.get("detail", "Could not check export status"))
    return CanvaExportStatusResponse(**data)
