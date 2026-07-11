from datetime import datetime
from typing import List, Optional
from pydantic import BaseModel


class CanvaConnectResponse(BaseModel):
    authorize_url: str


class CanvaStatusResponse(BaseModel):
    connected: bool
    connected_at: Optional[datetime] = None


class CanvaDesign(BaseModel):
    id: str
    title: str
    thumbnail_url: Optional[str] = None
    updated_at: Optional[int] = None


class CanvaDesignsResponse(BaseModel):
    designs: List[CanvaDesign]
    continuation: Optional[str] = None


class CanvaExportCreateResponse(BaseModel):
    job_id: str
    status: str


class CanvaExportStatusResponse(BaseModel):
    status: str
    download_url: Optional[str] = None
