from fastapi import APIRouter

from app import mocks
from app.schemas import Alert

router = APIRouter(prefix="/alerts", tags=["alerts"])


@router.get("", response_model=list[Alert])
def list_active_alerts():
    return mocks.load("alerts")
