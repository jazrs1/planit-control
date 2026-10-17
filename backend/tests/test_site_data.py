"""Without a database, /sites and /sites/{id} fall back to mock hazard cards. They must never
look live: no hazard_status, as_of null, and a reading that says there is no data."""

import pytest

from app import site_data

CARDS = ("heat", "lightning", "flood", "soil", "wildfire", "wildlife_summary")


def assert_no_data(conditions: dict) -> None:
    for name in CARDS:
        card = conditions.get(name)
        if card is None:
            continue
        assert "hazard_status" not in card, name
        assert card["as_of"] is None, name
        assert card["reading"] == site_data.NO_DATA_READING, name


@pytest.mark.parametrize("site_id", ["big-bend", "deerhaven-generating-station", "sanford"])  # own mock / nearest mock
def test_site_detail_fallback_cards_say_no_data(site_id):
    detail = site_data.get_site_detail(None, site_id)
    assert_no_data(detail["conditions"])
    # Required numbers are still present so the response keeps its shape.
    assert isinstance(detail["conditions"]["heat"]["heat_index_f"], (int, float))


def test_site_list_fallback_cards_say_no_data():
    for site in site_data.list_sites(None):
        assert_no_data(site["conditions"])


def test_fallback_still_validates_against_the_response_models():
    from app.schemas import SiteDetail
    SiteDetail(**site_data.get_site_detail(None, "big-bend"))
