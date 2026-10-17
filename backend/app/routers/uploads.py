"""Photo uploads for hazard reports. Stored in backend/uploads/ and served at /uploads/<file>.

Send the raw image as the request body with its Content-Type, e.g.
    fetch(`${API}/uploads`, { method: "POST", headers: { "Content-Type": file.type }, body: file })
then pass the returned photo_url to POST /reports.
"""

import uuid

from fastapi import APIRouter, HTTPException, Request, status

from app.config import BACKEND_DIR
from app.schemas import UploadResponse

router = APIRouter(prefix="/uploads", tags=["uploads"])

UPLOADS_DIR = BACKEND_DIR / "uploads"
MAX_BYTES = 10 * 1024 * 1024
EXTENSIONS = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/heic": ".heic"}


def _looks_like(content_type: str, data: bytes) -> bool:
    """Check the file's magic bytes match its declared type."""
    if content_type == "image/jpeg":
        return data[:3] == b"\xff\xd8\xff"
    if content_type == "image/png":
        return data[:8] == b"\x89PNG\r\n\x1a\n"
    if content_type == "image/webp":
        return data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    return data[4:8] == b"ftyp"  # HEIC


@router.post("", response_model=UploadResponse, status_code=status.HTTP_201_CREATED)
async def upload_photo(request: Request):
    content_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
    ext = EXTENSIONS.get(content_type)
    if ext is None:
        raise HTTPException(415, f"Content-Type must be one of: {', '.join(EXTENSIONS)}")

    data = bytearray()
    async for chunk in request.stream():
        data += chunk
        if len(data) > MAX_BYTES:
            raise HTTPException(413, f"Photo is larger than {MAX_BYTES // (1024 * 1024)} MB")
    if not _looks_like(content_type, bytes(data[:12])):
        raise HTTPException(400, f"Body is not a valid {content_type} image")

    name = f"{uuid.uuid4().hex}{ext}"
    (UPLOADS_DIR / name).write_bytes(data)
    return {"photo_url": str(request.url_for("uploads", path=name))}
