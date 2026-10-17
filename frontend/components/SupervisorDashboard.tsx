"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LightningCell, LightningFlash, Site } from "@shared/types";
import { useAlertsState, useServerNow } from "@/components/AlertsProvider";
import ReplayTimeline from "@/components/ReplayTimeline";
import SiteCard from "@/components/SiteCard";
import SiteScoreHistory from "@/components/SiteScoreHistory";
import SiteMap, { LIGHTNING_WINDOW_MIN, type MapLayers } from "@/components/SiteMap";
import { DEMO_DATA, getLightningCells, getLightningRecent, getSites } from "@/lib/api";
import { cellUnconfirmed } from "@/lib/lightning";
import { riskLevel } from "@/lib/risk";
import { usePolling } from "@/lib/usePolling";
import { countAlerts, realAlerts } from "@/lib/alerts";
import { useReplayLog } from "@/lib/useReplayLog";
import { useFloodConditions } from "@/lib/useFloodConditions";

// Refresh cadence. Alerts follow the same replay/live split in AlertsProvider.
const REPLAY_MS = 3_000;
const SITES_MS = 30_000;
const LIGHTNING_MS = 10_000;
const RETRY_MS = 5_000;
/** On a phone the list starts with the top sites; "Show all" reveals the rest. */
const PHONE_SITES = 10;

function timeOfDay(date: Date) {
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export default function SupervisorDashboard({ initialSites }: { initialSites: Site[] | null }) {
  // Live sites only; null until they load. Mocks are shown only in demo mode, and labeled.
  const [liveSites, setLiveSites] = useState(initialSites);
  const [sitesFailed, setSitesFailed] = useState(initialSites === null);
  const [staleSince, setStaleSince] = useState<Date | null>(null);
  const [liveFlashes, setLiveFlashes] = useState<LightningFlash[]>([]);
  const [flashesFailed, setFlashesFailed] = useState(false);
  const [liveCells, setLiveCells] = useState<LightningCell[] | null>(null);
  const [cellsFailed, setCellsFailed] = useState(false);
  // Same alerts as the nav badge and /alerts (AlertsProvider), so the counts always agree.
  const { alerts: knownAlerts, status: alertsStatus, replay, setDemo, refresh: refreshAlerts, connection } = useAlertsState();
  const serverNow = useServerNow();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const rows = useRef(new Map<string, HTMLLIElement>());
  const lastGood = useRef(new Date());

  const demo = alertsStatus === "demo";
  const replaying = replay?.running ?? false;
  const sites = demo ? DEMO_DATA.sites : liveSites;
  const flashes = demo ? DEMO_DATA.lightning : liveFlashes;
  const cells = demo ? DEMO_DATA.lightningCells : liveCells;
  // Fade by age on the backend clock (simulated during replay, the demo clock in demo mode).
  // Offline, freeze the fade where it was: with no new data, letting flashes drain away would make
  // the storm look like it passed.
  const offline = connection.level !== "online";
  const lastOnlineNow = useRef<number | null>(null);
  const lightningStale = !demo && (offline || flashesFailed);
  const nowMs = lightningStale && lastOnlineNow.current !== null ? lastOnlineNow.current : serverNow();
  useEffect(() => { if (!lightningStale) lastOnlineNow.current = nowMs; });
  const cellsUnconfirmed = !demo && (offline || cellsFailed);
  // Each quiet cell is already drawn as unconfirmed; the legend only says so when every cell is.
  const oldCells = !demo && !!cells?.length && cells.every((cell) => cellUnconfirmed(cell, serverNow()));
  const alertsKnown = knownAlerts !== null;
  // Showing last-known alerts while offline: counts are greyed and marked, never shown as current.
  const alertsStale = alertsStatus === "stale";
  const alerts = useMemo(() => knownAlerts ?? [], [knownAlerts]);
  // Real alerts only, like the nav badge: replay counts are on the replay timeline.
  const real = useMemo(() => realAlerts(alerts), [alerts]);
  const counts = countAlerts(real);
  const floodConditions = useFloodConditions();

  const pollSites = useCallback(async () => {
    try {
      const next = await getSites();
      setLiveSites(next);
      setSitesFailed(false);
      setStaleSince(null);
      lastGood.current = new Date();
    } catch {
      // Keep the last real sites, if any, and say they may be out of date.
      setSitesFailed(true);
      setStaleSince((prev) => prev ?? lastGood.current);
    }
  }, []);
  const pollLightning = useCallback(async () => {
    const [flashes, cells] = await Promise.allSettled([getLightningRecent(LIGHTNING_WINDOW_MIN), getLightningCells()]);
    if (flashes.status === "fulfilled") { setLiveFlashes(flashes.value); setFlashesFailed(false); }
    else setFlashesFailed(true);
    if (cells.status === "fulfilled") { setLiveCells(cells.value); setCellsFailed(false); }
    else setCellsFailed(true); // Keep the last cells, explicitly marked as unconfirmed.
  }, []);
  usePolling(pollSites, demo ? null : replaying ? REPLAY_MS : liveSites === null ? RETRY_MS : SITES_MS);
  usePolling(pollLightning, demo || liveSites === null ? null : replaying ? REPLAY_MS : LIGHTNING_MS);

  const lightning = useMemo(() => new Map(alerts.filter((a) => a.type === "lightning").map((a) => [a.site_id, a])), [alerts]);
  // Active stop-work sites first: the hazard index doesn't reflect alerts yet.
  const sorted = useMemo(() => [...(sites ?? [])].sort((a, b) => Number(lightning.has(b.id)) - Number(lightning.has(a.id)) || b.hazard_index - a.hazard_index || a.name.localeCompare(b.name)), [sites, lightning]);
  const highRisk = (sites ?? []).filter((s) => riskLevel(s.hazard_index) === "red").length;
  const stopWork = new Set(real.filter((a) => a.type === "lightning").map((a) => a.site_id)).size;
  const [layers, setLayers] = useState<MapLayers>({ lightning: true, cells: true, sites: true });
  const [showAll, setShowAll] = useState(false);
  const replayLog = useReplayLog(replay, knownAlerts, demo ? null : liveSites);
  const layersPanel = useRef<HTMLDetailsElement>(null);
  // Layers start open on a wide screen and collapsed on a phone.
  useEffect(() => { if (layersPanel.current && window.matchMedia("(min-width: 64rem)").matches) layersPanel.current.open = true; }, [sites === null]);
  const selectFromMap = useCallback((id: string) => {
    setSelectedId(id);
    rows.current.get(id)?.scrollIntoView({ block: "nearest" });
  }, []);

  const statusLine = demo
    ? <p role="status" className="flex flex-wrap items-center gap-2 text-sm font-semibold text-muted">
      <span className="pc-chip pc-chip--unknown">Demo data</span>
      Sample sites, alerts and lightning from shared/mocks · not live conditions
      <button type="button" onClick={() => setDemo(false)} className="min-h-11 px-1 text-text underline underline-offset-2 focus-visible:outline-2">Exit demo</button>
    </p>
    : (staleSince || offline) && sites
      ? <p role="status" className="text-sm font-bold text-risk-red">Connection lost · showing data from {timeOfDay(staleSince ?? new Date(connection.lastSuccessAt ?? Date.now()))}</p>
      : sites === null
        ? <p role="status" className="text-sm text-muted">{sitesFailed ? "Not connected to the server" : "Connecting…"}</p>
        : <p className="text-[0.8125rem] text-muted">Florida field operations · {replaying ? "Storm replay: refreshing every 3 seconds" : "Refreshes every 30 seconds, lightning every 10"}</p>;
  // A count is unknown ("—"), last known ("3?", greyed) or current. Solid sign color only when a crew
  // must act: real stop-work above 0 (red), flood risk above 0 (amber).
  const countUnknown = !alertsKnown || alertsStale;
  const stat = (label: string, value: number, solid?: string) => {
    const shown = alertsKnown ? `${value}${alertsStale ? "?" : ""}` : "—";
    const style = countUnknown ? "text-muted" : solid && value > 0 ? solid : "";
    return <div className={`grid gap-1 px-2.5 py-2 ${style}`}><dt className="pc-label">{label}</dt><dd className="font-mono text-2xl font-bold leading-none tabular-nums">{shown}</dd></div>;
  };
  const layerRow = (key: keyof MapLayers | null, label: string, detail: string, swatch: string) => (
    <li key={label}>
      <label className={`flex min-h-10 items-center gap-2.5 ${key ? "cursor-pointer" : "cursor-not-allowed text-muted"}`}>
        <input type="checkbox" className="size-4 shrink-0 accent-(--pc-ink)" disabled={!key} checked={key ? layers[key] : false}
          onChange={key ? (event) => setLayers((value) => ({ ...value, [key]: event.target.checked })) : undefined} />
        <span aria-hidden="true" className={`size-3 shrink-0 ${swatch}`} />
        <span className="grid leading-tight"><span className="text-[0.8125rem] font-bold">{label}</span><span className="text-[0.6875rem] text-muted">{detail}</span></span>
      </label>
    </li>
  );

  return (
    <main className="flex flex-col lg:grid lg:h-[calc(100dvh-var(--pc-nav-height)-var(--pc-outage-height,0px))] lg:grid-cols-[minmax(0,1fr)_26rem] lg:grid-rows-[minmax(0,1fr)_auto] lg:overflow-clip">
      {sites === null ? (
        <section role="status" className="flex min-h-[calc(100dvh-var(--pc-nav-height)-var(--pc-outage-height,0px))] flex-col items-center justify-center gap-3 p-8 text-center lg:col-span-2 lg:row-span-2 lg:min-h-0">
          <h1 className="pc-label text-muted">Supervisor dashboard</h1>
          {sitesFailed ? (
            <>
              <h2 className="pc-title text-risk-red">Can&apos;t reach the server</h2>
              <p className="max-w-md text-sm text-muted">Site conditions and stop-work status are unknown. Don&apos;t treat any site as clear. Retrying every 5 seconds.</p>
              <div className="flex flex-wrap justify-center gap-2">
                <button type="button" onClick={() => { void pollSites(); void refreshAlerts(); }} className="pc-btn pc-btn--primary">Retry now</button>
                <button type="button" onClick={() => setDemo(true)} className="pc-btn">Show demo data</button>
              </div>
            </>
          ) : (
            <p className="text-muted">Connecting…</p>
          )}
        </section>
      ) : (
        <>
          <section aria-label="Florida site safety map" className="relative h-[min(56svh,30rem)] min-h-80 lg:col-start-1 lg:row-start-1 lg:h-auto lg:min-h-0">
            <SiteMap sites={sites} alerts={alerts} flashes={flashes} cells={cells ?? []} cellsUnconfirmed={cellsUnconfirmed} demo={demo} nowMs={serverNow()} flashNowMs={nowMs} selectedId={selectedId} onSelect={selectFromMap} layers={layers} callouts />
            <details ref={layersPanel} data-map-avoid className="group absolute inset-bs-3 inset-s-3 z-10 w-60 max-w-[calc(100%-4.5rem)] border-2 border-rule bg-surface shadow-float">
              <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-2 px-3">
                <span className="flex items-center gap-2 pc-label text-[0.8125rem]">
                  <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4"><path d="m12 3 9 5-9 5-9-5zM3 13l9 5 9-5M3 17.5l9 5 9-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /></svg>
                  Layers
                </span>
                <span aria-hidden="true" className="text-xs motion-safe:transition-[rotate] group-open:rotate-180">▾</span>
              </summary>
              <ul className="border-bs-2 border-rule px-3 py-1.5">
                {layerRow("lightning", "Lightning", `${flashes.length.toLocaleString()}${lightningStale ? "?" : ""} flashes · last ${LIGHTNING_WINDOW_MIN} min`, "rounded-pill bg-lightning ring-1 ring-lightning-ring")}
                {layerRow("cells", "Storm cells", cells === null ? "Loading…" : `${cells.length}${cellsUnconfirmed || oldCells ? "?" : ""} cells`, "rounded-pill border-2 border-dashed border-rule bg-risk-amber-bg")}
                {layerRow("sites", "Sites", `${sites.length} sites`, "rounded-pill bg-muted")}
                {layerRow(null, "Crew reports", "Not loaded on the dashboard", "bg-surface-2")}
                {layerRow(null, "Flood zones", "Needs data", "bg-surface-2")}
                {layerRow(null, "Fires", "Needs data", "bg-surface-2")}
                {layerRow(null, "Wildlife", "Needs data", "bg-surface-2")}
              </ul>
            </details>
            <div data-map-avoid className="absolute inset-be-8 inset-s-3 z-10 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-x-3.5 gap-y-1 border-2 border-rule bg-surface px-3 py-2 text-xs shadow-float" aria-label="Map legend">
              <span className="flex items-center gap-1.5"><span className="pc-shape pc-shape--green" />Low &lt; 4</span>
              <span className="flex items-center gap-1.5"><span className="pc-shape pc-shape--amber" />Elevated 4–&lt;7</span>
              <span className="flex items-center gap-1.5"><span className="pc-shape pc-shape--red" />High ≥ 7</span>
              <span className="flex items-center gap-1.5"><span className="pc-shape pc-shape--stop" />Lightning stop work</span>
              <span className={`flex items-center gap-1.5 ${lightningStale ? "text-muted grayscale" : ""}`}><span aria-hidden="true" className="inline-block size-2 rounded-pill bg-lightning ring-1 ring-lightning-ring" />Flash, last {LIGHTNING_WINDOW_MIN} min ({flashes.length.toLocaleString()}{lightningStale ? "?" : ""}) · {lightningStale ? "last known, fade paused" : "newest brightest"}</span>
              <span role="status" className={`max-lg:hidden ${cells === null || cellsUnconfirmed || oldCells ? "text-muted" : ""}`}>
                {demo && "Demo data · "}Storm cells: {cells === null ? cellsFailed ? "unavailable · Not confirmed" : "loading…" : `${cells.length}${cellsUnconfirmed || oldCells ? "? · Last known · Not confirmed" : ""}`} · circle = cell extent, arrow = motion direction; no arrow = stationary or untracked
              </span>
            </div>
          </section>

          <div className="lg:col-start-1 lg:row-start-2">
            <ReplayTimeline replay={replay} alerts={alerts} sites={sites} log={replayLog} stale={!demo && (offline || alertsStale)} />
          </div>

          <section aria-labelledby="sites-heading" className="flex min-h-0 flex-col border-bs-2 border-rule bg-bg lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:border-bs-0 lg:border-s-2">
            <div className="shrink-0 space-y-3 border-be-2 border-rule bg-surface p-4">
              <div>
                <h1 id="sites-heading" className="pc-title text-xl">Sites by risk</h1>
                {statusLine}
              </div>
              {!alertsKnown && (
                <p role="status" className="border-2 border-dashed border-muted p-2 text-sm font-bold text-muted">
                  Stop-work status unknown · can&apos;t load alerts · retrying…
                </p>
              )}
              {/* "Alerts" is every real active alert (same number as the nav badge); "Stop work" is real
                  lightning stop-work sites. Replay counts are on the replay timeline. */}
              <dl className="grid grid-cols-5 divide-x-2 divide-rule border-2 border-rule">
                {stat("Sites", sites.length)}
                {stat("High risk", highRisk)}
                {stat("Alerts", real.length)}
                {stat("Stop work", stopWork, "bg-risk-red-solid text-on-risk-red")}
                {stat("Flood risk", counts.flood, "bg-risk-amber-solid text-on-risk-amber")}
              </dl>
              {alertsStale && <p role="status" className="text-xs font-semibold text-muted">? = last known before the connection was lost</p>}
              <p className="pc-label text-muted">Stop-work sites first, then highest risk</p>
            </div>
            {/* relative: contains the cards' absolutely positioned screen-reader text, which otherwise escapes
                the scrolling list and stretches the page (the desktop page scrolled into blank space). */}
            <ul className="relative divide-y-2 divide-border lg:overflow-y-auto lg:overscroll-contain">
              {sorted.map((site, index) => <li key={site.id} className={!showAll && index >= PHONE_SITES ? "max-lg:hidden" : ""} ref={(el) => { if (el) rows.current.set(site.id, el); else rows.current.delete(site.id); }} onClick={() => setSelectedId(site.id)}>
                <SiteCard site={site} alerts={alerts.filter((alert) => alert.site_id === site.id)} flood={floodConditions[site.id]} alertsUnconfirmed={alertsStale} approachUnconfirmed={!demo && (sitesFailed || offline || !alertsKnown || alertsStale)} nowMs={serverNow()} demo={demo} history={<SiteScoreHistory site={site} compact lazy unconfirmed={!demo && (sitesFailed || offline)} />} selected={selectedId === site.id} onSelect={() => setSelectedId(site.id)} />
              </li>)}
            </ul>
            {!showAll && sorted.length > PHONE_SITES && <div className="p-4 lg:hidden"><button type="button" onClick={() => setShowAll(true)} className="pc-btn w-full">Show all {sorted.length} sites</button></div>}
            {sites.length === 0 && <p className="p-4 text-sm text-muted">No sites available.</p>}
          </section>
        </>
      )}
    </main>
  );
}
