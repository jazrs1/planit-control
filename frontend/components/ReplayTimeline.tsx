"use client";

import { useEffect, useRef } from "react";
import type { Alert, ReplayEvent, ReplayEventKind, ReplaySeriesBin, ReplayStatus, Site } from "@shared/types";
import ReplayControl from "@/components/ReplayControl";
import { formatStrikeDistance } from "@/lib/alerts";
import type { ReplayTimelineData } from "@/lib/useReplayTimeline";

const EVENT: Record<ReplayEventKind, { label: string; mark: string }> = {
  stop_work_start: { label: "Stop work", mark: "pc-shape--stop" },
  approach_start: { label: "Lightning possible", mark: "pc-shape--amber" },
  all_clear: { label: "All clear", mark: "pc-shape--green" },
  flood_start: { label: "Flood risk", mark: "pc-shape--amber" },
};

const BIN_MS = 5 * 60_000;
const TICK_MS = 30 * 60_000;
/** backend/lightning/replay.py QUIET_TAIL: after the storm data the replay runs this long so countdowns can clear. */
const QUIET_TAIL_MIN = 31;
/** The recorded storm a start plays when the server hasn't reported a window yet (its newest folder,
 *  README "Storm replay"). Status reports the real window once a replay has run. */
const DEFAULT_WINDOW = "2025-08-04_2200-2300";
const ZONE = { timeZone: "America/New_York" } as const;
/** A recording of the replay for people who can't start one. Set the video URL to show the link in the
 *  idle panel; null keeps it hidden. */
const RECORDING_URL: string | null = null;

function clock(ms: number, zone = false, timeZone: string = ZONE.timeZone) {
  return new Date(ms).toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit", ...(zone ? { timeZoneName: "short" } : {}) });
}

/** An event's time in its site's own zone; the zone is named when it isn't Eastern (the panhandle). */
function siteClock(ms: number, timeZone: string | undefined) {
  return timeZone && timeZone !== ZONE.timeZone ? clock(ms, true, timeZone) : clock(ms);
}

/** "Aug 4, 2025 storm · 6:00–7:31 PM EDT", from the status times or, before any replay, the folder name. */
export function replayWindowLabel(replay: Pick<ReplayStatus, "window" | "window_start" | "quiet_until"> | null): string {
  let start = replay?.window_start ? Date.parse(replay.window_start) : NaN;
  let end = replay?.quiet_until ? Date.parse(replay.quiet_until) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    const match = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(replay?.window ?? DEFAULT_WINDOW);
    if (!match) return "Recorded storm";
    const [, y, mo, d, sh, sm, eh, em] = match.map(Number);
    start = Date.UTC(y, mo - 1, d, sh, sm);
    end = Date.UTC(y, mo - 1, d, eh, em);
    if (end <= start) end += 24 * 60 * 60_000;
    end += QUIET_TAIL_MIN * 60_000;
  }
  const date = new Date(start).toLocaleDateString("en-US", { ...ZONE, month: "short", day: "numeric", year: "numeric" });
  return `${date} storm · ${clock(start).replace(/\s?[AP]M$/, "")}–${clock(end, true)}`;
}

type Span = { t0: number; t1: number; now: number };
const at = (span: Span, ms: number) => Math.max(0, Math.min(100, ((ms - span.t0) / (span.t1 - span.t0)) * 100));

/** A thin line with a soft area under it, on the window's time axis; a baseline and nothing else. */
function AreaLine({ values, span, max, step = false }: { values: { start: number; value: number }[]; span: Span; max: number; step?: boolean }) {
  const y = (v: number) => 39 - (v / Math.max(1, max)) * 36;
  let d = "";
  values.forEach((point, i) => {
    const x0 = at(span, point.start), x1 = at(span, Math.min(point.start + BIN_MS, span.now));
    d += step ? `${i ? "L" : "M"}${x0} ${y(point.value)} H${x1} ` : `${i ? "L" : "M"}${(x0 + x1) / 2} ${y(point.value)} `;
  });
  const first = values[0], last = values.at(-1);
  const area = first && last ? `${d}L${step ? at(span, Math.min(last.start + BIN_MS, span.now)) : (at(span, last.start) + at(span, Math.min(last.start + BIN_MS, span.now))) / 2} 40 L${step ? at(span, first.start) : (at(span, first.start) + at(span, Math.min(first.start + BIN_MS, span.now))) / 2} 40 Z` : "";
  return <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="block h-9 w-full" aria-hidden="true">
    <line x1="0" x2="100" y1="39.5" y2="39.5" className="stroke-instrument-line" strokeWidth="1" vectorEffect="non-scaling-stroke" />
    {area && <path d={area} className="fill-muted" opacity={0.18} />}
    {d && <path d={d} fill="none" className="stroke-text" strokeWidth="1.25" strokeLinejoin="round" vectorEffect="non-scaling-stroke" opacity={0.85} />}
  </svg>;
}

function FlashBars({ bins, span }: { bins: ReplaySeriesBin[]; span: Span }) {
  return <AreaLine values={bins.map((bin) => ({ start: Date.parse(bin.start), value: bin.flashes }))} span={span} max={Math.max(1, ...bins.map((bin) => bin.flashes))} />;
}

function StopSteps({ bins, span }: { bins: ReplaySeriesBin[]; span: Span }) {
  return <AreaLine step values={bins.map((bin) => ({ start: Date.parse(bin.start), value: bin.sites_in_stop_work }))} span={span} max={Math.max(4, ...bins.map((bin) => bin.sites_in_stop_work))} />;
}

type ReplayTimelineProps = {
  replay: ReplayStatus | null;
  alerts: Alert[];
  sites: Site[];
  timeline: ReplayTimelineData;
  /** The backend clock: simulated during a replay. Events after it haven't happened yet. */
  nowMs: number;
  /** The connection dropped: the replay may have ended; everything here is last known. */
  stale: boolean;
  /** This device's view. In Live view a running replay is one slim banner with "Watch replay". */
  view?: "live" | "replay";
  /** Replay view after the replay finished: the panel stays on its final state. */
  ended?: boolean;
  onWatch?: () => void;
  /** Replay view: picking an event marker selects its site, like the list's "Show on map". */
  onSelectSite?: (siteId: string) => void;
};

/** The storm replay instrument: the one dark panel on the light page, so a replay can never be mistaken
 *  for a real stop-work. Controls, forward-only progress (no seeking), event markers, flash particles,
 *  two quiet charts and the key events. Replay counts live here, never in the dashboard's real counts. */
/** Close events overlap on a narrow track, and the top marker's tap area takes the tap: a pointer pick goes
 *  to the marker whose center is nearest the pointer. (Keyboard picks the focused marker.) */
function nearestMarkerSite(click: React.MouseEvent<HTMLButtonElement>): string | undefined {
  let best: { site?: string; distance: number } = { distance: Infinity };
  for (const marker of click.currentTarget.parentElement?.querySelectorAll<HTMLElement>("[data-site]") ?? []) {
    const box = marker.getBoundingClientRect();
    const distance = Math.abs(box.left + box.width / 2 - click.clientX);
    if (distance < best.distance) best = { site: marker.dataset.site, distance };
  }
  return best.site;
}

export default function ReplayTimeline({ replay, alerts, sites, timeline, nowMs, stale, view = "replay", ended = false, onWatch, onSelectSite }: ReplayTimelineProps) {
  const running = replay?.running ?? false;
  const names = new Map(sites.map((site) => [site.id, site.name]));
  const zones = new Map(sites.map((site) => [site.id, site.timezone]));
  const replayStops = alerts.filter((alert) => alert.replay && alert.type === "lightning").length;
  const replayFlood = alerts.filter((alert) => alert.replay && alert.type === "flood").length;
  const t0 = replay?.window_start ? Date.parse(replay.window_start) : NaN;
  const tEnd = replay?.window_end ? Date.parse(replay.window_end) : NaN;
  const t1 = replay?.quiet_until ? Date.parse(replay.quiet_until) : NaN;
  const timed = Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0;
  const span: Span = { t0, t1, now: Math.max(t0, Math.min(t1, nowMs)) };
  // Without window times (an older server), fall back to the share of files ingested.
  const progress = timed ? at(span, span.now) / 100 : replay && replay.files_total > 0 ? Math.min(1, replay.files_done / replay.files_total) : 0;
  const quiet = running && (timed ? Number.isFinite(tEnd) && span.now >= tEnd : progress >= 1);
  // The whole storm's stop-work starts and all clears arrive at once: show only what has happened.
  const events = timed ? (timeline.events ?? []).filter((event) => Date.parse(event.at) <= span.now) : [];
  const bins = timed ? (timeline.series?.bins ?? []).filter((bin) => Date.parse(bin.start) <= span.now) : [];
  const ticks = timed ? Array.from({ length: Math.floor((t1 - t0) / TICK_MS) + 1 }, (_, i) => t0 + i * TICK_MS) : [];
  const details = useRef<HTMLDetailsElement>(null);
  // Key events start open on a wide screen and collapsed on a phone.
  useEffect(() => { if (details.current && window.matchMedia("(min-width: 64rem)").matches) details.current.open = true; }, [running]);

  // Live view while a replay runs: one slim line, so today's map stays today's.
  if (running && view === "live") {
    return (
      <section data-theme="dark" aria-labelledby="replay-heading" className="pc-reveal flex flex-wrap items-center gap-x-4 gap-y-2 rounded-card bg-instrument px-4 py-2 text-text shadow-float">
        <span className="pc-chip pc-chip--replay">REPLAY</span>
        <h2 id="replay-heading" className="min-w-0 flex-1 text-sm">A storm replay is running</h2>
        {onWatch && <button type="button" onClick={onWatch} className="pc-btn rounded-pill border-text/40 bg-transparent px-5 text-text">Watch replay</button>}
      </section>
    );
  }

  if (!running && !ended) {
    return (
      <section data-theme="dark" aria-labelledby="replay-heading" className="pc-reveal flex flex-wrap items-center gap-x-4 gap-y-2 rounded-card bg-instrument px-4 py-2 text-text shadow-float">
        <h2 id="replay-heading" className="text-sm font-semibold">Storm replay</h2>
        <p className="min-w-0 flex-1 basis-56 text-xs text-muted sm:truncate">{replayWindowLabel(replay)}. Plays a recorded storm through the live pipeline</p>
        {RECORDING_URL && <a href={RECORDING_URL} target="_blank" rel="noopener noreferrer" className="pc-link text-text">Watch the 90-second recording</a>}
        <ReplayControl />
      </section>
    );
  }

  const eventRow = (event: ReplayEvent) => {
    // Strike distance for a stop-work start. An approach start's distance is from the advisory's last
    // update, not when it was issued, so it's left out; an all clear has none.
    const distance = event.kind === "stop_work_start" ? formatStrikeDistance(event.distance_mi) : null;
    return (
      <li key={event.id} className="pc-pop grid grid-cols-[auto_1fr_auto] items-center gap-2.5 py-1.5 text-[0.8125rem]">
        <span aria-hidden="true" className={`pc-shape ${EVENT[event.kind].mark}`} />
        <span className="min-w-0"><span className="font-semibold">{EVENT[event.kind].label}</span><span className="block truncate text-xs text-muted">{names.get(event.site_id) ?? event.site_id}{distance && ` · ${distance}`}</span></span>
        <time className="font-mono text-xs text-muted" dateTime={event.at}>{siteClock(Date.parse(event.at), zones.get(event.site_id))}</time>
      </li>
    );
  };

  return (
    <section data-theme="dark" aria-labelledby="replay-heading" className={`pc-reveal grid overflow-clip rounded-card bg-instrument text-text shadow-float lg:grid-cols-[minmax(0,1fr)_16rem] ${stale ? "grayscale" : ""}`}>
      <div className="grid min-w-0 gap-3 p-4">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 id="replay-heading" className="text-sm font-semibold">Storm replay</h2>
          <span className="pc-chip pc-chip--replay">REPLAY</span>
          <span className="text-xs text-muted">{replayWindowLabel(replay)}</span>
          <span className="ms-auto text-xs">
            <span className="text-muted">Replay </span><span className="font-mono font-semibold">{replayStops}</span> stop work{replayFlood ? <> · <span className="font-mono font-semibold">{replayFlood}</span> flood risk</> : ""}{stale ? " · last known" : ""}
          </span>
        </header>

        <div className="grid items-center gap-x-6 gap-y-3">
          <ReplayControl />
          <div className="grid min-w-0 gap-1">
            {/* Each marker selects its site (tap, click, or Enter / Space): the map flies to it and its row is
                highlighted. The tooltip only repeats the label; it is never the only way to learn the site. */}
            <div className="relative h-4 mbe-1" role={onSelectSite ? "group" : undefined} aria-label={onSelectSite ? "Storm events: select one to show its site" : undefined} aria-hidden={onSelectSite ? undefined : true}>
              {events.map((event) => {
                const label = `${EVENT[event.kind].label}, ${names.get(event.site_id) ?? event.site_id}, ${siteClock(Date.parse(event.at), zones.get(event.site_id))}`;
                const place = { insetInlineStart: `${at(span, Date.parse(event.at))}%` };
                return onSelectSite
                  ? <button key={event.id} type="button" title={label} aria-label={`Show ${label} on the map`} data-site={event.site_id} onClick={(click) => onSelectSite(click.detail > 0 ? nearestMarkerSite(click) ?? event.site_id : event.site_id)} style={place}
                    className="group/mark pc-pop absolute inset-bs-0 grid size-4 -translate-x-1/2 place-items-center rounded-pill after:absolute after:inset-[-6px] after:content-[''] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-text">
                    <span aria-hidden="true" className={`pc-shape ${EVENT[event.kind].mark} text-[0.75rem] motion-safe:transition-[scale] group-hover/mark:scale-125 group-active/mark:scale-90`} />
                  </button>
                  : <span key={event.id} title={label} className={`pc-shape pc-pop ${EVENT[event.kind].mark} absolute inset-bs-0.5 -translate-x-1/2 text-[0.75rem]`} style={place} />;
              })}
            </div>
            <div className="relative h-0.5 bg-instrument-line" role="progressbar" aria-label="Replay progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}
              aria-valuetext={timed ? `${clock(span.now, true)}, simulated` : `${Math.round(progress * 100)}% of storm data`}>
              {timed && Number.isFinite(tEnd) && <span className="absolute -inset-y-px inset-e-0 bg-[repeating-linear-gradient(90deg,transparent_0_3px,var(--pc-text-muted)_3px_5px)] opacity-60" style={{ insetInlineStart: `${at(span, tEnd)}%` }} />}
              <span className="absolute inset-y-0 inset-s-0 bg-text" style={{ inlineSize: `${progress * 100}%` }} />
              <span className="absolute -inset-y-1.5 w-0.5 -translate-x-1/2 bg-notice" style={{ insetInlineStart: `${progress * 100}%` }} />
            </div>
            {timed
              ? <div className="relative h-4 font-mono text-[0.6875rem] text-muted" aria-hidden="true">
                {ticks.map((tick, i) => <span key={tick} className={`absolute whitespace-nowrap ${i === 0 ? "" : i === ticks.length - 1 && at(span, tick) > 92 ? "-translate-x-full" : "-translate-x-1/2"}`} style={{ insetInlineStart: `${at(span, tick)}%` }}>{i === 0 ? clock(tick) : clock(tick).replace(/\s?[AP]M$/, "")}</span>)}
              </div>
              : <div className="flex justify-between text-[0.6875rem] text-muted"><span>Storm start</span><span>Storm end</span></div>}
            <p className="text-xs text-muted">
              {quiet ? "Quiet period: countdowns clearing" : timed ? `Storm data until ${clock(tEnd)}, then 31 quiet minutes` : `${Math.round(progress * 100)}% of storm data`}
              {replay && Number.isFinite(replay.files_total) && ` · ${replay.files_done}/${replay.files_total} files, ${(replay.flashes_ingested ?? 0).toLocaleString()} flashes`}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-6 gap-y-1 pbs-1">
          <figure className="grid gap-1.5">
            <figcaption className="flex justify-between gap-2 text-xs text-muted"><span>Flashes per 5 min</span>{bins.length > 0 && <span className="font-mono">peak {Math.max(...bins.map((bin) => bin.flashes)).toLocaleString()}</span>}</figcaption>
            {timed && <FlashBars bins={bins} span={span} />}
          </figure>
          <figure className="grid gap-1.5">
            <figcaption className="flex justify-between gap-2 text-xs text-muted"><span>Replay sites in stop-work</span>{bins.length > 0 && <span className="font-mono">now {bins.at(-1)!.sites_in_stop_work}</span>}</figcaption>
            {timed && <StopSteps bins={bins} span={span} />}
          </figure>
        </div>
      </div>

      <details ref={details} className="group min-w-0 border-bs border-instrument-line p-4 lg:border-bs-0 lg:border-s">
        <summary className="flex min-h-8 cursor-pointer list-none items-center justify-between gap-2">
          <span className="text-sm font-semibold">Key events</span>
          <span className="flex items-center gap-2 text-xs text-muted"><span className="font-mono">{timeline.events === null ? "…" : events.length}</span><span aria-hidden="true" className="motion-safe:transition-[rotate] group-open:rotate-180">▾</span></span>
        </summary>
        {events.length === 0
          ? <p className="mbs-2 text-xs text-muted">{timeline.preparing ? "Preparing replay timeline…" : timeline.events === null
            ? timeline.failed ? <>Couldn’t load the storm’s events. {timeline.retry && <button type="button" onClick={timeline.retry} className="pc-link font-semibold">Retry</button>}</> : "Loading the storm’s events…"
            : "No stop-work, advisory or all-clear yet."}</p>
          : <ol className="mbs-1 max-h-44 overflow-y-auto overscroll-contain">{[...events].reverse().map(eventRow)}</ol>}
      </details>
    </section>
  );
}
