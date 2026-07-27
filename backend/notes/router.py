from typing import List

from fastapi import APIRouter, Depends, HTTPException, Query
from motor.motor_asyncio import AsyncIOMotorDatabase

from auth.router import get_current_user, get_db
from .service import NotesService, NoteNotFoundError, NotePayloadTooLargeError
from .schemas import NoteCreate, NoteUpdate, NoteResponse

router = APIRouter(prefix="/notes", tags=["notes"])


def _user_id(current_user: dict) -> str:
    return current_user.get("id") or str(current_user.get("_id", ""))


@router.post("", response_model=NoteResponse)
async def create_note(
    note: NoteCreate,
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    service = NotesService(db)
    try:
        doc = await service.create(_user_id(current_user), note)
    except NotePayloadTooLargeError as e:
        raise HTTPException(status_code=413, detail=str(e))
    return NoteResponse(**doc)


@router.get("", response_model=List[NoteResponse])
async def get_notes(
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(50, ge=1, le=100, description="Items per page"),
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    service = NotesService(db)
    notes = await service.list(_user_id(current_user), page, page_size)
    return [NoteResponse(**n) for n in notes]


@router.get("/{note_id}", response_model=NoteResponse)
async def get_note(
    note_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    service = NotesService(db)
    try:
        note = await service.get(_user_id(current_user), note_id)
    except NoteNotFoundError:
        raise HTTPException(status_code=404, detail="Note not found")
    return NoteResponse(**note)


@router.put("/{note_id}", response_model=NoteResponse)
async def update_note(
    note_id: str,
    update: NoteUpdate,
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    service = NotesService(db)
    try:
        note = await service.update(_user_id(current_user), note_id, update)
    except NotePayloadTooLargeError as e:
        raise HTTPException(status_code=413, detail=str(e))
    except NoteNotFoundError:
        raise HTTPException(status_code=404, detail="Note not found")
    return NoteResponse(**note)


@router.delete("/{note_id}")
async def delete_note(
    note_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    service = NotesService(db)
    try:
        await service.delete(_user_id(current_user), note_id)
    except NoteNotFoundError:
        raise HTTPException(status_code=404, detail="Note not found")
    return {"message": "Note deleted"}


@router.post("/{note_id}/toggle-pin", response_model=NoteResponse)
async def toggle_pin(
    note_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    service = NotesService(db)
    try:
        note = await service.toggle_pin(_user_id(current_user), note_id)
    except NoteNotFoundError:
        raise HTTPException(status_code=404, detail="Note not found")
    return NoteResponse(**note)
