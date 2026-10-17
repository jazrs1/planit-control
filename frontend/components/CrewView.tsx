"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Site } from "@shared/types";
import { useAlertsState, useServerNow } from "@/components/AlertsProvider";
import AlertBanner from "@/components/AlertBanner";
import LightningApproachChip from "@/components/LightningApproachChip";
import CrewReadings from "@/components/CrewReadings";
import CrewBriefing from "@/components/CrewBriefing";
import { DEMO_DATA, getSites } from "@/lib/api";
import { chooseCrewSite, hasReading, rememberedSite, rememberSite } from "@/lib/crew";
import { HAZARD_LABEL, riskLevel } from "@/lib/risk";
import { useCrewSiteData } from "@/lib/useCrewSiteData";
import { usePolling } from "@/lib/usePolling";

const RISK = {
  green: { style: "border-risk-green bg-risk-green-bg text-risk-green", label: "Low" },
  amber: { style: "border-risk-amber bg-risk-amber-bg text-risk-amber", label: "Elevated" },
  red: { style: "border-risk-red bg-risk-red-bg text-risk-red", label: "High" },
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
    {replay?.running && <p role="status" className="font-semibold text-muted">Storm replay · Refreshes every 3 seconds</p>}
    <section aria-label="Selected site safety status" className="space-y-3">
      {lightning && <AlertBanner alert={lightning} site={site} compact prominent unconfirmed={alertsUnknown} />}
      <LightningApproachChip approach={detail?.lightning_approach} stopWork={!!lightning} unconfirmed={detailFailed || alertsUnknown || connection.level !== "online"} nowMs={serverNow()} demo={status === "demo"} />
      {flood && <AlertBanner alert={flood} site={site} compact prominent flood={detailFailed ? undefined : detail?.conditions.flood} unconfirmed={alertsUnknown} />}
      {!lightning && !flood && (alertsUnknown ? <div role="status" className="rounded-card border border-border bg-surface p-5 text-muted">
        <h2 className="text-2xl font-bold">Safety status unknown</h2>
        <p className="mt-2">Stop-work status is not confirmed. {status === "stale" ? "Connection lost." : "Waiting for the server."}</p>
      </div> : <div className={`rounded-card border p-5 ${detailFailed || !risk ? "border-border bg-surface text-muted grayscale" : risk.style}`}>
        <h2 className="text-lg font-semibold">Today&apos;s hazard index</h2>
        <p className="mt-2 text-6xl font-bold tabular-nums">{scoreKnown ? detail.hazard_index_today.toFixed(1) : "—"}{detailFailed && scoreKnown ? " ?" : ""}<span className="text-xl"> / 10</span></p>
        <p className="mt-3 text-xl font-bold">{detailFailed ? "Not confirmed" : risk ? `${risk.label} risk` : loading ? "Loading conditions…" : "No data"}</p>
        {scoreKnown && <p className="mt-2 font-medium">Top hazard: {HAZARD_LABEL[detail.top_hazard]}</p>}
      </div>)}
      {(lightning || flood) && alertsUnknown && <p role="status" className="font-semibold text-muted">? Last known alert · current conditions not confirmed.</p>}
    </section>
    <CrewReadings detail={detail} stale={detailFailed} />
    <CrewBriefing briefing={briefing} site={site} failed={briefingFailed} loading={loading} />
    {status === "demo" ? <p className="rounded-card border border-border bg-surface p-4 font-semibold text-muted">Exit demo mode to report a real hazard.</p> : <Link data-crew-report href={`/report?site=${encodeURIComponent(site.id)}`} className="fixed inset-x-4 bottom-[calc(env(safe-area-inset-bottom)+1rem)] z-50 flex min-h-16 items-center justify-center rounded-card bg-brand px-4 text-xl font-bold text-surface shadow-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand sm:static sm:w-full">Report hazard</Link>}
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
    <header><h1 className="text-2xl font-bold text-brand">Crew view</h1><p className="mt-1 text-muted">Your site, at a glance.</p></header>
    {demo && <div role="status" className="rounded-card border border-border bg-surface p-4 font-semibold text-muted">Demo data · sample conditions, not live safety data. <button type="button" onClick={() => setDemo(false)} className="min-h-12 px-2 text-brand underline">Exit demo</button></div>}
    <div className="rounded-card border border-border bg-surface p-4 shadow-card">
      <label htmlFor="crew-site" className="block text-lg font-bold">Your site</label>
      <select id="crew-site" value={selected?.id ?? ""} disabled={!sites?.length || !storageReady} onChange={(event) => setPreferred(event.target.value)} className="mt-2 min-h-14 w-full min-w-0 rounded-card border border-border bg-surface px-3 text-base font-semibold text-text focus-visible:outline-2 focus-visible:outline-brand">
        {!selected && <option value="">{sites === null ? "Sites unavailable" : "Choose a site"}</option>}
        {[...(sites ?? [])].sort((a, b) => a.name.localeCompare(b.name)).map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
      </select>
      {selected && <p className="mt-2 text-sm text-muted">{selected.county} County · {selected.timezone}</p>}
      {sitesFailed && sites !== null && <p role="status" className="mt-2 font-medium text-muted">Site list not confirmed · showing the last loaded sites.</p>}
    </div>
    {selected ? <CrewSite key={selected.id} site={selected} /> : <section role="status" className="space-y-3 rounded-card border border-border bg-surface p-5 text-muted">
      <h2 className="text-xl font-bold">{sitesFailed ? "Can’t reach the server" : sites?.length === 0 ? "No sites available" : "Choose your site"}</h2>
      <p>Site conditions and stop-work status are unknown.</p>
      {!demo && <div className="flex flex-wrap gap-2"><button type="button" onClick={() => void refresh()} className="min-h-12 rounded-card bg-brand px-4 font-semibold text-surface">Retry now</button><button type="button" onClick={() => setDemo(true)} className="min-h-12 rounded-card border border-border px-4 font-semibold text-brand">Show demo data</button></div>}
    </section>}
  </main>;
}

export default function CrewView({ initialSites }: { initialSites: Site[] | null }) {
  const demo = useAlertsState().status === "demo";
  return <CrewModeView key={demo ? "demo" : "live"} initialSites={demo ? DEMO_DATA.sites : initialSites} demo={demo} />;
}
