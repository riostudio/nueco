import os

from fastapi import APIRouter, Depends, HTTPException, Request
from motor.motor_asyncio import AsyncIOMotorDatabase

from core.deps import get_db
from .service import RemindersService

router = APIRouter(prefix="/internal/push", tags=["reminders"])


def _require_tick_secret(request: Request) -> None:
    """Cron/internal endpoints are gated by a shared secret, not user auth."""
    secret = os.environ.get("PUSH_TICK_SECRET")
    if not secret or request.headers.get("X-Tick-Secret") != secret:
        raise HTTPException(status_code=403, detail="Forbidden")


@router.post("/tick")
async def push_tick(request: Request, db: AsyncIOMotorDatabase = Depends(get_db)):
    _require_tick_secret(request)
    return await RemindersService(db).run_tick()


@router.post("/receipts")
async def push_receipts_tick(request: Request, db: AsyncIOMotorDatabase = Depends(get_db)):
    _require_tick_secret(request)
    return await RemindersService(db).resolve_receipts()
