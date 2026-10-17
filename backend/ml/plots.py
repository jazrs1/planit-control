"""Calibration (reliability) plot as a standalone SVG, so the docs don't need a plotting library."""

from html import escape

MIN_BIN = 50  # bins with fewer site-days are too noisy to plot

W, H = 680, 460
LEFT, RIGHT, TOP, BOTTOM = 64, 150, 64, 56

STYLE = """
  .surface { fill: #fcfcfb; } .ink { fill: #0b0b0b; } .ink2 { fill: #52514e; }
  .grid { stroke: #e4e3df; } .axis { stroke: #8a8984; } .diag { stroke: #8a8984; }
  .s1 { stroke: #2a78d6; fill: #2a78d6; } .s2 { stroke: #eb6834; fill: #eb6834; } .s3 { stroke: #1baf7a; fill: #1baf7a; }
  .ring { stroke: #fcfcfb; }
  path.line, line.line { fill: none; }
  @media (prefers-color-scheme: dark) {
    .surface { fill: #1a1a19; } .ink { fill: #f0efec; } .ink2 { fill: #c3c2b7; }
    .grid { stroke: #34332f; } .axis { stroke: #8a8984; } .diag { stroke: #77766f; }
    .s1 { stroke: #3987e5; fill: #3987e5; } .s2 { stroke: #d95926; fill: #d95926; } .s3 { stroke: #199e70; fill: #199e70; }
    .ring { stroke: #1a1a19; }
  }
  text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
"""


def calibration_svg(report: dict) -> str:
    series = [("s1", "Model, same-day", report["test_today"]["reliability"]["model"], "")]
    if "test_tomorrow" in report:
        series.append(("s2", "Model, day-ahead", report["test_tomorrow"]["reliability"]["model"], ""))
    series.append(("s3", "Climatology (by month)", report["test_today"]["reliability"]["climatology"], "6 4"))
    pts = {k: [(b["mean_pred"], b["observed"], b["n"]) for b in bins if b["n"] >= MIN_BIN] for k, _, bins, _ in series}
    top = max(max(x, y) for v in pts.values() for x, y, _ in v)
    vmax = min(1.0, (int(top / 0.05) + 1) * 0.05)

    pw, ph = W - LEFT - RIGHT, H - TOP - BOTTOM
    sx = lambda v: LEFT + v / vmax * pw  # noqa: E731
    sy = lambda v: TOP + ph - v / vmax * ph  # noqa: E731

    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" '
           f'aria-labelledby="t d">',
           f"<title id=\"t\">Calibration on the 2025 test year</title>",
           '<desc id="d">Observed share of hazardous site-days versus predicted probability, per bin. '
           "Points on the dashed diagonal mean the predicted chance matched what happened.</desc>",
           f"<style>{STYLE}</style>",
           f'<rect class="surface" width="{W}" height="{H}"/>',
           f'<text class="ink" x="{LEFT}" y="26" font-size="16" font-weight="600">Calibration on the 2025 test year</text>',
           f'<text class="ink2" x="{LEFT}" y="46" font-size="12">Each point is a bin of site-days (n ≥ {MIN_BIN}). '
           "On the diagonal = predicted chance matches what happened.</text>"]

    step = 0.05 if vmax <= 0.3 else 0.1
    ticks = [round(i * step, 2) for i in range(int(round(vmax / step)) + 1)]
    for t in ticks:
        out.append(f'<line class="grid" x1="{LEFT}" x2="{LEFT + pw}" y1="{sy(t):.1f}" y2="{sy(t):.1f}" stroke-width="1"/>')
        out.append(f'<text class="ink2" x="{LEFT - 8}" y="{sy(t) + 4:.1f}" font-size="11" text-anchor="end">{t:.0%}</text>')
        out.append(f'<text class="ink2" x="{sx(t):.1f}" y="{TOP + ph + 18}" font-size="11" text-anchor="middle">{t:.0%}</text>')
    out.append(f'<line class="axis" x1="{LEFT}" x2="{LEFT + pw}" y1="{TOP + ph}" y2="{TOP + ph}" stroke-width="1"/>')
    out.append(f'<line class="diag" x1="{sx(0):.1f}" y1="{sy(0):.1f}" x2="{sx(vmax):.1f}" y2="{sy(vmax):.1f}" '
               'stroke-width="1" stroke-dasharray="2 4"/>')
    out.append(f'<text class="ink2" x="{LEFT + pw / 2}" y="{H - 14}" font-size="12" text-anchor="middle">'
               "Predicted probability of a hazardous day</text>")
    out.append(f'<text class="ink2" x="16" y="{TOP + ph / 2}" font-size="12" text-anchor="middle" '
               f'transform="rotate(-90 16 {TOP + ph / 2})">Observed share hazardous</text>')

    label_y = []
    for key, name, _, dash in series:
        p = pts[key]
        if not p:
            continue
        path = " ".join(f"{'M' if i == 0 else 'L'}{sx(x):.1f},{sy(y):.1f}" for i, (x, y, _) in enumerate(p))
        dash_attr = f' stroke-dasharray="{dash}"' if dash else ""
        out.append(f'<path class="{key} line" d="{path}" stroke-width="2" stroke-linejoin="round"{dash_attr}/>')
        for x, y, n in p:
            out.append(f'<circle class="{key} ring" cx="{sx(x):.1f}" cy="{sy(y):.1f}" r="4.5" stroke-width="2">'
                       f'<title>{escape(name)}: predicted {x:.1%}, observed {y:.1%} '
                       f"({n:,} site-days)</title></circle>")
        # Direct label at the line's end, nudged apart from the others.
        ly = sy(p[-1][1])
        for prev in label_y:
            if abs(ly - prev) < 16:
                ly = prev + 16
        label_y.append(ly)
        out.append(f'<text class="ink" x="{sx(p[-1][0]) + 10:.1f}" y="{ly + 4:.1f}" font-size="12">{escape(name)}</text>')

    # Legend (identity never by color alone: the climatology line is also dashed).
    lx, ly0 = LEFT + 16, TOP + 14  # upper left: above the diagonal, where calibrated points never sit
    for i, (key, name, _, dash) in enumerate(series):
        y = ly0 + i * 20
        dash_attr = f' stroke-dasharray="{dash}"' if dash else ""
        out.append(f'<line class="{key} line" x1="{lx}" x2="{lx + 22}" y1="{y}" y2="{y}" stroke-width="2"{dash_attr}/>')
        out.append(f'<text class="ink2" x="{lx + 28}" y="{y + 4}" font-size="11">{escape(name)}</text>')
    out.append("</svg>")
    return "\n".join(out) + "\n"
