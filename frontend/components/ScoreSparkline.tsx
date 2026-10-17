"use client";

import { useId, useState } from "react";
import type { PointerEvent } from "react";
import type { ScoreHistory, ScorePoint, Site } from "@shared/types";
import { riskLevel } from "@/lib/risk";
import { MIN_HISTORY_POINTS, historyPoints, historySegments } from "@/lib/scoreHistory";
import { formatSiteDateTime } from "@/lib/time";

const POINT_COLOR = { green: "fill-risk-green", amber: "fill-risk-amber", red: "fill-risk-red" } as const;
const WIDTH = 600, LEFT = 8, RIGHT = 592, TOP = 8, HEIGHT = 84;
const y = (score: number) => TOP + HEIGHT * (1 - score / 10);

/** "4:03 PM run · 9.0": a run's time and score, so the chart never reads as the site's current index. */
function runLabel(point: ScorePoint, timeZone: string) {
  return `${new Date(point.scored_at).toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" })} run · ${point.hazard_index.toFixed(1)}`;
}

/** Compact: today's runs (site-local date), or the last 24 h while today has too few. */
function compactPoints(all: ScorePoint[]): { points: ScorePoint[]; label: string } {
  const latest = all.at(-1);
  if (!latest) return { points: [], label: "Today" };
  const today = all.filter((point) => point.for_date === latest.for_date);
  if (today.length >= MIN_HISTORY_POINTS) return { points: today, label: "Today" };
  return { points: all.filter((point) => Date.parse(point.scored_at) >= Date.parse(latest.scored_at) - 24 * 60 * 60_000), label: "Last 24 h" };
}

export default function ScoreSparkline({ history, site, compact = false, unconfirmed = false, demo = false }: { history: ScoreHistory | null; site: Site; compact?: boolean; unconfirmed?: boolean; demo?: boolean }) {
  const all = history?.site_id === site.id ? historyPoints(history) : [];
  const { points, label: spanLabel } = compact ? compactPoints(all) : { points: all, label: "7 days" };
  const latest = points.at(-1);
  const [active, setActive] = useState<number | null>(null);
  const tooltipId = useId();
  if (points.length < MIN_HISTORY_POINTS || !latest) return <p className="text-sm text-muted">Not enough history yet{demo && " · Demo data"}.<span className="block text-xs">At least {MIN_HISTORY_POINTS} hourly scoring runs are needed.</span></p>;

  // The axis spans the runs we have, not an empty window.
  const end = Date.parse(latest.scored_at);
  const start = Math.min(Date.parse(points[0].scored_at), end - 60 * 60_000);
  const span = Math.max(1, end - start);
  const x = (point: ScorePoint) => LEFT + (Date.parse(point.scored_at) - start) / span * (RIGHT - LEFT);
  const selected = active === null ? null : points[Math.min(active, points.length - 1)];
  const describe = (point: ScorePoint) => `${formatSiteDateTime(point.scored_at, site.timezone)} · ${point.hazard_index.toFixed(1)} / 10${unconfirmed ? " ? · Last known · Not confirmed" : ""}${demo ? " · Demo data" : ""}`;
  const pick = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const target = (event.clientX - rect.left) / rect.width * WIDTH;
    let nearest = 0;
    points.forEach((point, index) => { if (Math.abs(x(point) - target) < Math.abs(x(points[nearest]) - target)) nearest = index; });
    setActive(nearest);
  };

  return <figure className="space-y-1">
    <figcaption className="flex flex-wrap justify-between gap-x-2 text-xs text-muted" title="Today's hazard index at each hourly scoring run. Dashed lines: 4 (elevated) and 7 (high). Gaps mark long breaks in scoring.">
      <span>{spanLabel}{demo && " · Demo data"}</span>
      <span className={`tabular-nums ${unconfirmed ? "" : "text-text"}`}>{runLabel(latest, site.timezone)}{unconfirmed && " ?"}</span>
    </figcaption>
    <div className="relative">
      <svg viewBox="0 0 600 100" preserveAspectRatio="none" role="img" tabIndex={0}
        aria-label={`7-day hazard index history for ${site.name}. Latest ${describe(latest)}. Use left and right arrow keys to explore hourly scores.`}
        aria-describedby={selected ? tooltipId : undefined}
        onPointerMove={pick} onPointerDown={pick}
        onPointerLeave={(event) => { if (document.activeElement !== event.currentTarget) setActive(null); }}
        onFocus={() => setActive(points.length - 1)} onBlur={() => setActive(null)}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          const current = active ?? points.length - 1;
          setActive(event.key === "Home" ? 0 : event.key === "End" ? points.length - 1 : Math.max(0, Math.min(points.length - 1, current + (event.key === "ArrowLeft" ? -1 : 1))));
        }}
        className={`w-full rounded-card focus-visible:outline-2 focus-visible:outline-brand ${compact ? "h-14" : "h-40"}`}>
        <title>{describe(latest)}</title>
        <rect x={LEFT} y={y(10)} width={RIGHT - LEFT} height={y(7) - y(10)} className={unconfirmed ? "fill-border" : "fill-risk-red-bg"} opacity={0.35} />
        <rect x={LEFT} y={y(7)} width={RIGHT - LEFT} height={y(4) - y(7)} className={unconfirmed ? "fill-border" : "fill-risk-amber-bg"} opacity={0.35} />
        <rect x={LEFT} y={y(4)} width={RIGHT - LEFT} height={y(0) - y(4)} className={unconfirmed ? "fill-border" : "fill-risk-green-bg"} opacity={0} />
        {[4, 7].map((threshold) => <line key={threshold} x1={LEFT} x2={RIGHT} y1={y(threshold)} y2={y(threshold)} className="stroke-border-strong" strokeDasharray="4 4" strokeWidth={1} vectorEffect="non-scaling-stroke" />)}
        {historySegments(points).filter((segment) => segment.length > 1).map((segment) => <polygon key={`area-${segment[0].scored_at}`}
          points={`${x(segment[0])},${y(0)} ${segment.map((point) => `${x(point)},${y(point.hazard_index)}`).join(" ")} ${x(segment.at(-1)!)},${y(0)}`} className={unconfirmed ? "fill-muted" : "fill-text"} opacity={0.06} />)}
        {historySegments(points).filter((segment) => segment.length > 1).map((segment) => <polyline key={segment[0].scored_at} points={segment.map((point) => `${x(point)},${y(point.hazard_index)}`).join(" ")} fill="none" className={unconfirmed ? "stroke-muted" : "stroke-brand"} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />)}
        {points.map((point) => <circle key={point.scored_at} cx={x(point)} cy={y(point.hazard_index)} r={0} className={unconfirmed ? "fill-muted" : "fill-brand"}><title>{describe(point)}</title></circle>)}
        <circle cx={x(latest)} cy={y(latest.hazard_index)} r={4.5} className={`${unconfirmed ? "fill-muted" : POINT_COLOR[riskLevel(latest.hazard_index)]} stroke-surface`} strokeWidth={2} vectorEffect="non-scaling-stroke" />
        {selected && <circle cx={x(selected)} cy={y(selected.hazard_index)} r={5} fill="none" className="stroke-text" strokeWidth={2} vectorEffect="non-scaling-stroke" />}
      </svg>
      {selected && <div id={tooltipId} role="tooltip" className="pointer-events-none absolute inset-x-1 inset-be-full z-10 rounded-card border border-border bg-surface px-2 py-1 text-xs text-text">{describe(selected)}</div>}
    </div>
    {!compact && <div className="flex justify-between gap-2 text-xs text-muted"><span>{formatSiteDateTime(points[0].scored_at, site.timezone)}</span><span>{formatSiteDateTime(latest.scored_at, site.timezone)}</span></div>}
    {unconfirmed && <p className="text-xs text-muted">? Last known history · Not confirmed.</p>}
  </figure>;
}
