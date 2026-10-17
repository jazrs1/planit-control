"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Alert, FloodStatus, OshaHeatRisk, SiteDetail, SoilLevel } from "@shared/types";
import { useAlertsState, useServerNow } from "@/components/AlertsProvider";
import BriefingCard from "@/components/BriefingCard";
import HazardPanel from "@/components/HazardPanel";
import StopWorkCountdown from "@/components/StopWorkCountdown";
import { ApiRequestError, DEMO_DATA, getSiteDetail, sendBriefingNow } from "@/lib/api";
import { loadBriefing } from "@/lib/loadBriefings";
import type { BriefingResult } from "@/lib/loadBriefings";
import { HAZARD_LABEL, riskLevel } from "@/lib/risk";
import { formatAgo, formatSiteDateTime, formatSiteTime, timeZoneAbbr } from "@/lib/time";
import { usePolling } from "@/lib/usePolling";

// Refresh cadence: same as the dashboard's sites (the lightning card changes fast during replay).
const REPLAY_MS = 3_000;
const LIVE_MS = 30_000;
const RETRY_MS = 5_000;
/** Briefings change once a day (6 PM site time) or when regenerated. */
const BRIEFING_MS = 5 * 60_000;

/** A polled reading older than this is flagged as old: about 3 missed polls of its source
 *  (weather 15 min, FIRMS 30 min, iNaturalist 6 h; see backend/hazards/scheduler.py). */
const STALE_AFTER_MIN = { weather: 45, wildfire: 90, wildlife: 18 * 60 } as const;

const RISK_STYLES = {
  green: { badge: "bg-risk-green-bg text-risk-green", label: "Low" },
  amber: { badge: "bg-risk-amber-bg text-risk-amber", label: "Elevated" },
  red: { badge: "bg-risk-red-bg text-risk-red", label: "High" },
} as const;

const OSHA_LABEL: Record<OshaHeatRisk, string> = { lower: "Lower", moderate: "Moderate", high: "High", very_high: "Very high" };
const FLOOD_LABEL: Record<FloodStatus, string> = { none: "None", advisory: "Advisory", watch: "Watch", warning: "Warning" };
const SOIL_LABEL: Record<SoilLevel, string> = { dry: "Dry", moist: "Moist", saturated: "Saturated" };

const fmt = (v: number | null | undefined, unit: string, digits = 0) => (v == null ? null : `${v.toFixed(digits)}${unit}`);
const yesNo = (v: boolean | null | undefined) => (v == null ? null : v ? "Yes" : "No");

function timeOfDay(date: Date) {
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function IndexBadge({ label, value, uncertain }: { label: string; value: number; uncertain: boolean }) {
  const risk = RISK_STYLES[riskLevel(value)];
  return (
    <div
      className={`flex min-w-24 flex-col items-center rounded-card px-3 py-1 ${uncertain ? "bg-bg text-muted" : risk.badge}`}
      aria-label={`${label}: hazard index ${value} of 10, ${risk.label} risk${uncertain ? ", last known" : ""}`}
    >
      <span className="text-xs font-medium">{label}</span>
      <span className="font-mono text-2xl font-bold leading-tight">{value.toFixed(1)}{uncertain && "?"}</span>
      <span className="text-xs font-medium uppercase tracking-wide">{risk.label}</span>
    </div>
  );
}

/** This site's active alerts from the shared alerts state (same source as the nav badge). */
function SiteAlerts({ alerts, timeZone, alertsUnknown }: { alerts: Alert[]; timeZone: string; alertsUnknown: boolean }) {
  if (alertsUnknown) {
    return (
      <p role="status" className="rounded-card border border-dashed border-border bg-surface p-3 text-sm font-semibold text-muted">
        Alert status unknown · not connected to the server. Don&apos;t treat this site as clear.
      </p>
    );
  }
  return (
    <>
      {alerts.map((alert) =>
        alert.type === "lightning" ? (
          <article key={alert.id} className="flex flex-col gap-3 rounded-card border border-risk-red bg-risk-red p-4 text-surface shadow-card sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-lg font-bold">⚡ STOP WORK: lightning</p>
              <p className="text-sm">
                {alert.last_strike_distance_mi === null ? "Lightning within 10 mi." : `Last strike ${alert.last_strike_distance_mi} mi away.`}
                {" "}Each new strike restarts the 30-minute wait.
              </p>
            </div>
            <div className="shrink-0 sm:min-w-56"><StopWorkCountdown all_clear_at={alert.all_clear_at} /></div>
          </article>
        ) : alert.type === "flood" ? (
          <article key={alert.id} className="rounded-card border border-risk-amber bg-risk-amber-bg p-4 text-risk-amber shadow-card">
            <p className="text-lg font-bold">FLOOD RISK</p>
            <p className="text-sm">
              {alert.all_clear_at
                ? `NWS flood warning in effect until ${formatSiteDateTime(alert.all_clear_at, timeZone)}.`
                : "Heavy rain on flood-prone ground. Clears when conditions improve."}
              {" "}Started {formatSiteDateTime(alert.started_at, timeZone)}.
            </p>
          </article>
        ) : (
          <article key={alert.id} className="rounded-card border border-risk-red bg-risk-red-bg p-4 text-risk-red shadow-card">
            <p className="text-lg font-bold">{HAZARD_LABEL[alert.type].toUpperCase()} ALERT</p>
            <p className="text-sm">Started {formatSiteDateTime(alert.started_at, timeZone)}.</p>
          </article>
        ),
      )}
    </>
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
    <Link href="/" className="inline-flex min-h-11 items-center text-sm font-medium text-brand focus-visible:outline-2 focus-visible:outline-brand">
      ← Dashboard
    </Link>
  );

  if (detail === null) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-6">
        {backLink}
        <section role="status" className="mt-6 flex flex-col items-center gap-3 p-8 text-center">
          {demo ? (
            <>
              <h1 className="text-lg font-semibold">No demo data for this site</h1>
              <p className="text-sm text-muted">Demo data covers only the six sample sites.</p>
              <button type="button" onClick={() => setDemo(false)} className="min-h-11 rounded-card border border-border bg-surface px-4 font-semibold text-brand focus-visible:outline-2 focus-visible:outline-brand">Exit demo</button>
            </>
          ) : missing ? (
            <h1 className="text-lg font-semibold">Site not found</h1>
          ) : failed ? (
            <>
              <h1 className="text-lg font-semibold text-risk-red">Can&apos;t reach the server</h1>
              <p className="max-w-md text-sm text-muted">This site&apos;s conditions and stop-work status are unknown. Don&apos;t treat it as clear. Retrying every 5 seconds.</p>
              <div className="flex flex-wrap justify-center gap-2">
                <button type="button" onClick={() => { void poll(); void refreshAlerts(); }} className="min-h-11 rounded-card bg-brand px-4 font-semibold text-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">Retry now</button>
                {siteId in DEMO_DATA.siteDetails && (
                  <button type="button" onClick={() => setDemo(true)} className="min-h-11 rounded-card border border-border bg-surface px-4 font-semibold text-text focus-visible:outline-2 focus-visible:outline-brand">Show demo data</button>
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
  const nws = detail.nws_alerts;

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-5 px-4 py-6">
      <div>
        {backLink}
        {demo && (
          <p role="status" className="mt-2 flex flex-wrap items-center gap-2 rounded-card border border-border bg-surface p-3 text-sm font-semibold text-muted">
            <span className="rounded-pill border border-border px-2 py-0.5 text-xs">Demo data</span>
            Sample conditions from shared/mocks · not live
            <button type="button" onClick={() => setDemo(false)} className="min-h-11 px-2 text-brand underline focus-visible:outline-2 focus-visible:outline-brand">Exit demo</button>
          </p>
        )}
        {connectionLost && (
          <p role="status" className="mt-2 rounded-card border border-risk-red bg-risk-red-bg p-3 text-sm font-semibold text-risk-red">
            Connection lost · showing last known conditions from {timeOfDay(lostSince)} · ? = may be out of date
          </p>
        )}
      </div>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-text">{detail.name}</h1>
          <p className="text-sm text-muted">
            {detail.county} County · {timeZoneAbbr(tz)} · Updated {formatSiteDateTime(detail.updated_at, tz)}
            {nowMs !== null && ` (${formatAgo(Math.max(0, nowMs - Date.parse(detail.updated_at)))})`}
          </p>
          <p className="mt-1 text-sm">
            <span className="text-muted">Top hazard: </span>
            <span className="font-medium">{HAZARD_LABEL[detail.top_hazard]}</span>
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex gap-2">
            <IndexBadge label="Today" value={detail.hazard_index_today} uncertain={connectionLost} />
            <IndexBadge label="Tomorrow" value={detail.hazard_index_tomorrow} uncertain={connectionLost} />
          </div>
          <p className="text-xs text-muted">Hazard index 0–10 · interim rule-based score</p>
        </div>
      </header>

      <SiteAlerts alerts={siteAlerts} timeZone={tz} alertsUnknown={alerts === null} />

      <section aria-labelledby="nws-heading" className="rounded-card border border-border bg-surface p-4 shadow-card">
        <h2 id="nws-heading" className="text-base font-semibold">National Weather Service alerts</h2>
        {nws == null ? (
          <p className="mt-2 text-sm text-muted">NWS alerts unavailable for this site.</p>
        ) : nws.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No active NWS alerts{connectionLost ? " (last known)" : ""}.</p>
        ) : (
          <ul className="mt-2 divide-y divide-border">
            {nws.map((a, i) => (
              <li key={`${a.event}-${i}`} className="py-2 text-sm">
                <p className="font-semibold">
                  {a.event}
                  {a.severity && <span className="ml-2 rounded-pill bg-bg px-2 py-0.5 text-xs font-medium text-muted">{a.severity}</span>}
                </p>
                {a.headline && <p className="text-muted">{a.headline}</p>}
                <p className="text-xs text-muted">{a.ends_at ? `Until ${formatSiteDateTime(a.ends_at, tz)}` : "End time not given"}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Hazard conditions" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <HazardPanel
          title="Lightning" card={c.lightning} freshness={{ kind: "live" }} timeZone={tz} nowMs={nowMs} connectionLost={connectionLost}
          rows={[
            { label: "Nearest strike", value: c.lightning.nearest_strike_mi === null ? "None in 30 min" : `${c.lightning.nearest_strike_mi} mi` },
            { label: "Strike time", value: c.lightning.nearest_strike_at && formatSiteTime(c.lightning.nearest_strike_at, tz) },
            { label: "Strikes, last 30 min", value: String(c.lightning.strikes_last_30_min) },
          ]}
        />
        <HazardPanel
          title="Heat" card={c.heat} freshness={{ kind: "polled", staleAfterMin: STALE_AFTER_MIN.weather }} timeZone={tz} nowMs={nowMs} connectionLost={connectionLost}
          rows={[
            { label: "Heat index now", value: fmt(c.heat.heat_index_f, "°F") },
            { label: "Today's peak", value: c.heat.peak_heat_index_f == null ? null : `${fmt(c.heat.peak_heat_index_f, "°F")}${c.heat.peak_at ? ` at ${formatSiteTime(c.heat.peak_at, tz)}` : ""}` },
            { label: "OSHA risk", value: c.heat.risk_band ? OSHA_LABEL[c.heat.risk_band] : null },
            { label: "Air temperature", value: fmt(c.heat.air_temp_f, "°F") },
            { label: "Humidity", value: fmt(c.heat.humidity_pct, "%") },
          ]}
        />
        <HazardPanel
          title="Flooding" card={c.flood} freshness={{ kind: "polled", staleAfterMin: STALE_AFTER_MIN.weather }} timeZone={tz} nowMs={nowMs} connectionLost={connectionLost}
          rows={[
            { label: "NWS level", value: FLOOD_LABEL[c.flood.status] },
            { label: "Source", value: c.flood.source },
            { label: "Rain, past 12 h", value: fmt(c.flood.rain_past_12h_in, " in", 1) },
            { label: "Rain, past 24 h", value: fmt(c.flood.rain_past_24h_in, " in", 1) },
            { label: "Rain, past 72 h", value: fmt(c.flood.rain_past_72h_in, " in", 1) },
            { label: "Rain, next 24 h", value: fmt(c.flood.rain_next_24h_in, " in", 1) },
            { label: "FEMA flood zone", value: c.flood.fema_flood_zone == null ? null : c.flood.fema_flood_zone === "unmapped" ? "Not mapped" : c.flood.fema_flood_zone },
            { label: "High-risk floodplain", value: yesNo(c.flood.in_special_flood_hazard_area) },
            { label: "River within 1 mi", value: yesNo(c.flood.near_river) },
          ]}
        />
        <HazardPanel
          title="Soil saturation" card={c.soil} freshness={{ kind: "polled", staleAfterMin: STALE_AFTER_MIN.weather }} timeZone={tz} nowMs={nowMs} connectionLost={connectionLost}
          rows={[
            { label: "Soil moisture", value: fmt(c.soil.moisture_pct, "%") },
            { label: "Ground", value: c.soil.level ? SOIL_LABEL[c.soil.level] : null },
          ]}
        />
        <HazardPanel
          title="Wildfire" card={c.wildfire} freshness={{ kind: "polled", staleAfterMin: STALE_AFTER_MIN.wildfire }} timeZone={tz} nowMs={nowMs} connectionLost={connectionLost}
          rows={[
            { label: "Nearest fire", value: c.wildfire.nearest_detection_mi === null ? "None detected" : `${c.wildfire.nearest_detection_mi} mi` },
            { label: "Detected", value: c.wildfire.detected_at && formatSiteDateTime(c.wildfire.detected_at, tz) },
            { label: "Confidence", value: c.wildfire.confidence },
            { label: "Fires within 25 mi (24 h)", value: c.wildfire.detections_25mi == null ? null : String(c.wildfire.detections_25mi) },
            { label: "Red flag warning", value: yesNo(c.wildfire.red_flag_warning) },
          ]}
        />
        <HazardPanel
          title="Wildlife" card={c.wildlife_summary} freshness={{ kind: "polled", staleAfterMin: STALE_AFTER_MIN.wildlife }} timeZone={tz} nowMs={nowMs} connectionLost={connectionLost}
          rows={c.wildlife_summary ? [
            { label: "Alligator & snake sightings (30 d)", value: String(c.wildlife_summary.observations_30d) },
            { label: "Venomous (30 d)", value: String(c.wildlife_summary.venomous_30d) },
            { label: "Crew reports within 2 mi", value: String(c.wildlife_summary.crew_reports_2mi) },
          ] : []}
        >
          {c.wildlife.length > 0 && (
            <ul className="divide-y divide-border border-t border-border text-sm">
              {c.wildlife.slice(0, 8).map((s, i) => (
                <li key={`${s.species}-${s.seen_at}-${i}`} className="flex flex-wrap justify-between gap-x-2 py-1">
                  <span className="min-w-0 font-medium">{s.species}</span>
                  <span className="shrink-0 text-muted tabular-nums">{s.distance_mi} mi · {formatSiteDateTime(s.seen_at, tz)}</span>
                </li>
              ))}
            </ul>
          )}
        </HazardPanel>
      </section>

      <BriefingCard
        siteId={detail.id}
        siteName={detail.name}
        timeZone={tz}
        entry={briefing === undefined ? { kind: "loading" } : briefing === "error" ? { kind: "unknown" } : briefing === null ? { kind: "none" } : { kind: "briefing", briefing }}
        nowMs={nowMs}
        connectionLost={!demo && (briefingStale || connectionLost) && briefing !== "error"}
        onRegenerate={demo ? undefined : regenerateBriefing}
      />

      <section aria-labelledby="factors-heading" className="rounded-card border border-border bg-surface p-4 shadow-card">
        <h2 id="factors-heading" className="text-base font-semibold">What drives today&apos;s index</h2>
        {detail.top_factors.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No contributing factors.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {detail.top_factors.map((f) => (
              <li key={`${f.hazard}-${f.label}`} className="text-sm">
                <div className="flex justify-between gap-2">
                  <span><span className="font-medium">{HAZARD_LABEL[f.hazard]}</span> · {f.label}</span>
                  <span className="shrink-0 tabular-nums text-muted">{Math.round(f.weight * 100)}%</span>
                </div>
                <div className="mt-1 h-2 rounded-pill bg-bg" aria-hidden="true">
                  <div className={`h-2 rounded-pill ${connectionLost ? "bg-border" : "bg-brand"}`} style={{ width: `${Math.min(100, Math.max(0, f.weight * 100))}%` }} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
