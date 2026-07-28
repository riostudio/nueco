from typing import List

from fastapi import APIRouter, Depends, HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from core.deps import get_current_user, get_db
from .service import TripsService, TripNotFoundError, TripPayloadTooLargeError
from .schemas import TripCreate, TripUpdate, TripResponse

router = APIRouter(prefix="/trips", tags=["trips"])


def _user_id(current_user: dict) -> str:
    return current_user.get("id") or str(current_user.get("_id", ""))


@router.post("", response_model=TripResponse)
async def create_trip(
    trip: TripCreate,
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    service = TripsService(db)
    try:
        doc = await service.create(_user_id(current_user), trip)
    except TripPayloadTooLargeError as e:
        raise HTTPException(status_code=413, detail=str(e))
    return TripResponse(**doc)


@router.get("", response_model=List[TripResponse])
async def get_trips(
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    service = TripsService(db)
    trips = await service.list(_user_id(current_user))
    return [TripResponse(**t) for t in trips]


@router.get("/{trip_id}", response_model=TripResponse)
async def get_trip(
    trip_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    service = TripsService(db)
    try:
        trip = await service.get(_user_id(current_user), trip_id)
    except TripNotFoundError:
        raise HTTPException(status_code=404, detail="Trip not found")
    return TripResponse(**trip)


@router.put("/{trip_id}", response_model=TripResponse)
async def update_trip(
    trip_id: str,
    update: TripUpdate,
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    service = TripsService(db)
    try:
        trip = await service.update(_user_id(current_user), trip_id, update)
    except TripPayloadTooLargeError as e:
        raise HTTPException(status_code=413, detail=str(e))
    except TripNotFoundError:
        raise HTTPException(status_code=404, detail="Trip not found")
    return TripResponse(**trip)


@router.delete("/{trip_id}")
async def delete_trip(
    trip_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    service = TripsService(db)
    try:
        await service.delete(_user_id(current_user), trip_id)
    except TripNotFoundError:
        raise HTTPException(status_code=404, detail="Trip not found")
    return {"message": "Trip deleted"}
