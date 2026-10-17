"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ScoreHistory, Site } from "@shared/types";
import { useAlertsState, useServerNow } from "@/components/AlertsProvider";
import ScoreSparkline from "@/components/ScoreSparkline";
import { DEMO_DATA, getScoreHistory } from "@/lib/api";
import { HISTORY_STALE_MS, historyPoints } from "@/lib/scoreHistory";
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

  return <div ref={ref} className={`min-w-0 space-y-2 ${compact ? "min-h-16" : "rounded-card border border-border bg-surface p-4 shadow-card"}`}>
    {compact ? <p className="text-xs font-semibold text-muted">7-day hazard index</p> : <h2 className="font-semibold text-text">7-day hazard index</h2>}
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
