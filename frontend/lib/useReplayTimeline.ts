"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReplayEvent, ReplaySeries } from "@shared/types";
import { NotReadyError, getReplayEvents, getReplaySeries } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";

export type ReplayTimelineData = {
  /** The run's events, oldest first; null until the first answer. */
  events: ReplayEvent[] | null;
  series: ReplaySeries | null;
  /** The last refresh failed (not a 503 "not ready", which is retried quietly): show last known. */
  failed: boolean;
  /** The server is still preparing this window's timeline (503) and nothing has arrived yet. */
  preparing: boolean;
};

const EMPTY: ReplayTimelineData = { events: null, series: null, failed: false, preparing: false };

/** The replay's events and 5-minute series, refreshed every `ms` while a replay runs (null pauses).
 *  A 503 while the server prepares the window's timeline is retried quietly after its Retry-After; the
 *  timeline just stays empty until the data is ready. A new window starts from scratch. */
export function useReplayTimeline(window: string | null, ms: number | null): ReplayTimelineData {
  const [data, setData] = useState<ReplayTimelineData>(EMPTY);
  const notBefore = useRef(0);
  const current = useRef(window);
  useEffect(() => { current.current = window; setData(EMPTY); notBefore.current = 0; }, [window]);

  const poll = useCallback(async () => {
    if (Date.now() < notBefore.current) return;
    const asked = current.current;
    const [events, series] = await Promise.allSettled([getReplayEvents(), getReplaySeries()]);
    if (asked !== current.current) return;
    const notReady = [events, series].flatMap((r) => r.status === "rejected" && r.reason instanceof NotReadyError ? [r.reason.retryAfterMs] : []);
    if (notReady.length) notBefore.current = Date.now() + Math.max(...notReady);
    setData((previous) => {
      const next = {
        events: events.status === "fulfilled" ? events.value : previous.events,
        series: series.status === "fulfilled" ? series.value : previous.series,
        failed: [events, series].some((r) => r.status === "rejected" && !(r.reason instanceof NotReadyError)),
      };
      return { ...next, preparing: notReady.length > 0 && next.events === null };
    });
  }, []);
  usePolling(poll, ms);
  return data;
}
