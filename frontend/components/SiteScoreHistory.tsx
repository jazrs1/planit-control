"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ScoreHistory, Site } from "@shared/types";
import { useAlertsState, useServerNow } from "@/components/AlertsProvider";
import ScoreSparkline from "@/components/ScoreSparkline";
import { DEMO_DATA, getScoreHistory } from "@/lib/api";
import { HISTORY_STALE_MS, historyPoints, latestTomorrow } from "@/lib/scoreHistory";
import { HAZARD_LABEL, liveHazardIndex, riskLevel } from "@/lib/risk";
import { usePolling } from "@/lib/usePolling";
import { useVisibility } from "@/lib/useVisibility";

type HistoryProps = { site: Site; compact?: boolean; lazy?: boolean; unconfirmed?: boolean };

function HistoryForMode({ site, compact = false, lazy = false, unconfirmed = false, demo }: HistoryProps & { demo: boolean }) {
  const { ref, visible } = useVisibility(lazy);
  const { connection, replay } = useAlertsState();
  const serverNow = useServerNow();
  const [history, setHistory] = useState<ScoreHistory | null>(() => demo && DEMO_DATA.scoreHistory.site_id === site.id ? DEMO_DATA.scoreHistory : null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState<number | null>(null);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const poll = useCallback(async () => {
    if (!visible || demo) return;
    try {
      const next = await getScoreHistory(site.id);
      if (next.site_id !== site.id) throw new Error("History belongs to another site");
      if (active.current) { setHistory(next); setFailed(false); }
    } catch { if (active.current) setFailed(true); }
  }, [site.id, visible, demo]);
  usePolling(poll, !visible || demo ? null : replay?.running ? 3_000 : failed || history === null ? 5_000 : 5 * 60_000);
  useEffect(() => {
    if (!visible) return;
    const tick = () => setNow(serverNow());
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, [visible, serverNow]);
  const latest = historyPoints(history).at(-1);
  // Hourly scoring stays live during lightning replay; don't compare its real timestamps to a past replay clock.
  const old = !demo && !replay?.running && latest && now !== null && now - Date.parse(latest.scored_at) > HISTORY_STALE_MS;
  const uncertain = !demo && (unconfirmed || failed || connection.level !== "online" || !!old);

  // Compact (the expanded dashboard row): three small stats, then today's runs. "Now" is the row's own
  // index, so the stats never contradict the row.
  const index = liveHazardIndex(site);
  const tomorrow = latestTomorrow(history);
  const stat = (label: string, value: string, shape?: string) => <div className="grid gap-0.5"><dt className="text-xs text-muted">{label}</dt>
    <dd className="flex items-center gap-1.5 text-xl font-semibold leading-tight tabular-nums">{shape && <span aria-hidden="true" className={`pc-shape pc-shape--${shape} text-[0.7rem]`} />}{value}</dd></div>;
  return <div ref={ref} className={`min-w-0 space-y-2 ${compact ? "min-h-16" : "rounded-card border border-border bg-surface p-4 shadow-card"}`}>
    {compact ? <dl className="grid grid-cols-[auto_auto_1fr] gap-x-6">
      {stat("Now", Number.isFinite(index) ? index.toFixed(1) : "—", Number.isFinite(index) ? riskLevel(index) : undefined)}
      {stat("Tomorrow", tomorrow ? tomorrow.hazard_index.toFixed(1) : "—", tomorrow ? riskLevel(tomorrow.hazard_index) : undefined)}
      <div className="grid min-w-0 gap-0.5"><dt className="text-xs text-muted">Top hazard</dt><dd className="truncate text-sm font-semibold leading-7">{HAZARD_LABEL[site.top_hazard] ?? "—"}</dd></div>
    </dl> : <h2 className="font-semibold text-text">Hazard index history</h2>}
    {demo && <p className="text-xs font-semibold text-muted">Demo data · sample history, not live</p>}
    {history === null && !demo ? <p role="status" className="text-sm text-muted">{failed ? "History unavailable · Not confirmed" : visible ? "Loading history…" : "History loads when this card is visible"}</p>
      : <ScoreSparkline history={history} site={site} compact={compact} unconfirmed={uncertain} demo={demo} />}
    {uncertain && history !== null && <p role="status" className="text-xs font-semibold text-muted">{old ? "Old scoring data · " : ""}? Last known history · Not confirmed</p>}
    {!compact && replay?.running && <p className="text-xs text-muted">Scoring history stays live during lightning replay.</p>}
  </div>;
}

export default function SiteScoreHistory(props: HistoryProps) {
  const demo = useAlertsState().status === "demo";
  // Site and mode changes discard the previous series. Late responses cannot leak across them.
  return <HistoryForMode key={`${props.site.id}:${demo ? "demo" : "live"}`} {...props} demo={demo} />;
}
