import type { ScoreHistory, ScorePoint } from "@shared/types";

export const HISTORY_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const HISTORY_STALE_MS = 3 * 60 * 60_000;
export const HISTORY_GAP_MS = 3 * 60 * 60_000;

/** One series: the hybrid score for "today" at each hourly run, not tomorrow's forecast or model alone.
 * End the seven-day window at the latest run: score history stays on real time during lightning replay. */
/** Fewer hourly runs than this is too little to read a trend from: the chart says so instead. */
export const MIN_HISTORY_POINTS = 6;

export function historyPoints(history: ScoreHistory | null): ScorePoint[] {
  const byTime = new Map<number, ScorePoint>();
  for (const point of history?.points ?? []) {
    const time = Date.parse(point.scored_at);
    if (point.horizon === "today" && Number.isFinite(time) && Number.isFinite(point.hazard_index) && point.hazard_index >= 0 && point.hazard_index <= 10) byTime.set(time, point);
  }
  const points = [...byTime.values()].sort((a, b) => Date.parse(a.scored_at) - Date.parse(b.scored_at));
  const latest = points.at(-1);
  return latest ? points.filter((point) => Date.parse(point.scored_at) >= Date.parse(latest.scored_at) - HISTORY_WINDOW_MS) : [];
}

/** Leave long breaks in hourly scoring blank instead of drawing a line through an outage. */
export function historySegments(points: ScorePoint[]): ScorePoint[][] {
  const segments: ScorePoint[][] = [];
  for (const point of points) {
    const previous = segments.at(-1)?.at(-1);
    if (!previous || Date.parse(point.scored_at) - Date.parse(previous.scored_at) > HISTORY_GAP_MS) segments.push([]);
    segments.at(-1)!.push(point);
  }
  return segments;
}
