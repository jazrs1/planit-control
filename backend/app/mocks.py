"""Loads shared/mocks/*.json. Routes return these until real data sources are wired in."""

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

MOCKS_DIR = Path(__file__).resolve().parents[2] / "shared" / "mocks"


@lru_cache
def load(name: str) -> Any:
    return json.loads((MOCKS_DIR / f"{name}.json").read_text())
