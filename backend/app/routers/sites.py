from fastapi import APIRouter, HTTPException

from app import mocks
from app.schemas import Site, SiteDetail

router = APIRouter(prefix="/sites", tags=["sites"])


@router.get("", response_model=list[Site])
def list_sites():
    return mocks.load("sites")


@router.get("/{site_id}", response_model=SiteDetail)
def get_site(site_id: str):
    detail = mocks.load("site_details").get(site_id)
    if detail is None:
        raise HTTPException(status_code=404, detail=f"Site '{site_id}' not found")
    return detail
