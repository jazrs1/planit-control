"""scripts/delete_reports: dry run changes nothing; --yes deletes the rows and their unshared photos only."""

from datetime import datetime, timedelta, timezone

import psycopg
import pytest
from psycopg.rows import dict_row

from app.config import get_settings
from scripts.delete_reports import delete, list_recent, photo_file


def test_photo_file(tmp_path):
    assert photo_file("https://api.example/uploads/abc.jpg", tmp_path) == tmp_path / "abc.jpg"
    assert photo_file("http://localhost:8000/uploads/abc.png?x=1", tmp_path) == tmp_path / "abc.png"
    assert photo_file(None, tmp_path) is None
    assert photo_file("", tmp_path) is None
    assert photo_file("https://api.example/uploads/", tmp_path) is None
    assert photo_file("https://api.example/uploads/.env", tmp_path) is None
    assert photo_file("https://api.example/uploads/..", tmp_path) is None


@pytest.fixture
def conn():
    url = get_settings().database_url
    if not url:
        pytest.skip("DATABASE_URL not set")
    with psycopg.connect(url, row_factory=dict_row, connect_timeout=15) as conn:
        try:
            yield conn
        finally:
            conn.rollback()


def add(conn, note, photo_url, minutes_ago=5):
    return conn.execute(
        """INSERT INTO reports (site_id, lat, lon, category, note, photo_url, reporter_role, created_at)
           VALUES (NULL, 29.6436, -82.3549, 'other', %s, %s, 'crew_member', %s) RETURNING id""",
        (note, photo_url, datetime.now(timezone.utc) - timedelta(minutes=minutes_ago))).fetchone()["id"]


def test_dry_run_then_delete(conn, tmp_path):
    for name in ("a.jpg", "shared.jpg"):
        (tmp_path / name).write_bytes(b"jpeg")
    a = add(conn, "test a", "https://api.example/uploads/a.jpg")
    b = add(conn, "test b", "https://api.example/uploads/shared.jpg")
    keep = add(conn, "test keep", "https://api.example/uploads/shared.jpg")
    old = add(conn, "test old", "https://example.invalid/old.jpg", minutes_ago=3 * 60)

    recent = [r["id"] for r in list_recent(conn, hours=1)]
    assert {a, b, keep} <= set(recent) and old not in recent

    rows, files = delete(conn, [a, b, "rpt_nope"], tmp_path, yes=False)
    assert {r["id"] for r in rows} == {a, b}
    assert files == [tmp_path / "a.jpg"]   # shared.jpg is still used by `keep`
    assert conn.execute("SELECT count(*) AS n FROM reports WHERE id = ANY(%s)", ([a, b],)).fetchone()["n"] == 2
    assert (tmp_path / "a.jpg").exists()

    rows, files = delete(conn, [a, b], tmp_path, yes=True)
    assert {r["id"] for r in rows} == {a, b} and files == [tmp_path / "a.jpg"]
    left = {r["id"] for r in conn.execute("SELECT id FROM reports WHERE id = ANY(%s)", ([a, b, keep, old],))}
    assert left == {keep, old}
    assert not (tmp_path / "a.jpg").exists() and (tmp_path / "shared.jpg").exists()
