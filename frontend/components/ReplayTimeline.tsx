"use client";

import { useEffect, useRef } from "react";
import type { Alert, ReplayStatus, Site } from "@shared/types";
import ReplayControl from "@/components/ReplayControl";
import type { ReplayLog, ReplayLogEvent } from "@/lib/useReplayLog";

const EVENT = {
  stop: { label: "Stop work", mark: "pc-shape--stop" },
  approach: { label: "Lightning possible", mark: "pc-shape--amber" },
  clear: { label: "All clear", mark: "pc-shape--green" },
} as const;

function simTime(ms: number) {
  return new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
}

/** Repeatable pseudo-random numbers, so particles don't jump on every render. */
function noise(seed: number) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/** Flashes as particles along the track: more flashes between two polls, more dots at that point. */
function FlashParticles({ trail }: { trail: ReplayLog["trail"] }) {
  const dots = trail.flatMap((point, i) => Array.from({ length: Math.min(9, Math.ceil(point.flashes / 30)) }, (_, j) => ({
    key: `${i}-${j}`,
    x: Math.max(0, Math.min(100, point.progress * 100 - noise(i * 31 + j) * 1.6)),
    y: 10 + noise(i * 17 + j * 7) * 80,
    o: 0.35 + noise(i * 7 + j * 13) * 0.65,
  })));
  return <div aria-hidden="true" className="relative h-7">
    {dots.map((dot) => <span key={dot.key} className="absolute size-[3px] -translate-1/2 rounded-pill bg-lightning shadow-[0_0_4px_var(--pc-lightning)]"
      style={{ insetInlineStart: `${dot.x}%`, insetBlockStart: `${dot.y}%`, opacity: dot.o }} />)}
  </div>;
}

/** Quiet bars, one color, no axes beyond a baseline. */
function FlashBars({ bins }: { bins: ReplayLog["flashBins"] }) {
  const max = Math.max(1, ...bins.map((bin) => bin.flashes));
  const slots = Math.max(18, bins.length);
  return <svg viewBox={`0 0 ${slots * 10} 40`} preserveAspectRatio="none" className="block h-9 w-full" aria-hidden="true">
    {bins.map((bin, i) => {
      const h = Math.max(1, (bin.flashes / max) * 38);
      return <rect key={bin.start} x={i * 10 + 3.5} y={40 - h} width={3} height={h} className="fill-muted" />;
    })}
    <line x1="0" x2={slots * 10} y1="39.5" y2="39.5" className="stroke-instrument-line" strokeWidth="1" vectorEffect="non-scaling-stroke" />
  </svg>;
}

/** A thin step line, same color as the bars. */
function StopSteps({ series }: { series: ReplayLog["stopSeries"] }) {
  const baseline = <line x1="0" x2="100" y1="39.5" y2="39.5" className="stroke-instrument-line" strokeWidth="1" vectorEffect="non-scaling-stroke" />;
  if (series.length < 2) return <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="block h-9 w-full" aria-hidden="true">{baseline}</svg>;
  const t0 = series[0].at, t1 = Math.max(series.at(-1)!.at, t0 + 1);
  const max = Math.max(4, ...series.map((point) => point.count));
  const x = (at: number) => ((at - t0) / (t1 - t0)) * 100;
  const y = (count: number) => 39 - (count / max) * 36;
  let d = `M0 ${y(series[0].count)}`;
  for (const point of series.slice(1)) d += ` H${x(point.at)} V${y(point.count)}`;
  return <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="block h-9 w-full" aria-hidden="true">
    {baseline}
    <path d={d} fill="none" className="stroke-muted" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
  </svg>;
}

type ReplayTimelineProps = {
  replay: ReplayStatus | null;
  alerts: Alert[];
  sites: Site[];
  log: ReplayLog;
  /** The connection dropped: the replay may have ended; everything here is last known. */
  stale: boolean;
};

/** The storm replay instrument: the one dark panel on the light page, so a replay can never be mistaken
 *  for a real stop-work. Controls, forward-only progress (no seeking), event markers, flash particles,
 *  two quiet charts and the key events. Replay counts live here, never in the dashboard's real counts. */
export default function ReplayTimeline({ replay, alerts, sites, log, stale }: ReplayTimelineProps) {
  const running = replay?.running ?? false;
  const names = new Map(sites.map((site) => [site.id, site.name]));
  const replayStops = alerts.filter((alert) => alert.replay && alert.type === "lightning").length;
  const replayFlood = alerts.filter((alert) => alert.replay && alert.type === "flood").length;
  const progress = replay && replay.files_total > 0 ? Math.min(1, replay.files_done / replay.files_total) : 0;
  const quiet = running && progress >= 1;
  const hasLog = log.events.length > 0 || log.flashBins.length > 0;
  const active = running || hasLog;
  const details = useRef<HTMLDetailsElement>(null);
  // Key events start open on a wide screen and collapsed on a phone.
  useEffect(() => { if (details.current && window.matchMedia("(min-width: 64rem)").matches) details.current.open = true; }, []);
  const eventRow = (event: ReplayLogEvent) => (
    <li key={event.id} className="grid grid-cols-[auto_1fr_auto] items-center gap-2.5 py-1.5 text-[0.8125rem]">
      <span aria-hidden="true" className={`pc-shape ${EVENT[event.kind].mark}`} />
      <span className="min-w-0"><span className="font-semibold">{EVENT[event.kind].label}</span><span className="block truncate text-xs text-muted">{names.get(event.site_id) ?? event.site_id}</span></span>
      <time className="font-mono text-xs text-muted" dateTime={new Date(event.at).toISOString()}>{simTime(event.at)}</time>
    </li>
  );

  return (
    <section data-theme="dark" aria-labelledby="replay-heading" className={`grid bg-instrument text-text shadow-float lg:grid-cols-[minmax(0,1fr)_16rem] ${stale ? "grayscale" : ""}`}>
      <div className="grid min-w-0 gap-3 p-4">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 id="replay-heading" className="text-sm font-bold">Storm replay</h2>
          {active && <span className="pc-chip pc-chip--replay">REPLAY</span>}
          <span className="font-mono text-xs text-muted">
            {running ? `${replay?.window ?? "Recorded storm"} · forward only` : hasLog ? "Ended · events seen on this page" : "A recorded storm through the live pipeline, on a simulated clock"}
          </span>
          {running && <span className="ms-auto font-mono text-xs">
            <span className="text-muted">Replay </span>{replayStops} stop work{replayFlood ? ` · ${replayFlood} flood risk` : ""}{stale ? "?" : ""}
          </span>}
        </header>

        <div className="grid items-center gap-x-6 gap-y-3 xl:grid-cols-[auto_minmax(0,1fr)]">
          <ReplayControl />
          {active && <div className="grid min-w-0 gap-1">
            <div className="relative h-4" aria-hidden="true">
              {log.events.map((event) => <span key={event.id} title={`${EVENT[event.kind].label} · ${names.get(event.site_id) ?? event.site_id} · ${simTime(event.at)}`}
                className={`pc-shape ${EVENT[event.kind].mark} absolute inset-bs-0.5 -translate-x-1/2 text-[0.75rem]`} style={{ insetInlineStart: `${event.progress * 100}%` }} />)}
            </div>
            <div className="relative h-0.5 bg-instrument-line" role="progressbar" aria-label="Replay progress, storm data ingested" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
              <span className="absolute inset-y-0 inset-s-0 bg-text" style={{ inlineSize: `${progress * 100}%` }} />
              <span className="absolute -inset-y-1.5 w-0.5 -translate-x-1/2 bg-notice" style={{ insetInlineStart: `${progress * 100}%` }} />
            </div>
            <FlashParticles trail={log.trail} />
            <div className="flex justify-between gap-3 font-mono text-[0.6875rem] text-muted">
              <span>Storm start</span>
              <span>Storm end</span>
            </div>
            <p className="font-mono text-xs">{quiet ? "Storm data done · quiet period, countdowns clearing" : `${Math.round(progress * 100)}% of storm data`}</p>
          </div>}
        </div>

        {active && <div className="grid grid-cols-2 gap-x-6 gap-y-1 border-bs border-instrument-line pbs-3">
          <figure className="grid gap-1.5">
            <figcaption className="text-xs text-muted">Flashes per 5 min</figcaption>
            <FlashBars bins={log.flashBins} />
          </figure>
          <figure className="grid gap-1.5">
            <figcaption className="text-xs text-muted">Replay sites in stop-work</figcaption>
            <StopSteps series={log.stopSeries} />
          </figure>
          <p className="col-span-2 text-[0.6875rem] text-muted">Since this page opened. The full storm history needs new API data (docs/design-data-needs.md).</p>
        </div>}
      </div>

      <details ref={details} className="group min-w-0 border-bs border-instrument-line p-4 lg:border-bs-0 lg:border-s">
        <summary className="flex min-h-8 cursor-pointer list-none items-center justify-between gap-2">
          <span className="text-sm font-bold">Key events</span>
          <span className="flex items-center gap-2 text-xs text-muted"><span className="font-mono">{log.events.length}</span><span aria-hidden="true" className="motion-safe:transition-[rotate] group-open:rotate-180">▾</span></span>
        </summary>
        {log.events.length === 0
          ? <p className="mbs-2 text-xs text-muted">{running ? "No stop-work, advisory or all-clear yet." : "Stop-work starts, lightning advisories and all-clears from a replay appear here."}</p>
          : <ol className="mbs-1 max-h-44 divide-y divide-instrument-line overflow-y-auto overscroll-contain">{[...log.events].reverse().map(eventRow)}</ol>}
      </details>
    </section>
  );
}
