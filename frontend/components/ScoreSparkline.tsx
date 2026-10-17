"use client";

import { useId, useState } from "react";
import type { PointerEvent } from "react";
import type { ScoreHistory, ScorePoint, Site } from "@shared/types";
import { riskLevel } from "@/lib/risk";
import { HISTORY_WINDOW_MS, historyPoints, historySegments } from "@/lib/scoreHistory";
import { formatSiteDateTime } from "@/lib/time";

const POINT_COLOR = { green: "fill-risk-green", amber: "fill-risk-amber", red: "fill-risk-red" } as const;
const WIDTH = 600, LEFT = 8, RIGHT = 592, TOP = 8, HEIGHT = 84;
const y = (score: number) => TOP + HEIGHT * (1 - score / 10);

export default function ScoreSparkline({ history, site, compact = false, unconfirmed = false, demo = false }: { history: ScoreHistory | null; site: Site; compact?: boolean; unconfirmed?: boolean; demo?: boolean }) {
  const points = history?.site_id === site.id ? historyPoints(history) : [];
  const latest = points.at(-1);
  const [active, setActive] = useState<number | null>(null);
  const tooltipId = useId();
  if (points.length < 2 || !latest) return <p className="text-sm text-muted">Not enough history yet{demo && " · Demo data"}.<span className="block text-xs">At least two hourly scoring runs are needed.</span></p>;

  const end = Date.parse(latest.scored_at);
  const start = end - HISTORY_WINDOW_MS;
  const x = (point: ScorePoint) => LEFT + (Date.parse(point.scored_at) - start) / HISTORY_WINDOW_MS * (RIGHT - LEFT);
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
    <figcaption className="flex flex-wrap justify-between gap-x-2 text-xs text-muted">
      <span>Today&apos;s score at each hourly run{demo && " · Demo data"}</span>
      <strong className={unconfirmed ? "text-muted" : "text-text"}>Latest {latest.hazard_index.toFixed(1)}{unconfirmed && " ?"}</strong>
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
        className={`w-full rounded-card focus-visible:outline-2 focus-visible:outline-brand ${compact ? "h-20" : "h-40"}`}>
        <title>{describe(latest)}</title>
        <rect x={LEFT} y={y(10)} width={RIGHT - LEFT} height={y(7) - y(10)} className={unconfirmed ? "fill-border" : "fill-risk-red-bg"} opacity={0.5} />
        <rect x={LEFT} y={y(7)} width={RIGHT - LEFT} height={y(4) - y(7)} className={unconfirmed ? "fill-border" : "fill-risk-amber-bg"} opacity={0.5} />
        <rect x={LEFT} y={y(4)} width={RIGHT - LEFT} height={y(0) - y(4)} className={unconfirmed ? "fill-border" : "fill-risk-green-bg"} opacity={0.5} />
        {historySegments(points).filter((segment) => segment.length > 1).map((segment) => <polyline key={segment[0].scored_at} points={segment.map((point) => `${x(point)},${y(point.hazard_index)}`).join(" ")} fill="none" className={unconfirmed ? "stroke-muted" : "stroke-brand"} strokeWidth={2} vectorEffect="non-scaling-stroke" />)}
        {points.map((point) => <circle key={point.scored_at} cx={x(point)} cy={y(point.hazard_index)} r={1.5} className={unconfirmed ? "fill-muted" : "fill-brand"}><title>{describe(point)}</title></circle>)}
        <circle cx={x(latest)} cy={y(latest.hazard_index)} r={4.5} className={`${unconfirmed ? "fill-muted" : POINT_COLOR[riskLevel(latest.hazard_index)]} stroke-surface`} strokeWidth={2} vectorEffect="non-scaling-stroke" />
        {selected && <circle cx={x(selected)} cy={y(selected.hazard_index)} r={5} fill="none" className="stroke-text" strokeWidth={2} vectorEffect="non-scaling-stroke" />}
      </svg>
      {selected && <div id={tooltipId} role="tooltip" className="pointer-events-none absolute inset-x-1 inset-be-full z-10 rounded-card border-2 border-rule bg-surface px-2 py-1 text-xs text-text">{describe(selected)}</div>}
    </div>
    <div className="flex justify-between gap-2 text-xs text-muted"><span>{formatSiteDateTime(new Date(start).toISOString(), site.timezone)}</span><span>{formatSiteDateTime(latest.scored_at, site.timezone)}</span></div>
    <p className="text-xs text-muted">{unconfirmed ? "? Last known history · Not confirmed. " : ""}Green &lt; 4 · amber 4–&lt;7 · red ≥ 7. Gaps mark long breaks in scoring.</p>
  </figure>;
}
