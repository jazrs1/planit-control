"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FireDetection, HazardReport, LightningCell, LightningFlash, Site, WildlifeSightingPoint } from "@shared/types";
import { useAlertsState, useServerNow } from "@/components/AlertsProvider";
import ReplayTimeline from "@/components/ReplayTimeline";
import SiteCard from "@/components/SiteCard";
import SiteScoreHistory from "@/components/SiteScoreHistory";
import InfoButton from "@/components/InfoButton";
import SiteMap, { LIGHTNING_WINDOW_MIN, type MapLayers } from "@/components/SiteMap";
import { DEMO_DATA, getFires, getLightningCells, getLightningCounts, getLightningRecent, getReports, getSites, getWildlife } from "@/lib/api";
import { cellUnconfirmed } from "@/lib/lightning";
import { liveHazardIndex, riskLevel } from "@/lib/risk";
import { usePolling } from "@/lib/usePolling";
import { countAlerts, realAlerts } from "@/lib/alerts";
import { useReplayTimeline } from "@/lib/useReplayTimeline";
import { useFloodConditions } from "@/lib/useFloodConditions";

// Refresh cadence. Alerts follow the same replay/live split in AlertsProvider.
const REPLAY_MS = 3_000;
const SITES_MS = 30_000;
const LIGHTNING_MS = 10_000;
const RETRY_MS = 5_000;
const REPORTS_MS = 60_000;
/** Older than this in real time, a flash is from a replay (real flashes are at most 15 min old). */
const REPLAY_FLASH_AGE_MS = 3 * 60 * 60_000;
/** FIRMS is polled every 30 min on the server and iNaturalist every 6 h: no need to ask more often. */
const FIRES_MS = 5 * 60_000;
const WILDLIFE_MS = 30 * 60_000;
/** On a phone the list starts with the top sites; "Show all" reveals the rest. */
const PHONE_SITES = 10;

function timeOfDay(date: Date) {
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** Statewide times are shown in Eastern time, labeled (most sites are Eastern). */
function easternTime(date: Date) {
  return date.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}

export default function SupervisorDashboard({ initialSites }: { initialSites: Site[] | null }) {
  // Live sites only; null until they load. Mocks are shown only in demo mode, and labeled.
  const [liveSites, setLiveSites] = useState(initialSites);
  const [sitesFailed, setSitesFailed] = useState(initialSites === null);
  const [staleSince, setStaleSince] = useState<Date | null>(null);
  const [liveFlashes, setLiveFlashes] = useState<LightningFlash[]>([]);
  const [flashesFailed, setFlashesFailed] = useState(false);
  const [liveCells, setLiveCells] = useState<LightningCell[] | null>(null);
  // Uncapped real and replay counts (#48); null until the server has the endpoint.
  const [flashCounts, setFlashCounts] = useState<{ real: number; replay: number } | null>(null);
  const [cellsFailed, setCellsFailed] = useState(false);
  // Same alerts as the nav badge and /alerts (AlertsProvider), so the counts always agree.
  const { alerts: knownAlerts, status: alertsStatus, replay, setDemo, refresh: refreshAlerts, connection } = useAlertsState();
  const serverNow = useServerNow();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const rows = useRef(new Map<string, HTMLLIElement>());
  const lastGood = useRef(new Date());
  const [updatedAt, setUpdatedAt] = useState<Date | null>(initialSites === null ? null : new Date());
  const [liveReports, setLiveReports] = useState<HazardReport[]>([]);
  const [liveFires, setLiveFires] = useState<FireDetection[]>([]);
  const [liveWildlife, setLiveWildlife] = useState<WildlifeSightingPoint[]>([]);

  const demo = alertsStatus === "demo";
  const replaying = replay?.running ?? false;
  const sites = demo ? DEMO_DATA.sites : liveSites;
  const flashes = demo ? DEMO_DATA.lightning : liveFlashes;
  // During a replay /lightning/recent runs on the simulated clock, so it returns only the replay's
  // flashes, timestamped in the recorded storm. A real flash is never more than minutes old in real
  // time, so a flash hours older than real time can only be a replay one: drawn blue, counted apart.
  // #48's per-flash replay flag wins when present; the age rule covers an API that predates it.
  const isReplayFlash = useCallback((flash: LightningFlash) => {
    const flag: boolean | undefined = flash.replay;   // LightningFlash.replay (#48); absent on an older API
    if (typeof flag === "boolean") return flag;
    const ts = Date.parse(flash.ts);
    return Number.isFinite(ts) && Date.now() - ts > REPLAY_FLASH_AGE_MS;
  }, []);
  const cells = demo ? DEMO_DATA.lightningCells : liveCells;
  // Fade by age on the backend clock (simulated during replay, the demo clock in demo mode).
  // Offline, freeze the fade where it was: with no new data, letting flashes drain away would make
  // the storm look like it passed.
  const offline = connection.level !== "online";
  const lastOnlineNow = useRef<number | null>(null);
  const lightningStale = !demo && (offline || flashesFailed);
  const nowMs = lightningStale && lastOnlineNow.current !== null ? lastOnlineNow.current : serverNow();
  // Real flashes fade on real time (the server clock is the storm's during a replay); frozen the same way.
  const lastOnlineReal = useRef<number | null>(null);
  const realFlashNowMs = lightningStale && lastOnlineReal.current !== null ? lastOnlineReal.current : Date.now();
  useEffect(() => { if (!lightningStale) lastOnlineReal.current = realFlashNowMs; });
  useEffect(() => { if (!lightningStale) lastOnlineNow.current = nowMs; });
  const cellsUnconfirmed = !demo && (offline || cellsFailed);
  // Each quiet cell is already drawn as unconfirmed; the legend only says so when every cell is.
  const oldCells = !demo && !!cells?.length && cells.every((cell) => cellUnconfirmed(cell, serverNow()));
  const alertsKnown = knownAlerts !== null;
  // Showing last-known alerts while offline: counts are greyed and marked, never shown as current.
  const alertsStale = alertsStatus === "stale";
  // The replay panel freezes too: /replay/events lists the whole storm, so a clock that kept running
  // offline would reveal stop-works and all clears that haven't happened yet.
  const replayStale = !demo && (offline || alertsStale);
  const lastReplayNow = useRef<number | null>(null);
  const replayNowMs = replayStale && lastReplayNow.current !== null ? lastReplayNow.current : serverNow();
  useEffect(() => { if (!replayStale) lastReplayNow.current = replayNowMs; });
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
      setUpdatedAt(lastGood.current);
    } catch {
      // Keep the last real sites, if any, and say they may be out of date.
      setSitesFailed(true);
      setStaleSince((prev) => prev ?? lastGood.current);
    }
  }, []);
  const pollLightning = useCallback(async () => {
    const [flashes, cells, counts] = await Promise.allSettled([getLightningRecent(LIGHTNING_WINDOW_MIN), getLightningCells(), getLightningCounts(LIGHTNING_WINDOW_MIN)]);
    // Before #48 is deployed the counts endpoint is missing: fall back to counting the flashes we have.
    setFlashCounts(counts.status === "fulfilled" ? { real: counts.value.real, replay: counts.value.replay } : null);
    if (flashes.status === "fulfilled") { setLiveFlashes(flashes.value); setFlashesFailed(false); }
    else setFlashesFailed(true);
    if (cells.status === "fulfilled") { setLiveCells(cells.value); setCellsFailed(false); }
    else setCellsFailed(true); // Keep the last cells, explicitly marked as unconfirmed.
  }, []);
  usePolling(pollSites, demo ? null : replaying ? REPLAY_MS : liveSites === null ? RETRY_MS : SITES_MS);
  usePolling(pollLightning, demo || liveSites === null ? null : replaying ? REPLAY_MS : LIGHTNING_MS);
  // Crew reports for the map layer. A failed refresh keeps the last pins.
  const pollReports = useCallback(async () => {
    try { setLiveReports(await getReports()); } catch { /* keep the last reports */ }
  }, []);
  usePolling(pollReports, demo || liveSites === null ? null : REPORTS_MS);
  const reports = (demo ? DEMO_DATA.reports : liveReports) ?? [];
  // Fires and wildlife: polled only while their layer is on. A failed refresh keeps the last points.
  // null until the first answer; a failed refresh keeps the last points and marks them unknown.
  const [firesFailed, setFiresFailed] = useState(false);
  const [wildlifeFailed, setWildlifeFailed] = useState(false);
  const [firesLoaded, setFiresLoaded] = useState(false);
  const [wildlifeLoaded, setWildlifeLoaded] = useState(false);
  const pollFires = useCallback(async () => {
    try { setLiveFires(await getFires()); setFiresFailed(false); setFiresLoaded(true); } catch { setFiresFailed(true); }
  }, []);
  const pollWildlife = useCallback(async () => {
    try { setLiveWildlife(await getWildlife()); setWildlifeFailed(false); setWildlifeLoaded(true); } catch { setWildlifeFailed(true); }
  }, []);
  const fires = (demo ? DEMO_DATA.fires : liveFires) ?? [];
  const wildlife = (demo ? DEMO_DATA.wildlife : liveWildlife) ?? [];

  const lightning = useMemo(() => new Map(alerts.filter((a) => a.type === "lightning").map((a) => [a.site_id, a])), [alerts]);
  // Active stop-work sites first: the hazard index doesn't reflect alerts yet.
  const alertsBySite = useMemo(() => {
    const map = new Map<string, typeof alerts>();
    for (const alert of alerts) map.set(alert.site_id, [...(map.get(alert.site_id) ?? []), alert]);
    return map;
  }, [alerts]);
  const realStops = useMemo(() => new Set(real.filter((a) => a.type === "lightning").map((a) => a.site_id)), [real]);
  // Real stop-work first, then replay stop-work, then the live index (without replay overrides).
  const sorted = useMemo(() => [...(sites ?? [])].sort((a, b) =>
    Number(realStops.has(b.id)) - Number(realStops.has(a.id)) || Number(lightning.has(b.id)) - Number(lightning.has(a.id))
    || liveHazardIndex(b) - liveHazardIndex(a) || a.name.localeCompare(b.name)), [sites, lightning, realStops]);
  // Real only, like every count here: a replay-raised index is never real high risk.
  // Real risk only: hazard_index_live already leaves out replay overrides, so a site that is red on its
  // own (e.g. a nearby fire) still counts while a replay stop-work also sits on it.
  const highRisk = (sites ?? []).filter((s) => riskLevel(liveHazardIndex(s)) === "red").length;
  const stopWork = new Set(real.filter((a) => a.type === "lightning").map((a) => a.site_id)).size;
  const [layers, setLayers] = useState<MapLayers>({ lightning: true, cells: true, sites: true, reports: true, fires: true, wildlife: false });
  const [focusKey, setFocusKey] = useState(0);
  usePolling(pollFires, demo || liveSites === null || !layers.fires ? null : FIRES_MS);
  usePolling(pollWildlife, demo || liveSites === null || !layers.wildlife ? null : WILDLIFE_MS);
  const map = useRef<HTMLElement>(null);
  const [showAll, setShowAll] = useState(false);
  const replayTimeline = useReplayTimeline(replay?.window ?? null, !demo && replaying ? REPLAY_MS : null);
  const layersPanel = useRef<HTMLDetailsElement>(null);
  // Layers start open on a wide screen and collapsed on a phone.
  const [scrollTo, setScrollTo] = useState<string | null>(null);
  const selectFromMap = useCallback((id: string) => {
    // On a phone the row may be past the top 10: show them all, then scroll once it has rendered.
    setShowAll(true);
    setSelectedId(id);
    setScrollTo(id);
  }, []);
  useEffect(() => {
    if (!scrollTo) return;
    rows.current.get(scrollTo)?.scrollIntoView({ block: "nearest" });
    setScrollTo(null);
  }, [scrollTo, showAll]);

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
        : <p className="flex flex-wrap items-baseline gap-x-2 text-[0.8125rem] text-muted">Florida field operations{updatedAt && <span className="text-xs">Updated {easternTime(updatedAt)}</span>}</p>;
  // A count is unknown ("—"), last known ("3?", greyed) or current. Solid sign color only when a crew
  // must act: real stop-work above 0 (red), flood risk above 0 (amber).
  const countUnknown = !alertsKnown || alertsStale;
  const stat = (label: string, value: number, solid?: string) => {
    const shown = alertsKnown ? `${value}${alertsStale ? "?" : ""}` : "—";
    const style = countUnknown ? "text-muted" : solid && value > 0 ? solid : "";
    return <div className={`grid content-between gap-1.5 rounded-[6px] px-2 py-2 ${style}`}><dt className={`text-xs ${style ? "" : "text-muted"}`}>{label}</dt><dd className="text-[2rem] font-normal leading-none tracking-[-0.02em] tabular-nums">{shown}</dd></div>;
  };
  const layerRow = (key: keyof MapLayers | null, label: string, detail: string, swatch: string) => (
    <li key={label}>
      <label className={`flex min-h-10 items-center gap-2.5 ${key ? "cursor-pointer" : "cursor-not-allowed text-muted"}`}>
        <input type="checkbox" className="size-4 shrink-0 accent-(--pc-ink)" disabled={!key} checked={key ? layers[key] : false}
          onChange={key ? (event) => setLayers((value) => ({ ...value, [key]: event.target.checked })) : undefined} />
        <span aria-hidden="true" className={`size-3 shrink-0 ${swatch}`} />
        <span className="grid leading-tight"><span className="text-sm font-semibold">{label}</span><span className="text-[0.6875rem] text-muted">{detail}</span></span>
      </label>
    </li>
  );
  // A real count or no count: cells we can't confirm are drawn grey and described, never counted with "?".
  const cellsText = cells === null ? cellsFailed ? "unavailable · Not confirmed" : "loading…"
    : cellsUnconfirmed ? "last known · Not confirmed" : oldCells ? "quiet for 5 min · motion not confirmed" : `${cells.length} active`;
  // A map layer's count, or why there isn't one: never a "0" for data we couldn't fetch.
  const pointsText = (count: number, loaded: boolean, failed: boolean, unit: string) =>
    !loaded ? failed ? "Unavailable · can't load" : "Loading…" : failed ? `${count} ${unit} · last known` : `${count} ${unit}`;
  // Real and replay flashes counted apart, never mixed. During a replay the real ones aren't available.
  const replayFlashCount = !demo && flashCounts ? flashCounts.replay : flashes.filter(isReplayFlash).length;
  const realFlashCount = !demo && flashCounts ? flashCounts.real : flashes.length - flashes.filter(isReplayFlash).length;
  const stale = lightningStale ? " · last known" : "";
  const flashText = replaying || replayFlashCount > 0
    ? `${realFlashCount ? `${realFlashCount.toLocaleString()} real` : "real not shown during a replay"} · ${replayFlashCount.toLocaleString()} replay${stale}`
    : `${realFlashCount.toLocaleString()} real${stale}`;
  const fullHeight = "lg:h-[calc(100dvh-var(--pc-nav-height)-var(--pc-outage-height,0px))]";

  // Wide screens: the map fills the page and the panels float over it (layers top-left, legend and the
  // replay instrument bottom-left, the site list docked right). Phones: map, legend, replay, then sites.
  return (
    <main className={`relative flex flex-col ${fullHeight} lg:block lg:overflow-clip`}>
      {sites === null ? (
        <section role="status" className="flex min-h-[calc(100dvh-var(--pc-nav-height)-var(--pc-outage-height,0px))] flex-col items-center justify-center gap-3 p-8 text-center lg:min-h-full">
          <h1 className="pc-caption">Supervisor dashboard</h1>
          {sitesFailed ? (
            <>
              <h2 className="pc-title text-risk-red">Can&apos;t reach the server</h2>
              <p className="max-w-md text-sm text-muted">Site conditions and stop-work status are unknown. Don&apos;t treat any site as clear. Retrying every 5 seconds.</p>
              <div className="flex flex-wrap justify-center gap-2">
                <button type="button" onClick={() => { void pollSites(); void refreshAlerts(); }} className="pc-btn pc-btn--primary">Retry now</button>
                <button type="button" onClick={() => setDemo(true)} className="pc-btn pc-btn--quiet">Show demo data</button>
              </div>
            </>
          ) : (
            <p className="text-muted">Connecting…</p>
          )}
        </section>
      ) : (
        <>
          <section ref={map} aria-label="Florida site safety map" className="pc-dash-map relative h-[min(56svh,30rem)] min-h-80 lg:absolute lg:inset-0 lg:h-auto">
            <SiteMap sites={sites} alerts={alerts} flashes={flashes} cells={cells ?? []} cellsUnconfirmed={cellsUnconfirmed} demo={demo} nowMs={serverNow()} flashNowMs={nowMs} selectedId={selectedId} onSelect={selectFromMap} layers={layers} reports={reports} fires={fires} wildlife={wildlife} firesStale={!demo && (firesFailed || offline)} wildlifeStale={!demo && (wildlifeFailed || offline)} focusKey={focusKey} isReplayFlash={isReplayFlash} realFlashNowMs={realFlashNowMs} callouts />
            <details ref={layersPanel} data-map-avoid className="pc-float group absolute inset-bs-3 inset-s-3 z-10 w-60 max-w-[calc(100%-4.5rem)]">
              <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-2 px-3">
                <span className="flex items-center gap-2 text-sm font-semibold">
                  <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4"><path d="m12 3 9 5-9 5-9-5zM3 13l9 5 9-5M3 17.5l9 5 9-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /></svg>
                  Layers
                </span>
                <span aria-hidden="true" className="text-xs text-muted motion-safe:transition-[rotate] group-open:rotate-180">▾</span>
              </summary>
              <ul className="border-bs border-border px-3 py-1.5">
                {layerRow("lightning", "Lightning", `${flashText}, last ${LIGHTNING_WINDOW_MIN} min`, "rounded-pill bg-lightning shadow-[0_0_6px_var(--pc-lightning)]")}
                {layerRow("cells", "Storm cells", cellsText, "rounded-pill border border-risk-amber-solid bg-risk-amber-solid/25")}
                {layerRow("sites", "Sites", `${sites.length} sites`, "rounded-pill bg-muted")}
                {layerRow("reports", "Crew reports", `${reports.length} ${reports.length === 1 ? "report" : "reports"}`, "rounded-pill bg-brand ring-2 ring-surface outline outline-border")}
                {layerRow("fires", "Fires", pointsText(fires.length, demo || firesLoaded, !demo && firesFailed, "detections · last 24 h"), "bg-fire [clip-path:polygon(50%_5%,100%_95%,0_95%)]")}
                {layerRow("wildlife", "Wildlife", layers.wildlife ? pointsText(wildlife.length, demo || wildlifeLoaded, !demo && wildlifeFailed, "sightings · last 30 days") : "Alligators and venomous snakes", "rounded-pill border-2 border-text bg-surface")}
              </ul>
            </details>
          </section>

          <div data-map-avoid className="z-20 flex flex-col gap-2 max-lg:contents lg:absolute lg:inset-be-3 lg:inset-s-3 lg:inset-e-[calc(var(--pc-rail-width)+1.5rem)] lg:items-start">
            {/* One compact line of chips; the explanations live behind the info button. */}
            <div className="flex items-center gap-x-3 overflow-x-auto overscroll-x-contain whitespace-nowrap border-be border-border bg-surface px-4 py-2 text-xs max-lg:order-1 lg:pc-float lg:max-w-full lg:border lg:px-3 lg:py-1.5" aria-label="Map legend">
              <span className="flex shrink-0 items-center gap-1.5"><span className="pc-shape pc-shape--green" />Low</span>
              <span className="flex shrink-0 items-center gap-1.5"><span className="pc-shape pc-shape--amber" />Elevated</span>
              <span className="flex shrink-0 items-center gap-1.5"><span className="pc-shape pc-shape--red" />High</span>
              <span className="flex shrink-0 items-center gap-1.5"><span className="pc-shape pc-shape--stop" />Stop work</span>
              {replaying && <span className="flex shrink-0 items-center gap-1.5"><span className="pc-shape pc-shape--stop [--pc-shape:var(--pc-notice)]" />Replay stop work</span>}
              <span className={`flex shrink-0 items-center gap-1.5 ${lightningStale ? "text-muted grayscale" : ""}`}><span aria-hidden="true" className="inline-block size-2 rounded-pill bg-lightning" />{lightningStale ? "Flashes: last known, fade paused" : "Flash"}</span>
              {replaying && <span className="flex shrink-0 items-center gap-1.5"><span aria-hidden="true" className="inline-block size-2 rounded-pill bg-lightning-replay" />Replay flash</span>}
              <span role="status" className="flex shrink-0 items-center gap-1.5 text-muted">{demo && "Demo data · "}Storm cells: {cellsText}</span>
              {layers.fires && fires.length > 0 && <span className="flex shrink-0 items-center gap-1.5"><span aria-hidden="true" className="inline-block size-2.5 bg-fire [clip-path:polygon(50%_5%,100%_95%,0_95%)]" />Fire</span>}
              {layers.reports && reports.length > 0 && <span className="flex shrink-0 items-center gap-1.5"><span aria-hidden="true" className="inline-block size-2.5 rounded-pill bg-brand ring-2 ring-surface" />Crew report</span>}
              {layers.wildlife && wildlife.length > 0 && <span className="flex shrink-0 items-center gap-1.5"><span aria-hidden="true" className="inline-block size-2.5 rounded-pill border-2 border-text bg-surface" />Wildlife</span>}
              <InfoButton id="legend-help" label="About the map legend">
                <p><b>Sites:</b> circle low (under 4), triangle elevated (4 to under 7), diamond high (7 and up), octagon stop work. Blue marks are from a storm replay.</p>
                <p><b>Flashes:</b> last {LIGHTNING_WINDOW_MIN} min, newest brightest. {flashText}.</p>
                <p><b>Storm cells:</b> circle = cell extent, arrow = motion direction; no arrow = stationary or untracked.</p>
                <p><b>Fires:</b> last 24 h; faint = seen on one satellite pass. <b>Wildlife:</b> last 30 days.</p>
              </InfoButton>
            </div>
            <div className="w-full max-lg:order-3">
              <ReplayTimeline replay={replay} alerts={alerts} sites={sites} timeline={replayTimeline} nowMs={replayNowMs} stale={replayStale} />
            </div>
          </div>

          <section aria-labelledby="sites-heading" data-map-avoid className="z-20 flex min-h-0 flex-col bg-surface max-lg:order-2 lg:pc-float lg:absolute lg:inset-bs-3 lg:inset-be-3 lg:inset-e-3 lg:w-(--pc-rail-width)">
            <div className="shrink-0 space-y-4 border-be border-border px-5 pbs-5 pbe-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <h1 id="sites-heading" className="text-xl font-semibold tracking-[-0.01em]">Sites by risk</h1>
                  <InfoButton id="sites-help" label="About these counts and the order">
                    <p>Counts are real alerts only. A storm replay&apos;s counts are on the replay panel.</p>
                    <p>Real stop-work sites first, then replay stop-work, then the highest live hazard index. Select a site for details.</p>
                  </InfoButton>
                </div>
                {statusLine}
              </div>
              {!alertsKnown && (
                <p role="status" className="border-2 border-dashed border-muted p-2 text-sm font-bold text-muted">
                  Stop-work status unknown · can&apos;t load alerts · retrying…
                </p>
              )}
              {/* "Alerts" is every real active alert (same number as the nav badge); "Stop work" is real
                  lightning stop-work sites. Replay counts are on the replay timeline. */}
              <dl className="-mx-2 grid grid-cols-5 gap-1">
                {stat("Sites", sites.length)}
                {stat("High risk", highRisk)}
                {stat("Alerts", real.length)}
                {stat("Stop work", stopWork, "bg-risk-red-solid text-on-risk-red")}
                {stat("Flood risk", counts.flood, "bg-risk-amber-solid text-on-risk-amber")}
              </dl>
              {alertsStale && <p role="status" className="text-xs font-semibold text-muted">? = last known before the connection was lost</p>}

            </div>
            {/* relative: contains the cards' absolutely positioned screen-reader text, which otherwise escapes
                the scrolling list and stretches the page (the desktop page scrolled into blank space). */}
            <ul className="relative divide-y divide-border/70 lg:overflow-y-auto lg:overscroll-contain">
              {sorted.map((site, index) => <li key={site.id} className={!showAll && index >= PHONE_SITES ? "max-lg:hidden" : ""} ref={(el) => { if (el) rows.current.set(site.id, el); else rows.current.delete(site.id); }}>
                <SiteCard site={site} alerts={alertsBySite.get(site.id) ?? []} realNowMs={replaying ? Date.now() : serverNow()} flood={floodConditions[site.id]} alertsUnconfirmed={alertsStale} approachUnconfirmed={!demo && (sitesFailed || offline || !alertsKnown || alertsStale)} nowMs={serverNow()} demo={demo} history={<SiteScoreHistory site={site} compact lazy unconfirmed={!demo && (sitesFailed || offline)} />} selected={selectedId === site.id} onSelect={() => setSelectedId((current) => current === site.id ? null : site.id)}
                  onShowOnMap={() => { setSelectedId(site.id); setFocusKey((key) => key + 1); if (!window.matchMedia("(min-width: 64rem)").matches) map.current?.scrollIntoView({ block: "start" }); }} />
              </li>)}
            </ul>
            {!showAll && sorted.length > PHONE_SITES && <div className="p-4 lg:hidden"><button type="button" onClick={() => setShowAll(true)} className="pc-btn pc-btn--quiet w-full">Show all {sorted.length} sites</button></div>}
            {sites.length === 0 && <p className="p-4 text-sm text-muted">No sites available.</p>}
          </section>
        </>
      )}
    </main>
  );
}
