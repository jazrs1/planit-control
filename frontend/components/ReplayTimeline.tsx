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

/** Quiet bars on the window's time axis, one color, a baseline and nothing else. */
function FlashBars({ bins, span }: { bins: ReplaySeriesBin[]; span: Span }) {
  const max = Math.max(1, ...bins.map((bin) => bin.flashes));
  const slot = (BIN_MS / (span.t1 - span.t0)) * 100;
  return <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="block h-9 w-full" aria-hidden="true">
    {bins.map((bin) => {
      const h = Math.max(0.5, (bin.flashes / max) * 38);
      return <rect key={bin.start} x={at(span, Date.parse(bin.start)) + slot * 0.3} y={40 - h} width={slot * 0.4} height={h} className="fill-muted" />;
    })}
    <line x1="0" x2="100" y1="39.5" y2="39.5" className="stroke-instrument-line" strokeWidth="1" vectorEffect="non-scaling-stroke" />
  </svg>;
}

/** A thin step line of sites in stop-work at the end of each bin, same color as the bars. */
function StopSteps({ bins, span }: { bins: ReplaySeriesBin[]; span: Span }) {
  const max = Math.max(4, ...bins.map((bin) => bin.sites_in_stop_work));
  const y = (count: number) => 39 - (count / max) * 36;
  let d = "";
  bins.forEach((bin, i) => {
    const start = at(span, Date.parse(bin.start)), end = at(span, Math.min(Date.parse(bin.start) + BIN_MS, span.now));
    d += `${i ? "L" : "M"}${start} ${y(bin.sites_in_stop_work)} H${end} `;
  });
  return <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="block h-9 w-full" aria-hidden="true">
    <line x1="0" x2="100" y1="39.5" y2="39.5" className="stroke-instrument-line" strokeWidth="1" vectorEffect="non-scaling-stroke" />
    {d && <path d={d} fill="none" className="stroke-muted" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />}
  </svg>;
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
};

/** The storm replay instrument: the one dark panel on the light page, so a replay can never be mistaken
 *  for a real stop-work. Controls, forward-only progress (no seeking), event markers, flash particles,
 *  two quiet charts and the key events. Replay counts live here, never in the dashboard's real counts. */
export default function ReplayTimeline({ replay, alerts, sites, timeline, nowMs, stale }: ReplayTimelineProps) {
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

  if (!running) {
    return (
      <section data-theme="dark" aria-labelledby="replay-heading" className="pc-reveal flex flex-wrap items-center gap-x-4 gap-y-2 bg-instrument px-4 py-2.5 text-text shadow-float">
        <h2 id="replay-heading" className="text-sm font-bold">Storm replay</h2>
        <p className="min-w-0 flex-1 basis-56 text-xs text-muted sm:truncate">{replayWindowLabel(replay)} · plays a recorded storm through the live pipeline</p>
        <ReplayControl />
      </section>
    );
  }

  const eventRow = (event: ReplayEvent) => {
    // Strike distance for a stop-work start. An approach start's distance is from the advisory's last
    // update, not when it was issued, so it's left out; an all clear has none.
    const distance = event.kind === "stop_work_start" ? formatStrikeDistance(event.distance_mi) : null;
    return (
      <li key={event.id} className="grid grid-cols-[auto_1fr_auto] items-center gap-2.5 py-1.5 text-[0.8125rem]">
        <span aria-hidden="true" className={`pc-shape ${EVENT[event.kind].mark}`} />
        <span className="min-w-0"><span className="font-semibold">{EVENT[event.kind].label}</span><span className="block truncate text-xs text-muted">{names.get(event.site_id) ?? event.site_id}{distance && ` · ${distance}`}</span></span>
        <time className="font-mono text-xs text-muted" dateTime={event.at}>{siteClock(Date.parse(event.at), zones.get(event.site_id))}</time>
      </li>
    );
  };

  return (
    <section data-theme="dark" aria-labelledby="replay-heading" className={`pc-reveal grid bg-instrument text-text shadow-float lg:grid-cols-[minmax(0,1fr)_16rem] ${stale ? "grayscale" : ""}`}>
      <div className="grid min-w-0 gap-3 p-4">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 id="replay-heading" className="text-sm font-bold">Storm replay</h2>
          <span className="pc-chip pc-chip--replay">REPLAY</span>
          <span className="text-xs text-muted">{replayWindowLabel(replay)}</span>
          <span className="ms-auto text-xs">
            <span className="text-muted">Replay </span><span className="font-mono font-semibold">{replayStops}</span> stop work{replayFlood ? <> · <span className="font-mono font-semibold">{replayFlood}</span> flood risk</> : ""}{stale ? " · last known" : ""}
          </span>
        </header>

        <div className="grid items-center gap-x-6 gap-y-3 xl:grid-cols-[auto_minmax(0,1fr)]">
          <ReplayControl />
          <div className="grid min-w-0 gap-1">
            <div className="relative h-4 mbe-1" aria-hidden="true">
              {events.map((event) => <span key={event.id} title={`${EVENT[event.kind].label} · ${names.get(event.site_id) ?? event.site_id} · ${siteClock(Date.parse(event.at), zones.get(event.site_id))}`}
                className={`pc-shape ${EVENT[event.kind].mark} absolute inset-bs-0.5 -translate-x-1/2 text-[0.75rem]`} style={{ insetInlineStart: `${at(span, Date.parse(event.at))}%` }} />)}
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
              {replay && Number.isFinite(replay.files_total) && ` · ${replay.files_done}/${replay.files_total} files · ${(replay.flashes_ingested ?? 0).toLocaleString()} flashes`}
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
          <span className="text-sm font-bold">Key events</span>
          <span className="flex items-center gap-2 text-xs text-muted"><span className="font-mono">{timeline.events === null ? "…" : events.length}</span><span aria-hidden="true" className="motion-safe:transition-[rotate] group-open:rotate-180">▾</span></span>
        </summary>
        {events.length === 0
          ? <p className="mbs-2 text-xs text-muted">{timeline.preparing ? "Preparing replay timeline…" : timeline.events === null ? "Loading the storm’s events…" : "No stop-work, advisory or all-clear yet."}</p>
          : <ol className="mbs-1 max-h-44 overflow-y-auto overscroll-contain">{[...events].reverse().map(eventRow)}</ol>}
      </details>
    </section>
  );
}
