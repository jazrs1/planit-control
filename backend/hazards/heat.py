"""NWS heat index and OSHA heat-risk bands."""

import math


def heat_index_f(temp_f: float, rh_pct: float) -> float:
    """NWS heat index (°F) from air temperature (°F) and relative humidity (%).

    Per the NWS method (wpc.ncep.noaa.gov/html/heatindex_equation.shtml): start with Steadman's
    simple formula; if its average with the temperature is 80°F or more, use the Rothfusz
    regression instead, with the low-humidity and high-humidity adjustments.
    """
    t, rh = temp_f, rh_pct
    simple = 0.5 * (t + 61.0 + (t - 68.0) * 1.2 + rh * 0.094)
    if (simple + t) / 2 < 80:
        return simple
    hi = (-42.379 + 2.04901523 * t + 10.14333127 * rh - 0.22475541 * t * rh
          - 0.00683783 * t * t - 0.05481717 * rh * rh + 0.00122874 * t * t * rh
          + 0.00085282 * t * rh * rh - 0.00000199 * t * t * rh * rh)
    if rh < 13 and 80 <= t <= 112:
        hi -= ((13 - rh) / 4) * math.sqrt((17 - abs(t - 95)) / 17)
    elif rh > 85 and 80 <= t <= 87:
        hi += ((rh - 85) / 10) * ((87 - t) / 5)
    return hi


def osha_risk_band(heat_index: float) -> str:
    """OSHA heat index risk level: under 91 lower, 91-103 moderate, 103-115 high, over 115 very high."""
    if heat_index < 91:
        return "lower"
    if heat_index < 103:
        return "moderate"
    if heat_index <= 115:
        return "high"
    return "very_high"
