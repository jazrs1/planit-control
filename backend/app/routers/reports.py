from fastapi import APIRouter, Depends, HTTPException, Query, status
from psycopg import errors
from psycopg_pool import ConnectionPool

from app.db import get_pool
from app.schemas import CreateReportRequest, HazardReport

router = APIRouter(prefix="/reports", tags=["reports"])

COLUMNS = "id, site_id, photo_url, lat, lon, category, species, note, reporter_role, created_at"


@router.get("", response_model=list[HazardReport])
def list_reports(limit: int = Query(200, ge=1, le=1000), pool: ConnectionPool = Depends(get_pool)):
    with pool.connection() as conn:
        return conn.execute(
            f"SELECT {COLUMNS} FROM reports ORDER BY created_at DESC LIMIT %s", (limit,)
        ).fetchall()


@router.post("", response_model=HazardReport, status_code=status.HTTP_201_CREATED)
def create_report(body: CreateReportRequest, pool: ConnectionPool = Depends(get_pool)):
    try:
        with pool.connection() as conn:
            return conn.execute(
                f"""INSERT INTO reports (site_id, photo_url, lat, lon, category, species, note, reporter_role)
                    VALUES (%(site_id)s, %(photo_url)s, %(lat)s, %(lon)s, %(category)s, %(species)s, %(note)s,
                            %(reporter_role)s)
                    RETURNING {COLUMNS}""",
                body.model_dump(),
            ).fetchone()
    except errors.ForeignKeyViolation:
        raise HTTPException(status_code=422, detail=f"Unknown site_id '{body.site_id}'")
