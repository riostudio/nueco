from datetime import datetime
from typing import List, Optional
from pydantic import BaseModel


class NewsItem(BaseModel):
    headline: str
    link: str
    source_name: str
    published_at: Optional[datetime] = None


class NewsHeadlinesResponse(BaseModel):
    items: List[NewsItem]


class OutletInfo(BaseModel):
    id: str
    name: str
    description: str
    topics: List[str] = []


class NewsSourceResponse(BaseModel):
    country: str
    outlets: List[OutletInfo]


class SearchFeedsResponse(BaseModel):
    outlets: List[OutletInfo]


class UpdateNewsPreferencesRequest(BaseModel):
    country: str
    outlet_ids: List[str]
