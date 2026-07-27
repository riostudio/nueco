import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from motor.motor_asyncio import AsyncIOMotorDatabase

from core.deps import get_current_user, get_db
from . import service
from .schemas import (
    AddCustomFeedRequest, NewsHeadlinesResponse, NewsSourceResponse, OutletInfo, SearchFeedsResponse,
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
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    """Resolve specific outlet ids to display info - used to show what's already
    selected/followed (including topic-pool feeds and this user's own custom feeds)
    without needing a search query."""
    id_list = [i.strip() for i in ids.split(",") if i.strip()]
    user = await db.users.find_one({"id": current_user["id"]})
    custom_feeds = user.get("custom_news_feeds", []) if user else []
    outlets = service.find_outlets(id_list, custom_feeds=custom_feeds)
    return SearchFeedsResponse(
        outlets=[OutletInfo(id=o.id, name=o.name, description=o.description, topics=o.topics) for o in outlets],
    )


@router.post("/custom-feed", response_model=OutletInfo)
async def add_custom_feed(
    body: AddCustomFeedRequest,
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    """Lets a user follow any website's own RSS/Atom feed, not just the curated catalog -
    validated with a live fetch (and its <title> used as the display name) before being saved,
    so a broken or non-feed URL never silently makes it into the picker."""
    feed_url = body.feed_url.strip()
    user = await db.users.find_one({"id": current_user["id"]})
    existing = user.get("custom_news_feeds", []) if user else []

    # Already added (possibly at a different, pre-redirect URL) - reuse it instead of duplicating.
    for cf in existing:
        if cf["feed_url"] == feed_url:
            return OutletInfo(id=cf["id"], name=cf["name"], description="Custom feed", topics=[])

    try:
        name, resolved_url = await service.fetch_custom_feed_name(feed_url)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    new_feed = {"id": f"custom:{uuid.uuid4()}", "name": name, "feed_url": resolved_url}
    await db.users.update_one(
        {"id": current_user["id"]},
        {"$push": {"custom_news_feeds": new_feed}},
    )
    return OutletInfo(id=new_feed["id"], name=new_feed["name"], description="Custom feed", topics=[])


@router.get("/news", response_model=NewsHeadlinesResponse)
async def news(
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    user = await db.users.find_one({"id": current_user["id"]})
    news_country = user.get("news_country") if user else None
    news_outlet_ids = user.get("news_outlet_ids", []) if user else []
    custom_feeds = user.get("custom_news_feeds", []) if user else []
    items = await service.get_headlines_for_user(news_country, news_outlet_ids, custom_feeds=custom_feeds)
    return NewsHeadlinesResponse(items=items)
