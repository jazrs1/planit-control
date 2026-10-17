"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Alert, FloodStatus, OshaHeatRisk, SiteDetail, SoilLevel } from "@shared/types";
import { useAlertsState, useServerNow } from "@/components/AlertsProvider";
import { NoticeCard, ReplayLine, StopWorkCard } from "@/components/AlertCards";
import BriefingCard from "@/components/BriefingCard";
import HazardPanel from "@/components/HazardPanel";
import LightningApproachChip from "@/components/LightningApproachChip";
import SiteScoreHistory from "@/components/SiteScoreHistory";
import StopWorkCountdown from "@/components/StopWorkCountdown";
import { formatMiles, formatStrikeDistance } from "@/lib/alerts";
import { ApiRequestError, DEMO_DATA, getSiteDetail, sendBriefingNow } from "@/lib/api";
import { loadBriefing } from "@/lib/loadBriefings";
import type { BriefingResult } from "@/lib/loadBriefings";
import { HAZARD_LABEL, factorHazardLabel, riskLevel } from "@/lib/risk";
import { formatPageTime, zoneLabel } from "@/lib/siteTime";
import { formatAgo } from "@/lib/time";
import { usePolling } from "@/lib/usePolling";

// Refresh cadence: same as the dashboard's sites (the lightning card changes fast during replay).
const REPLAY_MS = 3_000;
const LIVE_MS = 30_000;
const RETRY_MS = 5_000;
/** Briefings change once a day (6 PM site time) or when regenerated. */
const BRIEFING_MS = 5 * 60_000;

/** A polled reading older than this is flagged as old: about 3 missed polls of its source
 *  (weather 60 min, FIRMS 30 min, iNaturalist 6 h; see backend/hazards/scheduler.py). */
const STALE_AFTER_MIN = { weather: 180, wildfire: 90, wildlife: 18 * 60 } as const;

const RISK_STYLES = {
  green: { text: "text-risk-green", shape: "pc-shape--green", label: "Low" },
  amber: { text: "text-risk-amber", shape: "pc-shape--amber", label: "Elevated" },
  red: { text: "text-risk-red", shape: "pc-shape--red", label: "High" },
} as const;

const OSHA_LABEL: Record<OshaHeatRisk, string> = { lower: "Lower", moderate: "Moderate", high: "High", very_high: "Very high" };
const FLOOD_LABEL: Record<FloodStatus, string> = { none: "None", advisory: "Advisory", watch: "Watch", warning: "Warning" };
const SOIL_LABEL: Record<SoilLevel, string> = { dry: "Dry", moist: "Moist", saturated: "Saturated" };

const fmt = (v: number | null | undefined, unit: string, digits = 0) => (v == null ? null : `${v.toFixed(digits)}${unit}`);
const yesNo = (v: boolean | null | undefined) => (v == null ? null : v ? "Yes" : "No");
const count = (v: number | null | undefined) => (v == null ? null : String(v));

/** A panel on this page: white, small radius, soft shadow. */
const PANEL = "pc-panel flex flex-col gap-4 p-6 max-sm:p-5";

function timeOfDay(date: Date) {
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** The FEMA zone once, with what it means: "X, not high-risk", "AE, high-risk floodplain". */
function femaZone(zone: string | null | undefined, highRisk: boolean | null | undefined) {
  if (zone == null) return null;
  if (zone === "unmapped") return "Not mapped";
  return highRisk == null ? zone : `${zone}, ${highRisk ? "high-risk floodplain" : "not high-risk"}`;
}

function IndexStat({ label, value, uncertain, unknown }: { label: string; value: number; uncertain: boolean; unknown: boolean }) {
  const risk = RISK_STYLES[riskLevel(value)];
  // No card has live data (e.g. the backend has no database): the index is a placeholder.
  const aria = unknown ? `${label}: hazard index unknown, no live data` : `${label}: hazard index ${value} of 10, ${risk.label} risk${uncertain ? ", last known" : ""}`;
  return (
    <div className="flex flex-col" aria-label={aria}>
      <span aria-hidden="true" className="text-xs text-muted">{label}</span>
      <span aria-hidden="true" className={`text-[2rem] font-semibold leading-tight tracking-[-0.01em] ${unknown || uncertain ? "text-muted" : ""}`}>
        {unknown ? "—" : `${value.toFixed(1)}${uncertain ? "?" : ""}`}
      </span>
      <span aria-hidden="true" className={`flex items-center gap-1.5 text-xs font-semibold ${unknown || uncertain ? "text-muted" : risk.text}`}>
        <span className={`pc-shape ${unknown || uncertain ? "pc-shape--unknown" : risk.shape}`} />
        {unknown ? "No data" : uncertain ? "Last known" : risk.label}
      </span>
    </div>
  );
}

export default function SiteDetailView({ siteId, initialDetail }: { siteId: string; initialDetail: SiteDetail | null }) {
  // Live detail only; null until it loads. Mocks appear only in demo mode, and labeled.
  const [liveDetail, setLiveDetail] = useState(initialDetail);
  const [failed, setFailed] = useState(initialDetail === null);
  const [missing, setMissing] = useState(false);
  const [staleSince, setStaleSince] = useState<Date | null>(null);
  const lastGood = useRef(new Date());
  const { alerts, status: alertsStatus, replay, setDemo, refresh: refreshAlerts, connection } = useAlertsState();
  const serverNow = useServerNow();

  const demo = alertsStatus === "demo";
  const detail = demo ? DEMO_DATA.siteDetails[siteId] ?? null : liveDetail;
  // Greyed "last known" as soon as any request fails (shared connection), not only after this page's poll.
  const connectionLost = !demo && liveDetail !== null && (staleSince !== null || connection.level !== "online");
  const lostSince = staleSince ?? (connection.lastSuccessAt !== null ? new Date(connection.lastSuccessAt) : new Date());

  const poll = useCallback(async () => {
    try {
      const next = await getSiteDetail(siteId);
      setLiveDetail(next);
      setFailed(false);
      setMissing(false);
      setStaleSince(null);
      lastGood.current = new Date();
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 404) setMissing(true);
      // Keep the last real detail, if any, and mark it as last known.
      setFailed(true);
      setStaleSince((prev) => prev ?? lastGood.current);
    }
  }, [siteId]);
  usePolling(poll, demo || missing ? null : replay?.running ? REPLAY_MS : liveDetail === null ? RETRY_MS : LIVE_MS);

  // Tomorrow's briefing: undefined until the first try; a failed refresh keeps the last one, marked stale.
  const [liveBriefing, setLiveBriefing] = useState<BriefingResult | undefined>(undefined);
  const [briefingStale, setBriefingStale] = useState(false);
  const pollBriefing = useCallback(async () => {
    const result = await loadBriefing(siteId);
    if (result === "error") {
      setBriefingStale(true);
      setLiveBriefing((prev) => (prev === undefined ? "error" : prev));
    } else {
      setLiveBriefing(result);
      setBriefingStale(false);
    }
  }, [siteId]);
  usePolling(pollBriefing, demo || missing ? null : liveBriefing === undefined || liveBriefing === "error" ? RETRY_MS : BRIEFING_MS);
  const regenerateBriefing = useCallback(async () => {
    const fresh = (await sendBriefingNow({ site_id: siteId })).generated[0];
    if (!fresh) throw new Error("The server didn't return a briefing.");
    setLiveBriefing(fresh);
    setBriefingStale(false);
  }, [siteId]);
  const briefing = demo ? DEMO_DATA.briefings[siteId] ?? null : liveBriefing;

  // Reading ages. Hazard pollers run on real time even during replay, so use the real clock;
  // demo data is a fixed sample, so use the demo clock there.
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNowMs(demo ? serverNow() : Date.now());
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, [demo, serverNow]);

  const backLink = (
    <Link href="/" className="inline-flex min-h-11 items-center self-start text-xs text-muted hover:text-text focus-visible:outline-2 focus-visible:outline-notice">
      ← Dashboard
    </Link>
  );

  if (detail === null) {
    return (
      <main className="mx-auto flex max-w-5xl flex-col gap-6 px-4 pbs-8 pbe-12 sm:px-6">
        {backLink}
        <section role="status" className="flex flex-col items-center gap-4 p-8 text-center">
          {demo ? (
            <>
              <h1 className="text-xl font-semibold">No demo data for this site</h1>
              <p className="text-muted">Demo data covers only the six sample sites.</p>
              <button type="button" onClick={() => setDemo(false)} className="pc-btn pc-btn--quiet">Exit demo</button>
            </>
          ) : missing ? (
            <h1 className="text-xl font-semibold">Site not found</h1>
          ) : failed ? (
            <>
              <h1 className="text-xl font-semibold text-risk-red">Can&apos;t reach the server</h1>
              <p className="max-w-md text-muted">This site&apos;s conditions and stop-work status are unknown. Don&apos;t treat it as clear. Retrying every 5 seconds.</p>
              <div className="flex flex-wrap items-center justify-center gap-6">
                <button type="button" onClick={() => { void poll(); void refreshAlerts(); }} className="pc-btn pc-btn--primary">Retry now</button>
                {siteId in DEMO_DATA.siteDetails && (
                  <button type="button" onClick={() => setDemo(true)} className="pc-link">Show demo data</button>
                )}
              </div>
            </>
          ) : (
            <p className="text-muted">Connecting…</p>
          )}
        </section>
      </main>
    );
  }

  const tz = detail.timezone;
  const c = detail.conditions;
  const siteAlerts = (alerts ?? []).filter((a) => a.site_id === detail.id);
  // Real alerts lead; replay ones are a secondary tag after them and never hide a real advisory.
  const realAlerts = siteAlerts.filter((a) => !a.replay);
  const replayAlerts = siteAlerts.filter((a) => a.replay);
  const realStops = realAlerts.filter((a) => a.type === "lightning");
  const realOthers = realAlerts.filter((a) => a.type !== "lightning");
  const approach = detail.lightning_approach;
  // An advisory is hidden only by a stop-work of its own kind (real by real, replay by replay).
  const approachStopWork = siteAlerts.some((a) => a.type === "lightning" && !!a.replay === !!approach?.replay);
  const alertsLastKnown = alertsStatus === "stale";
  // No card has a status: everything is placeholder, so the index is too.
  const noLiveData = [c.lightning, c.heat, c.flood, c.soil, c.wildfire, c.wildlife_summary].every((card) => !card?.hazard_status);
  const nws = detail.nws_alerts;
  const factors = [...detail.top_factors].sort((a, b) => b.weight - a.weight);
  const replayNowMs = replay?.running || demo ? serverNow() : nowMs;
  const peakHour = c.heat.peak_at ? new Date(c.heat.peak_at).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric" }) : null;
  // "FEMA zone X" as a source only repeats the zone row.
  const floodSource = c.flood.source && !/^FEMA\b/i.test(c.flood.source) ? c.flood.source : null;

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 px-4 pbs-8 pbe-12 sm:px-6">
      <div className="flex flex-col gap-2">
        {backLink}
        {demo && (
          <p role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted">
            <span className="pc-chip pc-chip--unknown">Demo data</span>
            Sample conditions from shared/mocks, not live.
            <button type="button" onClick={() => setDemo(false)} className="pc-link">Exit demo</button>
          </p>
        )}
        {connectionLost && (
          <p role="status" className="rounded-card bg-risk-red-bg px-4 py-3 font-semibold text-risk-red">
            Connection lost. Showing last known conditions from {timeOfDay(lostSince)}; ? means it may be out of date.
          </p>
        )}
      </div>

      <header className="flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="text-[2rem] font-semibold leading-tight tracking-[-0.015em] text-balance">{detail.name}</h1>
          <p className="text-xs text-muted">
            {detail.county} County{" · "}Times in {zoneLabel(tz)}{" · "}
            <span className="whitespace-nowrap">Updated {formatPageTime(detail.updated_at, tz, nowMs)}{nowMs !== null && `, ${formatAgo(Math.max(0, nowMs - Date.parse(detail.updated_at)))}`}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-start gap-x-10 gap-y-4" title="Hazard index 0–10: weather model + safety rules">
          <IndexStat label="Today" value={detail.hazard_index_today} uncertain={connectionLost} unknown={noLiveData} />
          <IndexStat label="Tomorrow" value={detail.hazard_index_tomorrow} uncertain={connectionLost} unknown={noLiveData} />
          <div className="flex flex-col">
            <span className="text-xs text-muted">Top hazard</span>
            <span className={`text-xl font-semibold leading-[2.5rem] ${connectionLost ? "text-muted" : ""}`}>{HAZARD_LABEL[detail.top_hazard]}</span>
            <span className="text-xs text-muted">Hazard index, 0–10</span>
          </div>
        </div>
      </header>

      {/* Order: real stop-work, real advisory, real flood risk, then unknown; replay tags last. */}
      {alerts === null ? (
        <p role="status" className="rounded-card border-2 border-dashed border-muted px-6 py-4 font-semibold text-muted">
          Alert status unknown: not connected to the server. Don&apos;t treat this site as clear.
        </p>
      ) : realStops.map((alert) => <StopWorkCard key={alert.id} alert={alert} lastKnown={alertsLastKnown} />)}
      {approach && !approach.replay && <LightningApproachChip approach={approach} stopWork={approachStopWork} unconfirmed={connectionLost || alerts === null || alertsLastKnown} nowMs={nowMs === null ? null : !replay?.running ? serverNow() : Date.now()} demo={demo} />}
      {alerts !== null && realOthers.map((alert) => <NoticeCard key={alert.id} alert={alert} lastKnown={alertsLastKnown} started={formatPageTime(alert.started_at, tz, nowMs)}>
        {alert.type === "flood" && (alert.all_clear_at
          ? `NWS flood warning in effect until ${formatPageTime(alert.all_clear_at, tz, nowMs)}.`
          : "Heavy rain on flood-prone ground. Clears when conditions improve.")}
      </NoticeCard>)}
      {(replayAlerts.length > 0 || approach?.replay) && (
        <div className="flex flex-col gap-2">
          {replayAlerts.map((alert) => <ReplayLine key={alert.id} alert={alert} timeZone={tz} replayNowMs={replayNowMs} />)}
          {approach?.replay && <LightningApproachChip approach={approach} stopWork={approachStopWork} unconfirmed={connectionLost || alerts === null || alertsLastKnown} nowMs={nowMs === null ? null : serverNow()} demo={demo} />}
        </div>
      )}

      <SiteScoreHistory site={detail} unconfirmed={connectionLost} />

      <section aria-labelledby="nws-heading" className={PANEL}>
        <h2 id="nws-heading" className="text-xs text-muted">National Weather Service</h2>
        {nws == null ? (
          <p className="text-muted">NWS alerts unavailable for this site.</p>
        ) : nws.length === 0 ? (
          <p className="text-muted">No active NWS alerts{connectionLost ? " (last known)" : ""}.</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {nws.map((a, i) => (
              <li key={`${a.event}-${i}`} className="flex flex-col">
                <p className="font-semibold">{a.event}</p>
                <p className="text-xs text-muted">
                  {a.severity && <>{a.severity}{" · "}</>}
                  {a.ends_at ? `Until ${formatPageTime(a.ends_at, tz, nowMs)}` : "End time not given"}
                </p>
                {/* The headline mostly repeats the event and times: kept, behind Details. */}
                {a.headline && (
                  <details className="group">
                    <summary className="pc-link list-none text-xs"><span className="group-open:hidden">Details</span><span className="hidden group-open:inline">Hide details</span></summary>
                    <p className="max-w-[68ch] text-muted">{a.headline}</p>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Hazard conditions" className="grid items-start gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <HazardPanel
          title="Lightning" card={c.lightning} freshness={{ kind: "live" }} timeZone={tz} nowMs={nowMs} connectionLost={connectionLost}
          value={c.lightning.nearest_strike_mi === null ? "None" : formatStrikeDistance(c.lightning.nearest_strike_mi)}
          caption={c.lightning.nearest_strike_mi === null ? "Nearest strike, last 30 min" : `Nearest strike${c.lightning.nearest_strike_at ? `, ${formatPageTime(c.lightning.nearest_strike_at, tz, nowMs)}` : ""}`}
          rows={[
            { label: "Strikes, last 30 min", value: String(c.lightning.strikes_last_30_min) },
          ]}
        />
        <HazardPanel
          title="Heat" card={c.heat} freshness={{ kind: "polled", staleAfterMin: STALE_AFTER_MIN.weather }} timeZone={tz} nowMs={nowMs} connectionLost={connectionLost}
          value={fmt(c.heat.heat_index_f, "°F")} caption="Heat index now"
          rows={[
            { label: "Today's peak", value: c.heat.peak_heat_index_f == null ? null : `${fmt(c.heat.peak_heat_index_f, "°F")}${c.heat.peak_at ? ` at ${formatPageTime(c.heat.peak_at, tz, nowMs)}` : ""}` },
            // The card's status is for the rest of today; the OSHA band is for today's peak, so say so.
            { label: `OSHA risk at today's peak${peakHour ? ` (${peakHour})` : ""}`, value: c.heat.risk_band ? OSHA_LABEL[c.heat.risk_band] : null },
            { label: "Air temperature", value: fmt(c.heat.air_temp_f, "°F") },
            { label: "Humidity", value: fmt(c.heat.humidity_pct, "%") },
          ]}
        />
        <HazardPanel
          title="Flooding" card={c.flood} freshness={{ kind: "polled", staleAfterMin: STALE_AFTER_MIN.weather }} timeZone={tz} nowMs={nowMs} connectionLost={connectionLost}
          value={fmt(c.flood.rain_next_24h_in, " in", 1)} caption="Rain expected, next 24 h"
          rows={[
            { label: "Rain, past 12 h", value: fmt(c.flood.rain_past_12h_in, " in", 1) },
            { label: "Rain, past 24 h", value: fmt(c.flood.rain_past_24h_in, " in", 1) },
            { label: "Rain, past 72 h", value: fmt(c.flood.rain_past_72h_in, " in", 1) },
            { label: "NWS flood level", value: FLOOD_LABEL[c.flood.status] },
            ...(floodSource ? [{ label: "Source", value: floodSource }] : []),
            { label: "FEMA flood zone", value: femaZone(c.flood.fema_flood_zone, c.flood.in_special_flood_hazard_area) },
            { label: "River within 1 mi", value: yesNo(c.flood.near_river) },
          ]}
        />
        <HazardPanel
          title="Soil saturation" card={c.soil} freshness={{ kind: "polled", staleAfterMin: STALE_AFTER_MIN.weather }} timeZone={tz} nowMs={nowMs} connectionLost={connectionLost}
          value={fmt(c.soil.moisture_pct, "%")} caption={`Soil moisture${c.soil.level ? `, ${SOIL_LABEL[c.soil.level].toLowerCase()}` : ""}`}
          rows={[]}
        />
        <HazardPanel
          title="Wildfire" card={c.wildfire} freshness={{ kind: "polled", staleAfterMin: STALE_AFTER_MIN.wildfire }} timeZone={tz} nowMs={nowMs} connectionLost={connectionLost}
          value={count(c.wildfire.detections_25mi)} caption="Fires within 25 mi, last 24 h"
          rows={[
            { label: "Nearest fire", value: c.wildfire.nearest_detection_mi === null ? "None detected" : formatMiles(c.wildfire.nearest_detection_mi) },
            { label: "Detected", value: formatPageTime(c.wildfire.detected_at, tz, nowMs) },
            { label: "Confidence", value: c.wildfire.confidence },
            { label: "Red flag warning", value: yesNo(c.wildfire.red_flag_warning) },
          ]}
        />
        <HazardPanel
          title="Wildlife" card={c.wildlife_summary} freshness={{ kind: "polled", staleAfterMin: STALE_AFTER_MIN.wildlife }} timeZone={tz} nowMs={nowMs} connectionLost={connectionLost}
          value={count(c.wildlife_summary?.observations_30d)} caption="Alligator and snake sightings, 30 days"
          rows={c.wildlife_summary ? [
            { label: "Venomous (30 d)", value: String(c.wildlife_summary.venomous_30d) },
            { label: "Crew reports within 2 mi", value: String(c.wildlife_summary.crew_reports_2mi) },
          ] : []}
        >
          {c.wildlife.length > 0 && (
            <ul className="flex flex-col gap-2">
              {c.wildlife.slice(0, 8).map((s, i) => (
                <li key={`${s.species}-${s.seen_at}-${i}`} className="flex flex-wrap justify-between gap-x-4">
                  <span className="min-w-0 font-semibold">{s.species}</span>
                  <span className="ms-auto text-muted tabular-nums">{formatMiles(s.distance_mi) ?? "Distance unknown"}{" · "}{formatPageTime(s.seen_at, tz, nowMs)}</span>
                </li>
              ))}
            </ul>
          )}
        </HazardPanel>
      </section>

      <div id="site-briefing" className="scroll-mt-4" />
      <BriefingCard
        siteId={detail.id}
        siteName={detail.name}
        timeZone={tz}
        entry={briefing === undefined ? { kind: "loading" } : briefing === "error" ? { kind: "unknown" } : briefing === null ? { kind: "none" } : { kind: "briefing", briefing }}
        nowMs={nowMs}
        connectionLost={!demo && (briefingStale || connectionLost) && briefing !== "error"}
        onRegenerate={demo ? undefined : regenerateBriefing}
      />

      <section aria-labelledby="factors-heading" className={PANEL}>
        <h2 id="factors-heading" className="text-xs text-muted">What drives today&apos;s index</h2>
        {factors.length === 0 ? (
          <p className="text-muted">No contributing factors.</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {factors.map((f) => (
              <li key={`${f.hazard}-${f.label}`} className="flex flex-col gap-1.5">
                <div className="flex justify-between gap-4">
                  <span><span className="font-semibold">{factorHazardLabel(f.hazard)}</span>{" · "}{f.label}</span>
                  <span className="shrink-0 tabular-nums text-muted">{Math.round(f.weight * 100)}%</span>
                </div>
                <div className="h-1 overflow-clip rounded-pill bg-surface-2" aria-hidden="true">
                  <div className={`h-1 rounded-pill ${connectionLost ? "bg-border-strong" : "bg-text/70"}`} style={{ width: `${Math.min(100, Math.max(0, f.weight * 100))}%` }} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
