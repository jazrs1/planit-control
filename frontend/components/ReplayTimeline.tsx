"use client";

import { useEffect, useRef } from "react";
import type { Alert, ReplayStatus, Site } from "@shared/types";
import ReplayControl from "@/components/ReplayControl";
import type { ReplayLog, ReplayLogEvent } from "@/lib/useReplayLog";

const EVENT = {
  stop: { label: "Stop work", mark: "pc-shape--stop", tone: "text-risk-red" },
  approach: { label: "Lightning possible", mark: "pc-shape--amber", tone: "text-risk-amber" },
  clear: { label: "All clear", mark: "pc-shape--green", tone: "text-risk-green" },
} as const;

function simTime(ms: number) {
  return new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
}

function FlashBars({ bins }: { bins: ReplayLog["flashBins"] }) {
  const max = Math.max(1, ...bins.map((bin) => bin.flashes));
  const slots = Math.max(12, bins.length);
  return <svg viewBox={`0 0 ${slots * 10} 48`} preserveAspectRatio="none" className="block h-10 w-full" aria-hidden="true">
    {bins.map((bin, i) => {
      const h = Math.max(1, (bin.flashes / max) * 46);
      return <rect key={bin.start} x={i * 10 + 1} y={48 - h} width={8} height={h} className="fill-text" />;
    })}
    <line x1="0" x2={slots * 10} y1="47.5" y2="47.5" className="stroke-border" strokeWidth="1" vectorEffect="non-scaling-stroke" />
  </svg>;
}

function StopSteps({ series }: { series: ReplayLog["stopSeries"] }) {
  if (series.length < 2) return <div className="h-10 border-be border-border" aria-hidden="true" />;
  const t0 = series[0].at, t1 = Math.max(series.at(-1)!.at, t0 + 1);
  const max = Math.max(4, ...series.map((point) => point.count));
  const x = (at: number) => ((at - t0) / (t1 - t0)) * 100;
  const y = (count: number) => 48 - (count / max) * 44;
  let d = `M0 ${y(series[0].count)}`;
  for (const point of series.slice(1)) d += ` H${x(point.at)} V${y(point.count)}`;
  return <svg viewBox="0 0 100 48" preserveAspectRatio="none" className="block h-10 w-full" aria-hidden="true">
    <path d={`${d} V48 H0 Z`} className="fill-risk-red-solid" opacity={0.85} />
    <path d={d} fill="none" className="stroke-text" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
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

/** The storm replay along the bottom of the map: controls, progress (it only plays forward, so no
 *  seeking), event markers, two small charts and the key events. Replay counts live here, never in
 *  the dashboard's real counts. */
export default function ReplayTimeline({ replay, alerts, sites, log, stale }: ReplayTimelineProps) {
  const running = replay?.running ?? false;
  const names = new Map(sites.map((site) => [site.id, site.name]));
  const replayStops = alerts.filter((alert) => alert.replay && alert.type === "lightning").length;
  const replayFlood = alerts.filter((alert) => alert.replay && alert.type === "flood").length;
  const progress = replay && replay.files_total > 0 ? Math.min(1, replay.files_done / replay.files_total) : 0;
  const quiet = running && progress >= 1;
  const hasLog = log.events.length > 0 || log.flashBins.length > 0;
  const details = useRef<HTMLDetailsElement>(null);
  // Key events start open on a wide screen and collapsed on a phone.
  useEffect(() => { if (details.current && window.matchMedia("(min-width: 64rem)").matches) details.current.open = true; }, []);
  const eventRow = (event: ReplayLogEvent) => (
    <li key={event.id} className="grid grid-cols-[auto_1fr_auto] items-center gap-2 py-1 text-[0.8125rem]">
      <span aria-hidden="true" className={`pc-shape ${EVENT[event.kind].mark}`} />
      <span className="min-w-0"><span className="font-extrabold">{EVENT[event.kind].label}</span><span className="block truncate text-xs text-muted">{names.get(event.site_id) ?? event.site_id}</span></span>
      <time className="font-mono text-xs text-muted" dateTime={new Date(event.at).toISOString()}>{simTime(event.at)}</time>
    </li>
  );

  return (
    <section aria-labelledby="replay-heading" className={`grid border-bs-2 border-rule bg-surface lg:grid-cols-[minmax(0,1fr)_17rem] ${stale ? "text-muted grayscale" : ""}`}>
      <div className="grid min-w-0 gap-2.5 p-3 lg:px-4">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 id="replay-heading" className="pc-label text-[0.8125rem]">Storm replay</h2>
          {(running || hasLog) && <span className="pc-chip pc-chip--replay">REPLAY</span>}
          <span className="text-xs text-muted">
            {running ? `${replay?.window ?? "Recorded storm"} · plays forward only` : hasLog ? "Replay ended · events seen on this page" : "A recorded storm played through the live pipeline on a simulated clock"}
          </span>
          {running && <span className="ms-auto text-xs font-bold tabular-nums">
            Replay: {replayStops} stop work{replayFlood ? ` · ${replayFlood} flood risk` : ""}{stale ? "?" : ""}
          </span>}
        </header>

        <div className="grid items-end gap-x-6 gap-y-3 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <ReplayControl />
          {(running || hasLog) && <div className="grid min-w-64 flex-1 gap-1.5">
            <div className="relative h-4" aria-hidden="true">
              {log.events.map((event) => <span key={event.id} title={`${EVENT[event.kind].label} · ${names.get(event.site_id) ?? event.site_id} · ${simTime(event.at)}`}
                className={`pc-shape ${EVENT[event.kind].mark} absolute inset-bs-0.5 -translate-x-1/2 text-[0.8rem]`} style={{ insetInlineStart: `${event.progress * 100}%` }} />)}
            </div>
            <div className="relative h-2 bg-surface-2" role="progressbar" aria-label="Replay progress, storm data ingested" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
              <span className="absolute inset-y-0 inset-s-0 bg-text" style={{ inlineSize: `${progress * 100}%` }} />
              <span className="absolute -inset-y-1.5 w-0.5 -translate-x-1/2 bg-notice" style={{ insetInlineStart: `${progress * 100}%` }} />
            </div>
            <div className="flex justify-between text-[0.6875rem] text-muted">
              <span>Storm start</span>
              <span className="font-semibold text-text">{quiet ? "Storm data done · quiet period, countdowns clearing" : `${Math.round(progress * 100)}% of storm data`}</span>
              <span>Storm end</span>
            </div>
          </div>}
        </div>

        {(running || hasLog) && <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          <figure className="grid gap-1">
            <figcaption className="pc-label text-muted">Flashes per 5 min</figcaption>
            <FlashBars bins={log.flashBins} />
          </figure>
          <figure className="grid gap-1">
            <figcaption className="pc-label text-muted">Replay sites in stop-work</figcaption>
            <StopSteps series={log.stopSeries} />
          </figure>
          <p className="col-span-2 text-[0.6875rem] text-muted">Since this page opened. The full storm history needs new API data (docs/design-data-needs.md).</p>
        </div>}
        </div>
      </div>

      <details ref={details} className="group min-w-0 border-bs-2 border-rule p-3 lg:border-bs-0 lg:border-s-2 lg:px-4">
        <summary className="flex min-h-8 cursor-pointer list-none items-center justify-between gap-2">
          <span className="pc-label text-[0.8125rem]">Key events</span>
          <span className="flex items-center gap-2 text-xs text-muted"><span className="font-mono">{log.events.length}</span><span aria-hidden="true" className="motion-safe:transition-[rotate] group-open:rotate-180">▾</span></span>
        </summary>
        {log.events.length === 0
          ? <p className="mbs-2 text-xs text-muted">{running ? "No stop-work, advisory or all-clear yet." : "Stop-work starts, lightning advisories and all-clears from a replay appear here."}</p>
          : <ol className="mbs-1 max-h-48 divide-y divide-border overflow-y-auto overscroll-contain">{[...log.events].reverse().map(eventRow)}</ol>}
      </details>
    </section>
  );
}
