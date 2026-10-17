import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, status

from app import mocks
from app.schemas import CreateReportRequest, HazardReport

router = APIRouter(prefix="/reports", tags=["reports"])

# In-memory until the database is wired in; resets on restart.
_created: list[HazardReport] = []


@router.get("", response_model=list[HazardReport])
def list_reports():
    seeded = [HazardReport(**r) for r in mocks.load("reports")]
    return sorted(_created + seeded, key=lambda r: r.created_at, reverse=True)


@router.post("", response_model=HazardReport, status_code=status.HTTP_201_CREATED)
def create_report(body: CreateReportRequest):
    report = HazardReport(
        **body.model_dump(),
        id=f"rpt_{uuid.uuid4().hex[:6]}",
        created_at=datetime.now(timezone.utc),
    )
    _created.append(report)
    return report
