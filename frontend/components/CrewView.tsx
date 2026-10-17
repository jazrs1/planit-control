"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Site } from "@shared/types";
import { useAlertsState, useServerNow } from "@/components/AlertsProvider";
import AlertBanner from "@/components/AlertBanner";
import LightningApproachChip from "@/components/LightningApproachChip";
import CrewReadings from "@/components/CrewReadings";
import CrewBriefing from "@/components/CrewBriefing";
import PushSettings from "@/components/PushSettings";
import { DEMO_DATA, getSites } from "@/lib/api";
import { chooseCrewSite, hasReading, rememberedSite, rememberSite } from "@/lib/crew";
import { HAZARD_LABEL, riskLevel } from "@/lib/risk";
import { formatAlertTime } from "@/lib/alerts";
import { useCrewSiteData } from "@/lib/useCrewSiteData";
import { usePolling } from "@/lib/usePolling";

// The live index: a sign band (green, amber or red, with its shape) over a white panel with a heavy rule.
const RISK = {
  green: { band: "bg-risk-green-solid text-on-risk-green", label: "Low" },
  amber: { band: "bg-risk-amber-solid text-on-risk-amber", label: "Elevated" },
  red: { band: "bg-risk-red-solid text-on-risk-red", label: "High" },
};

function CrewSite({ site }: { site: Site }) {
  const { alerts, status, replay, connection } = useAlertsState();
  const serverNow = useServerNow();
  const { detail, briefing, detailFailed, briefingFailed, loading } = useCrewSiteData(site.id);
  const lightning = alerts?.find((alert) => alert.site_id === site.id && alert.type === "lightning");
  const flood = alerts?.find((alert) => alert.site_id === site.id && alert.type === "flood");
  const alertsUnknown = alerts === null || status === "stale";
  const scoreKnown = detail && Number.isFinite(detail.hazard_index_today) &&
    [detail.conditions.heat, detail.conditions.flood, detail.conditions.soil, detail.conditions.wildlife_summary].some(hasReading);
  const risk = scoreKnown ? RISK[riskLevel(detail.hazard_index_today)] : null;

  return <div className="space-y-5">
    {replay?.running && <p role="status" className="flex items-center gap-2 font-semibold text-muted"><span className="pc-chip pc-chip--replay">REPLAY</span>Storm replay running · Refreshes every 3 seconds</p>}
    <section aria-label="Selected site safety status" className="space-y-3">
      {lightning && <AlertBanner alert={lightning} site={site} compact prominent unconfirmed={alertsUnknown} />}
      <LightningApproachChip approach={detail?.lightning_approach} stopWork={!!lightning} unconfirmed={detailFailed || alertsUnknown || connection.level !== "online"} nowMs={serverNow()} demo={status === "demo"} />
      {flood && <AlertBanner alert={flood} site={site} compact prominent flood={detailFailed ? undefined : detail?.conditions.flood} unconfirmed={alertsUnknown} />}
      {!lightning && !flood && (alertsUnknown ? <div role="status" className="pc-panel pc-panel--heavy pc-panel--unknown p-5">
        <h2 className="pc-title">Safety status unknown</h2>
        <p className="mbs-2 font-semibold">Stop-work status is not confirmed. {status === "stale" ? "Connection lost." : "Waiting for the server."}</p>
      </div> : <div className={`pc-panel pc-panel--heavy ${detailFailed || !risk ? "pc-panel--unknown grayscale" : ""}`}>
        <h2 className={`flex h-10 items-center justify-between gap-3 px-4 ${detailFailed || !risk ? "border-be-2 border-dashed border-muted" : risk.band}`}>
          <span className="pc-label text-sm">Hazard index · now</span>
          {scoreKnown && risk && !detailFailed && <span aria-hidden="true" className={`pc-shape pc-shape--${riskLevel(detail.hazard_index_today)} text-lg [--pc-shape:currentColor]`} />}
        </h2>
        <div className="p-4">
          <p className="font-mono text-7xl font-bold leading-none tabular-nums">{scoreKnown ? detail.hazard_index_today.toFixed(1) : "—"}{detailFailed && scoreKnown ? " ?" : ""}<span className="font-sans text-xl text-muted"> / 10</span></p>
          <p className="mbs-3 text-xl font-extrabold">{detailFailed ? "Not confirmed" : risk ? `${risk.label} risk` : loading ? "Loading conditions…" : "No data"}</p>
          {scoreKnown && <p className="mbs-1 font-semibold">Top hazard: {HAZARD_LABEL[detail.top_hazard]}</p>}
          {scoreKnown && <p className="mbs-2 text-sm text-muted">Live score from current conditions · updated {formatAlertTime(detail.updated_at, site.timezone)}</p>}
        </div>
      </div>)}
      {(lightning || flood) && alertsUnknown && <p role="status" className="font-semibold text-muted">? Last known alert · current conditions not confirmed.</p>}
    </section>
    <CrewReadings detail={detail} stale={detailFailed} />
    <CrewBriefing briefing={briefing} site={site} failed={briefingFailed} loading={loading} />
    {status === "demo" ? <p className="pc-panel pc-panel--unknown p-4 font-semibold">Exit demo mode to report a real hazard.</p> : <Link data-crew-report href={`/report?site=${encodeURIComponent(site.id)}`} className="pc-btn pc-btn--primary pc-btn--large fixed inset-x-4 inset-be-[calc(env(safe-area-inset-bottom,0px)+1rem)] z-50 shadow-float sm:static sm:w-full sm:shadow-none">
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
    <header><h1 className="pc-title">Crew view</h1><p className="mbs-1 font-semibold text-muted">Your site, at a glance.</p></header>
    {demo && <div role="status" className="rounded-card border-2 border-rule bg-surface p-4 font-semibold text-muted">Demo data · sample conditions, not live safety data. <button type="button" onClick={() => setDemo(false)} className="min-h-12 px-2 text-brand underline">Exit demo</button></div>}
    <div className="pc-panel pc-panel--heavy p-4">
      <label htmlFor="crew-site" className="pc-label block text-sm">Your site</label>
      <select id="crew-site" value={selected?.id ?? ""} disabled={!sites?.length || !storageReady} onChange={(event) => setPreferred(event.target.value)} className="mbs-2 min-h-14 w-full min-w-0 rounded-card border-[length:var(--pc-rule-heavy)] border-rule bg-surface px-3 text-lg font-extrabold text-text focus-visible:outline-2 focus-visible:outline-brand">
        {!selected && <option value="">{sites === null ? "Sites unavailable" : "Choose a site"}</option>}
        {[...(sites ?? [])].sort((a, b) => a.name.localeCompare(b.name)).map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
      </select>
      {selected && <p className="mbs-2 text-sm text-muted">{selected.county} County · {selected.timezone}</p>}
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
