from fastapi import APIRouter, Depends, Query
from motor.motor_asyncio import AsyncIOMotorDatabase

from auth.router import get_current_user, get_db
from . import service
from .schemas import (
    NewsHeadlinesResponse, NewsSourceResponse, OutletInfo, SearchFeedsResponse,
)

router = APIRouter(prefix="/dailybrew", tags=["dailybrew"])


@router.get("/news-sources", response_model=NewsSourceResponse)
async def news_sources(
    country: str = Query(...),
    current_user: dict = Depends(get_current_user),
):
    outlets = service.get_country_catalog(country)
    return NewsSourceResponse(
        country=country.upper(),
        outlets=[OutletInfo(id=o.id, name=o.name, description=o.description, topics=o.topics) for o in outlets],
    )


@router.get("/search-feeds", response_model=SearchFeedsResponse)
async def search_feeds(
    q: str = Query(...),
    current_user: dict = Depends(get_current_user),
):
    """Suggests up to 5 specific outlets/feeds matching a free-text search (e.g. "AI",
    "food", "global news") - searches both the country catalog and the topic-focused pool.
    "Following" a suggested feed is just adding its id to the user's saved outlet_ids, same
    array as the country-outlet picker."""
    outlets = service.search_feeds(q)
    return SearchFeedsResponse(
        outlets=[OutletInfo(id=o.id, name=o.name, description=o.description, topics=o.topics) for o in outlets],
    )


@router.get("/outlets", response_model=SearchFeedsResponse)
async def outlets_by_ids(
    ids: str = Query(..., description="Comma-separated outlet ids"),
    current_user: dict = Depends(get_current_user),
):
    """Resolve specific outlet ids to display info - used to show what's already
    selected/followed (including topic-pool feeds) without needing a search query."""
    id_list = [i.strip() for i in ids.split(",") if i.strip()]
    outlets = service.find_outlets(id_list)
    return SearchFeedsResponse(
        outlets=[OutletInfo(id=o.id, name=o.name, description=o.description, topics=o.topics) for o in outlets],
    )


@router.get("/news", response_model=NewsHeadlinesResponse)
async def news(
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    user = await db.users.find_one({"id": current_user["id"]})
    news_country = user.get("news_country") if user else None
    news_outlet_ids = user.get("news_outlet_ids", []) if user else []
    items = await service.get_headlines_for_user(news_country, news_outlet_ids)
    return NewsHeadlinesResponse(items=items)
