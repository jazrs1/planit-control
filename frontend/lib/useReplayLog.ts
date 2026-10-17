"use client";

import { useEffect, useRef, useState } from "react";
import type { Alert, ReplayStatus, Site } from "@shared/types";

/** One event on the replay timeline. Times are simulated (the replay clock). */
export type ReplayLogEvent = {
  id: string;
  kind: "stop" | "approach" | "clear";
  site_id: string;
  at: number;
  /** Share of the storm's GLM files ingested when the event was seen (0 to 1), for the track marker. */
  progress: number;
};

export type ReplayLog = {
  events: ReplayLogEvent[];
  /** Flashes ingested per 5 simulated minutes, from the change in flashes_ingested between polls. */
  flashBins: { start: number; flashes: number }[];
  /** Flashes ingested between polls, at the replay's progress then: drawn as particles along the track. */
  trail: { progress: number; flashes: number }[];
  /** Replay stop-work sites at each poll. */
  stopSeries: { at: number; count: number }[];
  /** The replay this log belongs to (its window), or null before one is seen. */
  window: string | null;
};

const BIN_MS = 5 * 60_000;
const REPLAY_CLOCK_MS = 3 * 60 * 60_000;
const EMPTY: ReplayLog = { events: [], flashBins: [], trail: [], stopSeries: [], window: null };

/**
 * The API has no replay event list or time series yet (docs/design-data-needs.md). Until it does, the
 * dashboard logs what it sees on each poll: replay stop-work alerts starting and ending, approach
 * advisories starting, and the flash total growing. It's real data, but only from when this page was
 * opened, and the UI says so.
 */
export function useReplayLog(replay: ReplayStatus | null, alerts: Alert[] | null, sites: Site[] | null): ReplayLog {
  const [log, setLog] = useState<ReplayLog>(EMPTY);
  const seen = useRef({ stops: new Map<string, string>(), approaches: new Set<string>(), flashes: null as number | null, files: -1, run: "" });

  useEffect(() => {
    if (!replay?.running || !replay.simulated_now) return;
    const now = Date.parse(replay.simulated_now);
    if (!Number.isFinite(now)) return;
    const memory = seen.current;
    const run = replay.window ?? "replay";
    // A new run (another window, or the file count went back) starts a fresh log.
    const fresh = memory.run !== run || replay.files_done < memory.files;
    if (fresh) Object.assign(memory, { stops: new Map(), approaches: new Set(), flashes: null, run });
    memory.files = replay.files_done;
    const progress = replay.files_total > 0 ? Math.min(1, replay.files_done / replay.files_total) : 0;
    const events: ReplayLogEvent[] = [];

    const stops = new Map((alerts ?? []).filter((alert) => alert.replay && alert.type === "lightning").map((alert) => [alert.id, alert.site_id]));
    if (alerts !== null) {
      for (const [id, site_id] of stops) {
        if (memory.stops.has(id)) continue;
        const alert = alerts.find((a) => a.id === id)!;
        const at = Date.parse(alert.started_at);
        events.push({ id: `stop-${id}`, kind: "stop", site_id, at: Number.isFinite(at) ? at : now, progress });
      }
      for (const [id, site_id] of memory.stops) if (!stops.has(id)) events.push({ id: `clear-${id}`, kind: "clear", site_id, at: now, progress });
      memory.stops = stops;
    }
    for (const site of sites ?? []) {
      const approach = site.lightning_approach;
      if (!approach) continue;
      const at = Date.parse(approach.issued_at);
      // Real and replay advisories arrive merged with no replay flag (docs/design-data-needs.md); a
      // replay one is issued on the replay clock, so it's within hours of simulated now, not today.
      if (!Number.isFinite(at) || Math.abs(at - now) > REPLAY_CLOCK_MS) continue;
      const key = `${site.id}@${approach.issued_at}`;
      if (memory.approaches.has(key)) continue;
      memory.approaches.add(key);
      events.push({ id: `approach-${key}`, kind: "approach", site_id: site.id, at, progress });
    }
    const delta = memory.flashes === null ? null : Math.max(0, replay.flashes_ingested - memory.flashes);
    memory.flashes = replay.flashes_ingested;

    setLog((previous) => {
      const base = fresh ? { ...EMPTY, window: run } : previous;
      const flashBins = [...base.flashBins];
      if (delta !== null) {
        const start = Math.floor(now / BIN_MS) * BIN_MS;
        const last = flashBins.at(-1);
        if (last?.start === start) flashBins[flashBins.length - 1] = { start, flashes: last.flashes + delta };
        else flashBins.push({ start, flashes: delta });
      }
      const stopSeries = alerts === null ? base.stopSeries : [...base.stopSeries, { at: now, count: stops.size }];
      const trail = delta === null || delta === 0 ? base.trail : [...base.trail, { progress, flashes: delta }];
      return { window: run, flashBins, trail, stopSeries, events: [...base.events, ...events].sort((a, b) => a.at - b.at) };
    });
  }, [replay, alerts, sites]);

  return log;
}
