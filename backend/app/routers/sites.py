from fastapi import APIRouter, HTTPException

from app import site_data
from app.schemas import Site, SiteDetail

router = APIRouter(prefix="/sites", tags=["sites"])


@router.get("", response_model=list[Site])
def list_sites():
    return site_data.list_sites()


@router.get("/{site_id}", response_model=SiteDetail)
def get_site(site_id: str):
    detail = site_data.get_site_detail(site_id)
    if detail is None:
        raise HTTPException(status_code=404, detail=f"Site '{site_id}' not found")
    return detail
