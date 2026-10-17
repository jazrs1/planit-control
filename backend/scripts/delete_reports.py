"""List recent crew reports, and delete chosen ones by id together with their photo files.

On the server (dry run by default: lists, and shows what would be deleted):

    cd /opt/planit/app/backend && sudo -u planit -H /opt/planit/venv/bin/python -m scripts.delete_reports
    ... -m scripts.delete_reports --hours 6                      # list the last 6 hours (default 48)
    ... -m scripts.delete_reports rpt_ab12cd34 rpt_ef56gh78       # show what would be deleted
    ... -m scripts.delete_reports rpt_ab12cd34 rpt_ef56gh78 --yes # delete them

A report's photo is the file named at the end of its photo_url, in UPLOADS_DIR (get_settings().uploads_path);
a photo another report still uses is kept. Unknown ids are reported and skipped.

The API's response cache lives inside the API process, so this script can't clear it, but every cached
response that includes reports (sites, site details, wildlife, map points) expires within API_CACHE_SECONDS
(default 2.5 s): the next requests after that no longer see the deleted reports, and the site cards and
hazard index stop counting them. Briefings already written are not changed.
"""

import argparse
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

import psycopg
from psycopg.rows import dict_row

from app.config import get_settings

COLUMNS = "id, site_id, created_at, category, species, note, lat, lon, photo_url"


def photo_file(photo_url: str | None, uploads: Path) -> Path | None:
    """The uploaded file a photo_url points to, or None when it isn't one of ours (no photo, or a bad name)."""
    if not photo_url:
        return None
    path = urlparse(photo_url).path
    name = "" if path.endswith("/") else Path(path).name
    if not name or name.startswith("."):
        return None
    path = uploads / name
    return path if path.resolve().parent == uploads.resolve() else None


def describe(r: dict) -> str:
    what = r["category"] + (f" ({r['species']})" if r["species"] else "")
    note = (r["note"] or "").replace("\n", " ")
    note = note if len(note) <= 60 else note[:57] + "..."
    return (f"{r['id']:<14} {r['created_at'].astimezone(timezone.utc):%Y-%m-%d %H:%M} UTC  {what:<24} "
            f"{r['lat']:.5f}, {r['lon']:.5f}  {r['site_id'] or '-':<24} {'photo' if r['photo_url'] else '     '}  {note}")


def list_recent(conn, hours: float) -> list[dict]:
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    return conn.execute(f"SELECT {COLUMNS} FROM reports WHERE created_at >= %s ORDER BY created_at DESC",
                        (since,)).fetchall()


def delete(conn, ids: list[str], uploads: Path, yes: bool) -> tuple[list[dict], list[Path]]:
    """Delete these reports (only with yes; otherwise roll back) and then their photos no other report uses.
    Returns the reports found and the photo files removed (or that would be removed)."""
    with conn.transaction():
        rows = conn.execute(f"DELETE FROM reports WHERE id = ANY(%s) RETURNING {COLUMNS}", (ids,)).fetchall()
        files = {p for r in rows if (p := photo_file(r["photo_url"], uploads))}
        if files:
            still_used = conn.execute("SELECT photo_url FROM reports WHERE photo_url IS NOT NULL").fetchall()
            files -= {photo_file(r["photo_url"], uploads) for r in still_used}
        files = sorted(p for p in files if p.exists())
        if not yes:
            raise psycopg.Rollback()   # leaves the block without committing: nothing changed
    if yes:   # only after the rows are committed, so a failed delete never loses a photo
        for p in files:
            p.unlink(missing_ok=True)
    return sorted(rows, key=lambda r: r["created_at"], reverse=True), files


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("ids", nargs="*", help="report ids to delete (rpt_...)")
    parser.add_argument("--hours", type=float, default=48, help="list reports from the last N hours (default 48)")
    parser.add_argument("--yes", action="store_true", help="really delete (default: dry run)")
    args = parser.parse_args()
    settings = get_settings()
    uploads = settings.uploads_path

    # autocommit, so conn.transaction() below is the real transaction and commits before photos are removed
    with psycopg.connect(settings.database_url, row_factory=dict_row, autocommit=True) as conn:
        recent = list_recent(conn, args.hours)
        print(f"Crew reports from the last {args.hours:g} h: {len(recent)} (newest first)")
        for r in recent:
            print("  " + describe(r))
        if not args.ids:
            return

        ids = list(dict.fromkeys(args.ids))
        rows, files = delete(conn, ids, uploads, args.yes)
        found = {r["id"] for r in rows}
        verb = "Deleted" if args.yes else "Would delete"
        print(f"\n{verb} {len(rows)} report{'s' if len(rows) != 1 else ''}:")
        for r in rows:
            print("  " + describe(r))
        for i in ids:
            if i not in found:
                print(f"  {i}: no such report (skipped)")
        print(f"{verb} {len(files)} photo file{'s' if len(files) != 1 else ''} in {uploads}"
              + "".join(f"\n  {p.name}" for p in files))
        if args.yes:
            print(f"The API stops showing them within API_CACHE_SECONDS ({settings.api_cache_seconds:g} s).")
        else:
            print("Dry run: nothing deleted. Add --yes to delete.")


if __name__ == "__main__":
    main()
