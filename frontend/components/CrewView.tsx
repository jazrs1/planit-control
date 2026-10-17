"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Site } from "@shared/types";
import { useAlertsState, useServerNow } from "@/components/AlertsProvider";
import AlertBanner from "@/components/AlertBanner";
import { replayWindowLabel } from "@/components/ReplayTimeline";
import { useViewMode } from "@/components/ViewModeProvider";
import LightningApproachChip from "@/components/LightningApproachChip";
import CrewReadings from "@/components/CrewReadings";
import ReadAloudToggle from "@/components/ReadAloudToggle";
import CrewBriefing from "@/components/CrewBriefing";
import PushSettings from "@/components/PushSettings";
import { DEMO_DATA, getSites } from "@/lib/api";
import { chooseCrewSite, hasReading, rememberedSite, rememberSite } from "@/lib/crew";
import { HAZARD_LABEL, liveHazardIndex, riskLevel } from "@/lib/risk";
import { formatAlertTime, replayCleared, replayClearedLabel } from "@/lib/alerts";
import { timeZoneName } from "@/lib/time";
import { useCrewSiteData } from "@/lib/useCrewSiteData";
import { usePolling } from "@/lib/usePolling";

// The live index: a neutral card with the colored shape and a risk tag. Solid red is only for STOP WORK.
const RISK = {
  green: { tag: "bg-risk-green-bg text-risk-green", label: "Low" },
  amber: { tag: "bg-risk-amber-bg text-risk-amber", label: "Elevated" },
  red: { tag: "bg-risk-red-bg text-risk-red", label: "High" },
};

function CrewSite({ site }: { site: Site }) {
  const { alerts, status, replay, connection } = useAlertsState();
  const serverNow = useServerNow();
  const { detail, briefing, detailFailed, briefingFailed, loading } = useCrewSiteData(site.id);
  // Real always beats replay (like the beacon): real stop-work, advisory and flood risk come first; a
  // replay stop-work is shown after them in blue, and once its countdown ends only as a neutral line.
  const mine = (alerts ?? []).filter((alert) => alert.site_id === site.id);
  const lightning = mine.find((alert) => alert.type === "lightning" && !alert.replay);
  const flood = mine.find((alert) => alert.type === "flood" && !alert.replay);
  const replayLightning = mine.find((alert) => alert.type === "lightning" && alert.replay);
  const replayFlood = mine.find((alert) => alert.type === "flood" && alert.replay);
  const replayDone = replayCleared(replayLightning, serverNow());
  // Per device: Live (the default) shows only real states; Replay adds the replay's after them.
  const { mode, setMode } = useViewMode();
  const replayView = mode === "replay" && status !== "demo";
  const approach = detail?.lightning_approach && (!detail.lightning_approach.replay || replayView) ? detail.lightning_approach : null;
  const alertsUnknown = alerts === null || status === "stale";
  // The live index (no replay overrides) once the backend sends hazard_index_live; until then today's.
  const todayIndex = detail ? (liveHazardIndex(detail) !== detail.hazard_index ? liveHazardIndex(detail) : detail.hazard_index_today) : NaN;
  const scoreKnown = detail && Number.isFinite(todayIndex) &&
    [detail.conditions.heat, detail.conditions.flood, detail.conditions.soil, detail.conditions.wildlife_summary].some(hasReading);
  const risk = scoreKnown ? RISK[riskLevel(todayIndex)] : null;

  return <div className="space-y-5">
    {replayView ? <div data-theme="dark" role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card bg-instrument px-4 py-2.5 text-text">
      <span className="pc-chip pc-chip--replay">REPLAY</span>
      <span className="text-sm">{replay?.running ? <>{replayWindowLabel(replay).split(" storm")[0]} · <span className="font-mono tabular-nums">{new Date(serverNow()).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}</span></> : "Replay ended"}</span>
      <button type="button" onClick={() => setMode("live")} className="pc-link ms-auto min-h-9 text-text">Back to live</button>
    </div> : replay?.running && <div data-theme="dark" role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-card bg-instrument px-4 py-2.5 text-text">
      <span className="pc-chip pc-chip--replay">REPLAY</span>
      <span className="min-w-0 flex-1 text-sm">A storm replay is running</span>
      <button type="button" onClick={() => setMode("replay")} className="pc-btn rounded-pill border-text/40 bg-transparent px-5 text-text">Watch replay</button>
    </div>}
    <section aria-label="Selected site safety status" className="space-y-3">
      {lightning && <AlertBanner alert={lightning} site={site} compact prominent unconfirmed={alertsUnknown} />}
      <LightningApproachChip approach={approach} stopWork={!!lightning} unconfirmed={detailFailed || alertsUnknown || connection.level !== "online"} nowMs={approach?.replay || !replay?.running ? serverNow() : Date.now()} demo={status === "demo"} />
      {flood && <AlertBanner alert={flood} site={site} compact prominent flood={detailFailed ? undefined : detail?.conditions.flood} unconfirmed={alertsUnknown} />}
      {!lightning && !flood && (alertsUnknown ? <div role="status" className="pc-panel pc-panel--unknown p-5">
        <h2 className="pc-title pc-title--sign">Safety status unknown</h2>
        <p className="mbs-2 font-semibold">Stop-work status is not confirmed. {status === "stale" ? "Connection lost." : "Waiting for the server."}</p>
      </div> : <div className={`pc-panel overflow-clip p-4 ${detailFailed || !risk ? "pc-panel--unknown grayscale" : ""}`}>
        <h2 className="flex items-center justify-between gap-3">
          <span className="pc-label text-xs text-muted">Hazard index · now</span>
          {risk && !detailFailed && <span className={`pc-chip rounded-[4px] ${risk.tag}`}>{risk.label} risk</span>}
        </h2>
        <div className="mbs-3">
          <p className="flex items-center gap-3 font-mono text-7xl font-semibold leading-none tabular-nums">
            {scoreKnown && risk && !detailFailed && <span aria-hidden="true" className={`pc-shape pc-shape--${riskLevel(todayIndex)} text-4xl`} />}
            {scoreKnown ? todayIndex.toFixed(1) : "—"}{detailFailed && scoreKnown ? " ?" : ""}<span className="font-sans text-xl text-muted"> / 10</span>
          </p>
          <p className="mbs-3 text-xl font-semibold">{detailFailed ? "Not confirmed" : risk ? `${risk.label} risk` : loading ? "Loading conditions…" : "No data"}</p>
          {scoreKnown && <p className="mbs-1 font-semibold">Top hazard: {HAZARD_LABEL[detail.top_hazard]}</p>}
          {scoreKnown && <p className="mbs-2 text-sm text-muted">Live score from current conditions · updated {formatAlertTime(detail.updated_at, site.timezone)}</p>}
        </div>
      </div>)}
      {(lightning || flood) && alertsUnknown && <p role="status" className="font-semibold text-muted">Last known alert · current conditions not confirmed.</p>}
      {replayView && replayLightning && !replayDone && <AlertBanner alert={replayLightning} site={site} compact prominent unconfirmed={alertsUnknown} />}
      {replayView && replayLightning && replayDone && <p className="text-sm text-muted">{replayClearedLabel(replayLightning, site.timezone)}</p>}
      {replayView && replayFlood && <AlertBanner alert={replayFlood} site={site} compact unconfirmed={alertsUnknown} />}
    </section>
    <div className="pc-panel p-4"><ReadAloudToggle site={site} approach={detail?.lightning_approach} /></div>
    <CrewReadings detail={detail} stale={detailFailed} />
    <CrewBriefing briefing={briefing} site={site} failed={briefingFailed} loading={loading} />
    {status === "demo" ? <p className="pc-panel pc-panel--unknown p-4 font-semibold">Exit demo mode to report a real hazard.</p> : <Link data-crew-report href={`/report?site=${encodeURIComponent(site.id)}`} className="pc-btn pc-btn--primary pc-btn--large w-full">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /><circle cx="12" cy="13" r="3.5" fill="none" stroke="currentColor" strokeWidth="2" /></svg>
      Report hazard
    </Link>}
  </div>;
}

function CrewModeView({ initialSites, demo }: { initialSites: Site[] | null; demo: boolean }) {
  const { replay, setDemo } = useAlertsState();
  const [sites, setSites] = useState(initialSites);
  const [sitesFailed, setSitesFailed] = useState(initialSites === null);
  const [preferred, setPreferred] = useState("");
  const [storageReady, setStorageReady] = useState(false);
  useEffect(() => { setPreferred(rememberedSite()); setStorageReady(true); }, []);
  const refresh = useCallback(async () => {
    try { setSites(await getSites()); setSitesFailed(false); }
    catch { setSitesFailed(true); }
  }, []);
  usePolling(refresh, demo ? null : replay?.running ? 3_000 : sites === null ? 5_000 : 30_000);
  const selected = storageReady ? chooseCrewSite(sites ?? [], preferred) : undefined;
  useEffect(() => { if (selected) rememberSite(selected.id); }, [selected?.id]);

  return <main className="mx-auto max-w-2xl space-y-5 px-4 py-5">
    <header><h1 className="pc-title pc-title--sign">Crew view</h1><p className="mbs-1 font-semibold text-muted">Your site, at a glance.</p></header>
    {demo && <div role="status" className="rounded-card border-2 border-rule bg-surface p-4 font-semibold text-muted">Demo data · sample conditions, not live safety data. <button type="button" onClick={() => setDemo(false)} className="min-h-12 px-2 text-brand underline">Exit demo</button></div>}
    <div className="pc-panel p-4">
      <label htmlFor="crew-site" className="pc-label block text-sm">Your site</label>
      <select id="crew-site" value={selected?.id ?? ""} disabled={!sites?.length || !storageReady} onChange={(event) => setPreferred(event.target.value)} className="mbs-2 min-h-14 w-full min-w-0 rounded-card border-2 border-border-strong bg-surface px-3 text-lg font-semibold text-text focus-visible:outline-2 focus-visible:outline-brand">
        {!selected && <option value="">{sites === null ? "Sites unavailable" : "Choose a site"}</option>}
        {[...(sites ?? [])].sort((a, b) => a.name.localeCompare(b.name)).map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
      </select>
      {selected && <p className="mbs-2 text-sm text-muted">{selected.county} County · {timeZoneName(selected.timezone)}</p>}
      {sitesFailed && sites !== null && <p role="status" className="mbs-2 font-medium text-muted">Site list not confirmed · showing the last loaded sites.</p>}
    </div>
    {selected ? <CrewSite key={selected.id} site={selected} /> : <section role="status" className="space-y-3 rounded-card border-2 border-rule bg-surface p-5 text-muted">
      <h2 className="text-xl font-bold">{sitesFailed ? "Can’t reach the server" : sites?.length === 0 ? "No sites available" : "Choose your site"}</h2>
      <p>Site conditions and stop-work status are unknown.</p>
      {!demo && <div className="flex flex-wrap gap-2"><button type="button" onClick={() => void refresh()} className="min-h-12 rounded-card bg-brand px-4 font-semibold text-on-brand">Retry now</button><button type="button" onClick={() => setDemo(true)} className="min-h-12 rounded-card border-2 border-rule px-4 font-semibold text-brand">Show demo data</button></div>}
    </section>}
    <PushSettings sites={sites} defaultSiteId={selected?.id} defaultRole="crew" compact sitesUnconfirmed={!demo && sitesFailed} />
  </main>;
}

export default function CrewView({ initialSites }: { initialSites: Site[] | null }) {
  const demo = useAlertsState().status === "demo";
  return <CrewModeView key={demo ? "demo" : "live"} initialSites={demo ? DEMO_DATA.sites : initialSites} demo={demo} />;
}
