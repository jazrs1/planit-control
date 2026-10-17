"""The one place hazard indexes come from: /sites, /sites/{id} and the evening briefing all call
predict(). TEMPORARY: rule-based (hazards/scoring.py). The ML model replaces this function's body
and must return the same keys:

  hazard_index_today, top_hazard, top_factors            (today, with the lightning override)
  hazard_index_tomorrow, top_hazard_tomorrow, top_factors_tomorrow   (never the override)
  cards                                                  (per-hazard status and reading)
"""

from hazards.scoring import Inputs, score_site


def predict(inputs: Inputs, species_counts: dict[str, int]) -> dict:
    return score_site(inputs, species_counts)
