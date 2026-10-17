"""Deployment config: CORS origins and the uploads folder."""

from pathlib import Path

from app.config import BACKEND_DIR, Settings


def settings(**values) -> Settings:
    return Settings(_env_file=None, **values)


def test_cors_origins_are_trimmed_and_lose_trailing_slashes():
    s = settings(cors_origins=" https://planit.example.com/, https://planit-control.vercel.app ,,http://localhost:3000")
    assert s.cors_origin_list == ["https://planit.example.com", "https://planit-control.vercel.app",
                                  "http://localhost:3000"]


def test_cors_origin_regex_is_off_by_default():
    assert settings().cors_origin_regex == ""


def test_uploads_default_to_backend_uploads():
    assert settings().uploads_path == BACKEND_DIR / "uploads"


def test_uploads_dir_override():
    assert settings(uploads_dir="/var/lib/planit/uploads").uploads_path == Path("/var/lib/planit/uploads")
