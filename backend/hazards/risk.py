"""The one place hazard indexes come from: /sites, /sites/{id}, the stored score history and the
evening briefing all call predict().

Hybrid index, for today and tomorrow (site-local dates):

  index = the highest of
    - the ML weather score: the hazard model's calibrated probability mapped to 0-10
      (ml/model.py; scored hourly from the weather poll, hazards/model_scores.py)
    - the OSHA heat-index band score (lower 0-2, moderate 5, high 7.5, very high 9.5)
    - the wildfire rule (FIRMS distance, red flag), the wildlife rule, and crew reports
      (a crew report that raises a card to watch counts 4.0; today only)
  plus the lightning override, today only: while the site has an active stop-work alert, the index
  is at least 9.0 and the first factor is the stop-work.

The ML model is the weather part (storms, rain, flooding); the rules cover what it can't learn
from its labels (heat, fire, wildlife) and what crews see on the ground. Every factor says whether
it came from the model or a rule. Factors list the stop-work first, then the winning part's reasons,
then any other part at watch or above; weight = that part's share of the summed scores (the model's
share split by its own factor weights). Returns:

  hazard_index_today, top_hazard, top_factors            (today, with the lightning override)
  hazard_index_tomorrow, top_hazard_tomorrow, top_factors_tomorrow   (never the override)
  model_today, model_tomorrow                            (the ML part, or None before the first run)
  cards                                                  (per-hazard status and reading)
"""

import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from hazards.scoring import STOP_WORK_FACTOR, Inputs, score_site

STOP_WORK_MIN = 9.0
SHOW_RULES_FROM = 4.0  # rule factors at watch or above are listed even when another source wins
MAX_FACTORS = 4


@dataclass
class Component:
    source: str            # "model" | "rule"
    hazard: str            # the component's leading HazardType
    score: float           # 0-10
    factors: list[tuple[str, str, float]] = field(default_factory=list)  # (hazard, label, share of this component)


def _model_component(model: dict | None) -> Component | None:
    if not model:
        return None
    factors = [(f["hazard"], f["label"], f["weight"]) for f in model.get("factors") or []]
    return Component("model", factors[0][0] if factors else "lightning", float(model["score"]), factors)


def _rule(hazard: str, score: float, label: str) -> Component | None:
    return Component("rule", hazard, float(score), [(hazard, label, 1.0)]) if score > 0 and label else None


def combine(components: list[Component | None], stop_work: bool) -> tuple[float, str, list[dict]]:
    """(hazard_index, top_hazard, top_factors) from model and rule components."""
    comps = sorted((c for c in components if c is not None), key=lambda c: -c.score)  # stable: model first on ties
    winner = comps[0] if comps else None
    index = winner.score if winner else 0.0
    if stop_work:
        index = max(index, STOP_WORK_MIN)
    shown = [c for c in comps if c.score > 0 and (c is winner or c.score >= SHOW_RULES_FROM)]
    total = sum(c.score for c in shown) + (STOP_WORK_MIN if stop_work else 0.0)
    # Winner first (its reasons explain the number), then other elevated parts, each in its own order.
    factors = [{"hazard": h, "label": label, "weight": c.score / total * share, "source": c.source}
               for c in shown for h, label, share in sorted(c.factors, key=lambda f: -f[2])]
    if stop_work:
        factors.insert(0, {"hazard": "lightning", "label": STOP_WORK_FACTOR, "weight": STOP_WORK_MIN / total,
                           "source": "rule"})
    factors = factors[:MAX_FACTORS]
    for f in factors:  # floor, so the weights never sum past 1
        f["weight"] = math.floor(f["weight"] * 100) / 100
    top = "lightning" if stop_work else winner.hazard if winner and winner.score > 0 else (
        factors[0]["hazard"] if factors else "heat")
    return round(min(index, 10.0), 1), top, factors


def local_days(inputs: Inputs) -> tuple[str, str]:
    """Today's and tomorrow's site-local dates (ISO). Live data, so real time, not the replay clock."""
    now = inputs.now or datetime.now(timezone.utc)
    today = now.astimezone(ZoneInfo(inputs.site["timezone"])).date()
    return today.isoformat(), (today + timedelta(days=1)).isoformat()


def predict(inputs: Inputs, species_counts: dict[str, int]) -> dict:
    scored = score_site(inputs, species_counts)
    rules, crew = scored["rules"], scored["crew"]
    today, tomorrow = local_days(inputs)
    model_today, model_tomorrow = inputs.model.get(today), inputs.model.get(tomorrow)

    index_today, top_today, factors_today = combine(
        [_model_component(model_today)]
        + [_rule(h, rules[h]["today"], rules[h]["label_today"]) for h in ("heat", "wildfire", "wildlife")]
        + [_rule(c["hazard"], c["score"], c["label"]) for c in crew],
        stop_work=inputs.lightning_alert is not None)
    index_tomorrow, top_tomorrow, factors_tomorrow = combine(
        [_model_component(model_tomorrow)]
        + [_rule(h, rules[h]["tomorrow"], rules[h]["label_tomorrow"]) for h in ("heat", "wildfire", "wildlife")],
        stop_work=False)
    return {"cards": scored["cards"],
            "hazard_index_today": index_today, "top_hazard": top_today, "top_factors": factors_today,
            "hazard_index_tomorrow": index_tomorrow, "top_hazard_tomorrow": top_tomorrow,
            "top_factors_tomorrow": factors_tomorrow,
            "model_today": model_today, "model_tomorrow": model_tomorrow}
