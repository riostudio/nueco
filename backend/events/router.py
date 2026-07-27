from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from motor.motor_asyncio import AsyncIOMotorDatabase

from auth.router import get_current_user, get_db
from .service import EventsService, EventNotFoundError, EventPayloadTooLargeError
from .schemas import EventCreate, EventUpdate, EventResponse, BatchEventIds

router = APIRouter(prefix="/events", tags=["events"])


def _user_id(current_user: dict) -> str:
    return current_user.get("id") or str(current_user.get("_id", ""))


@router.post("", response_model=EventResponse)
async def create_event(
    event: EventCreate,
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    service = EventsService(db)
    try:
        doc = await service.create(_user_id(current_user), event)
    except EventPayloadTooLargeError as e:
        raise HTTPException(status_code=413, detail=str(e))
    return EventResponse(**doc)


@router.get("", response_model=List[EventResponse])
async def get_events(
    month: Optional[int] = Query(None),
    year: Optional[int] = Query(None),
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    service = EventsService(db)
    events = await service.list(_user_id(current_user), month, year)
    return [EventResponse(**e) for e in events]


@router.get("/{event_id}", response_model=EventResponse)
async def get_event(
    event_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    service = EventsService(db)
    try:
        event = await service.get(_user_id(current_user), event_id)
    except EventNotFoundError:
        raise HTTPException(status_code=404, detail="Event not found")
    return EventResponse(**event)


# Batch endpoint to fix N+1 query issue
@router.post("/batch", response_model=List[EventResponse])
async def get_events_batch(
    batch_request: BatchEventIds,
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    service = EventsService(db)
    events = await service.get_batch(_user_id(current_user), batch_request.event_ids)
    return [EventResponse(**e) for e in events]


@router.put("/{event_id}", response_model=EventResponse)
async def update_event(
    event_id: str,
    update: EventUpdate,
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    service = EventsService(db)
    try:
        event = await service.update(_user_id(current_user), event_id, update)
    except EventPayloadTooLargeError as e:
        raise HTTPException(status_code=413, detail=str(e))
    except EventNotFoundError:
        raise HTTPException(status_code=404, detail="Event not found")
    return EventResponse(**event)


@router.delete("/{event_id}")
async def delete_event(
    event_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    service = EventsService(db)
    try:
        await service.delete(_user_id(current_user), event_id)
    except EventNotFoundError:
        raise HTTPException(status_code=404, detail="Event not found")
    return {"message": "Event deleted"}
