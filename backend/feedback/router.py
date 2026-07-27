from fastapi import APIRouter, Depends, HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from core.deps import get_current_user, get_db
from .service import FeedbackService, FeedbackRateLimitedError, FeedbackTextTooLongError, InvalidSentimentError
from .schemas import FeedbackCreate

router = APIRouter(prefix="/feedback", tags=["feedback"])


@router.post("")
async def submit_feedback(
    body: FeedbackCreate,
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    user_id = current_user.get("id") or str(current_user.get("_id", ""))
    try:
        return await FeedbackService(db).submit(user_id, body)
    except InvalidSentimentError:
        raise HTTPException(status_code=400, detail="Invalid sentiment")
    except FeedbackTextTooLongError:
        raise HTTPException(status_code=400, detail="Feedback text too long")
    except FeedbackRateLimitedError:
        raise HTTPException(status_code=429, detail="Too many feedback submissions, please try again later")
