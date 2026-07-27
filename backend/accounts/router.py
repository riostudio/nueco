from fastapi import APIRouter, Depends, HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from core.deps import get_current_user, get_db
from .service import AccountsService, IncorrectPasswordError, UserNotFoundError
from .schemas import DeleteAccountRequest

router = APIRouter(prefix="/account", tags=["accounts"])


@router.post("/delete")
async def delete_account(
    body: DeleteAccountRequest,
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    user_id = current_user.get("id") or str(current_user.get("_id", ""))
    try:
        await AccountsService(db).erase(user_id, body.password)
    except UserNotFoundError:
        raise HTTPException(status_code=404, detail="User not found")
    except IncorrectPasswordError:
        raise HTTPException(status_code=401, detail="Incorrect password")
    return {"ok": True}
