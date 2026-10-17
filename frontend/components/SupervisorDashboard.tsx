"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LightningCell, LightningFlash, Site } from "@shared/types";
import { useAlertsState, useServerNow } from "@/components/AlertsProvider";
import ReplayControl from "@/components/ReplayControl";
import SiteCard from "@/components/SiteCard";
import SiteMap, { LIGHTNING_WINDOW_MIN } from "@/components/SiteMap";
import { DEMO_DATA, getLightningCells, getLightningRecent, getSites } from "@/lib/api";
import { cellUnconfirmed } from "@/lib/lightning";
import { riskLevel } from "@/lib/risk";
import { usePolling } from "@/lib/usePolling";
import { countAlerts } from "@/lib/alerts";
import { useFloodConditions } from "@/lib/useFloodConditions";

// Refresh cadence. Alerts follow the same replay/live split in AlertsProvider.
const REPLAY_MS = 3_000;
const SITES_MS = 30_000;
const LIGHTNING_MS = 10_000;
const RETRY_MS = 5_000;

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
  const oldCells = !demo && cells?.some((cell) => cellUnconfirmed(cell, serverNow()));
  const alertsKnown = knownAlerts !== null;
  // Showing last-known alerts while offline: counts are greyed and marked, never shown as current.
  const alertsStale = alertsStatus === "stale";
  const alerts = useMemo(() => knownAlerts ?? [], [knownAlerts]);
  const counts = countAlerts(alerts);
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
  const selectFromMap = useCallback((id: string) => {
    setSelectedId(id);
    rows.current.get(id)?.scrollIntoView({ block: "nearest" });
  }, []);

  const statusLine = demo
    ? <p role="status" className="flex items-center gap-2 text-sm font-semibold text-muted">
      <span className="rounded-pill border border-border px-2 py-0.5 text-xs">Demo data</span>
      Sample sites, alerts and lightning from shared/mocks · not live conditions
      <button type="button" onClick={() => setDemo(false)} className="min-h-11 rounded-card px-2 text-brand underline focus-visible:outline-2 focus-visible:outline-brand">Exit demo</button>
    </p>
    : (staleSince || offline) && sites
      ? <p role="status" className="text-sm font-semibold text-risk-red">Connection lost · showing data from {timeOfDay(staleSince ?? new Date(connection.lastSuccessAt ?? Date.now()))}</p>
      : sites === null
        ? <p role="status" className="text-sm text-muted">{sitesFailed ? "Not connected to the server" : "Connecting…"}</p>
        : <p className="text-sm text-muted">Florida field operations · {replaying ? "Storm replay: refreshing every 3 seconds" : "Refreshes every 30 seconds, lightning every 10"}</p>;

  return (
    <main className="flex min-h-[calc(100dvh-var(--pc-nav-height)-var(--pc-outage-height,0px))] flex-col lg:h-[calc(100dvh-var(--pc-nav-height)-var(--pc-outage-height,0px))] lg:overflow-hidden">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border bg-surface px-5 py-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">Supervisor Dashboard</h1>
          {statusLine}
        </div>
        <ReplayControl />
      </header>

      {sites === null ? (
        <section role="status" className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          {sitesFailed ? (
            <>
              <h2 className="text-lg font-semibold text-risk-red">Can&apos;t reach the server</h2>
              <p className="max-w-md text-sm text-muted">Site conditions and stop-work status are unknown. Don&apos;t treat any site as clear. Retrying every 5 seconds.</p>
              <div className="flex flex-wrap justify-center gap-2">
                <button type="button" onClick={() => { void pollSites(); void refreshAlerts(); }} className="min-h-11 rounded-card bg-brand px-4 font-semibold text-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">Retry now</button>
                <button type="button" onClick={() => setDemo(true)} className="min-h-11 rounded-card border border-border bg-surface px-4 font-semibold text-text focus-visible:outline-2 focus-visible:outline-brand">Show demo data</button>
              </div>
            </>
          ) : (
            <p className="text-muted">Connecting…</p>
          )}
        </section>
      ) : (
        <div className="grid flex-1 lg:min-h-0 lg:grid-cols-[2fr_1fr]">
          <section aria-label="Florida site safety map" className="relative h-[55dvh] min-h-80 lg:h-full">
            <SiteMap sites={sites} alerts={alerts} flashes={flashes} cells={cells ?? []} cellsUnconfirmed={cellsUnconfirmed} demo={demo} nowMs={serverNow()} flashNowMs={nowMs} selectedId={selectedId} onSelect={selectFromMap} />
            <div className="absolute bottom-10 left-3 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-3 rounded-card border border-border bg-surface px-3 py-2 text-xs shadow-card" aria-label="Map legend">
              <span className="text-risk-green">● Low &lt; 4</span><span className="text-risk-amber">● Elevated 4–&lt;7</span><span className="text-risk-red">● High ≥ 7</span><span>◎ Lightning stop work</span>
              <span className={`flex items-center gap-1 ${lightningStale ? "text-muted grayscale" : ""}`}><span aria-hidden="true" className="inline-block size-2 rounded-pill bg-lightning ring-1 ring-lightning-ring" />Flash, last {LIGHTNING_WINDOW_MIN} min ({flashes.length.toLocaleString()}{lightningStale ? "?" : ""}) · {lightningStale ? "last known, fade paused" : "newest brightest"}</span>
              <span role="status" className={cells === null || cellsUnconfirmed || oldCells ? "text-muted" : "text-risk-amber"}>
                {demo && "Demo data · "}Storm cells: {cells === null ? cellsFailed ? "unavailable · Not confirmed" : "loading…" : `${cells.length}${cellsUnconfirmed || oldCells ? "? · Last known · Not confirmed" : ""}`} · circle = cell extent, arrow = motion direction; no arrow = stationary or untracked
              </span>
            </div>
          </section>
          <section aria-label="Sites ranked by hazard index" className="flex min-h-0 flex-col border-t border-border bg-bg lg:border-t-0 lg:border-l">
            <div className="shrink-0 border-b border-border bg-surface p-4">
              {!alertsKnown && (
                <p role="status" className="mb-3 rounded-card border border-risk-red bg-risk-red-bg p-2 text-sm font-semibold text-risk-red">
                  Stop-work status unknown · can&apos;t load alerts · retrying…
                </p>
              )}
              {/* "Alerts" is every active alert (same number as the nav badge); "Stop work" is lightning stop-work sites. */}
              <dl className="grid grid-cols-5 gap-2 text-center">
                <div><dt className="text-xs text-muted">Sites</dt><dd className="text-2xl font-bold">{sites.length}</dd></div>
                <div><dt className="text-xs text-muted">High risk</dt><dd className="text-2xl font-bold text-risk-red">{sites.filter((s) => riskLevel(s.hazard_index) === "red").length}</dd></div>
                <div><dt className="text-xs text-muted">Alerts</dt><dd className={`text-2xl font-bold ${!alertsKnown || alertsStale ? "text-muted" : counts.lightning ? "text-risk-red" : alerts.length ? "text-risk-amber" : "text-risk-green"}`}>{alertsKnown ? `${alerts.length}${alertsStale ? "?" : ""}` : "—"}</dd></div>
                <div><dt className="text-xs text-muted">Stop work</dt><dd className={`text-2xl font-bold ${alertsKnown && !alertsStale ? "text-risk-red" : "text-muted"}`}>{alertsKnown ? `${sites.filter((s) => lightning.has(s.id)).length}${alertsStale ? "?" : ""}` : "—"}</dd></div>
                <div><dt className="text-xs text-muted">Flood risk</dt><dd className={`text-2xl font-bold ${alertsKnown && !alertsStale ? "text-risk-amber" : "text-muted"}`}>{alertsKnown ? `${counts.flood}${alertsStale ? "?" : ""}` : "—"}</dd></div>
              </dl>
              {alertsStale && <p role="status" className="mt-2 text-center text-xs font-medium text-muted">? = last known before the connection was lost</p>}
              <p className="mt-4 text-xs font-medium uppercase tracking-wide text-muted">Stop-work sites first, then highest risk</p>
            </div>
            {/* relative: contains the cards' absolutely positioned screen-reader text, which otherwise escapes
                the scrolling list and stretches the page (the desktop page scrolled into blank space). */}
            <ul className="relative space-y-3 p-4 lg:overflow-y-auto">
              {sorted.map((site) => <li key={site.id} ref={(el) => { if (el) rows.current.set(site.id, el); else rows.current.delete(site.id); }} onClick={() => setSelectedId(site.id)}>
                <SiteCard site={site} alerts={alerts.filter((alert) => alert.site_id === site.id)} flood={floodConditions[site.id]} alertsUnconfirmed={alertsStale} approachUnconfirmed={!demo && (sitesFailed || offline || !alertsKnown || alertsStale)} nowMs={serverNow()} demo={demo} selected={selectedId === site.id} onSelect={() => setSelectedId(site.id)} />
              </li>)}
            </ul>
            {sites.length === 0 && <p className="p-4 text-sm text-muted">No sites available.</p>}
          </section>
        </div>
      )}
    </main>
  );
}
