from fastapi import APIRouter, HTTPException

from app import mocks
from app.schemas import Briefing

router = APIRouter(prefix="/briefing", tags=["briefing"])


@router.get("/{site_id}", response_model=Briefing)
def get_briefing(site_id: str):
    briefing = mocks.load("briefings").get(site_id)
    if briefing is None:
        raise HTTPException(status_code=404, detail=f"No briefing for site '{site_id}'")
    return briefing
