"""Filesystem locations shared by the ML scripts."""

import json
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
SITES_PATH = BACKEND_DIR / "data" / "sites.json"
# Downloads and intermediate tables (gitignored via **/data/*).
DATA_DIR = BACKEND_DIR / "data" / "ml"
# Trained artifacts (committed).
MODELS_DIR = Path(__file__).resolve().parent / "models"
DOCS_DIR = BACKEND_DIR.parent / "docs"

USER_AGENT = "PlanIT-Control/0.1 (SwampHacks XII hazard model; https://github.com/jazrs1/planit-control)"


def load_sites() -> list[dict]:
    return json.loads(SITES_PATH.read_text())["sites"]
