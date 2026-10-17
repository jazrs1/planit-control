"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Alert, ReplayStatus } from "@shared/types";
import { DEMO_DATA, getAlerts, getReplayStatus } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";

/** The backend's clock: real time normally, the simulated replay clock while a replay runs. */
type ServerClock = { simulatedMs: number; fetchedAtMs: number; speed: number } | null;

/**
 * connecting:  no alerts loaded yet. unreachable: no alerts loaded and the last try failed.
 * live:        alerts are current.  stale:       showing the last real alerts; the latest refresh failed.
 * demo:        showing shared/mocks because the user asked for demo data.
 */
export type AlertsStatus = "connecting" | "unreachable" | "live" | "stale" | "demo";

type AlertsState = {
  /** null until real alerts load: unknown, never "no alerts". */
  alerts: Alert[] | null;
  status: AlertsStatus;
  staleSince: Date | null;
  clock: ServerClock;
  replay: ReplayStatus | null;
};

type AlertsContextValue = AlertsState & {
  /** Refetch alerts and replay status now (e.g. right after starting or stopping a replay). */
  refresh: () => Promise<void>;
  setDemo: (on: boolean) => void;
};

const AlertsContext = createContext<AlertsContextValue | null>(null);

// Refresh cadence. Replay compresses an hour into minutes, so poll fast while it runs.
const REPLAY_MS = 3_000;
const LIVE_MS = 30_000;
const RETRY_MS = 5_000;

function newestFirst(alerts: Alert[]) {
  return [...alerts].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
}

function clockFrom(status: ReplayStatus | null): ServerClock {
  if (!status?.running || !status.simulated_now || !status.speed) return null;
  return { simulatedMs: Date.parse(status.simulated_now), fetchedAtMs: Date.now(), speed: status.speed };
}

const UNKNOWN: AlertsState = { alerts: null, status: "connecting", staleSince: null, clock: null, replay: null };

export function AlertsProvider({ initialAlerts, children }: { initialAlerts: Alert[] | null; children: ReactNode }) {
  const [state, setState] = useState<AlertsState>(() =>
    initialAlerts === null ? UNKNOWN : { ...UNKNOWN, alerts: newestFirst(initialAlerts), status: "live" },
  );
  const demo = useRef(false);
  const lastGood = useRef<Date | null>(initialAlerts === null ? null : new Date());

  const refresh = useCallback(async () => {
    if (demo.current) return;
    const [alerts, replay] = await Promise.allSettled([getAlerts(), getReplayStatus()]);
    if (demo.current) return; // demo turned on while this was in flight
    setState((prev) => {
      // Replay status is optional: if it fails, assume the last known replay state.
      const nextReplay = replay.status === "fulfilled" ? replay.value : prev.replay;
      const clock = replay.status === "fulfilled" ? clockFrom(replay.value) : prev.clock;
      if (alerts.status === "fulfilled") {
        lastGood.current = new Date();
        return { alerts: newestFirst(alerts.value), status: "live", staleSince: null, clock, replay: nextReplay };
      }
      // Never swap in mocks: keep the last real alerts and say they may be out of date.
      return prev.alerts === null
        ? { ...prev, status: "unreachable", clock, replay: nextReplay }
        : { ...prev, status: "stale", staleSince: lastGood.current, clock, replay: nextReplay };
    });
  }, []);

  const setDemo = useCallback((on: boolean) => {
    demo.current = on;
    lastGood.current = null;
    setState(on ? { ...UNKNOWN, alerts: newestFirst(DEMO_DATA.alerts), status: "demo" } : UNKNOWN);
  }, []);

  const loaded = state.alerts !== null && state.status !== "demo";
  const pollMs = state.status === "demo" ? null : !loaded ? RETRY_MS : state.replay?.running ? REPLAY_MS : LIVE_MS;
  usePolling(refresh, pollMs);

  const value = useMemo(() => ({ ...state, refresh, setDemo }), [state, refresh, setDemo]);
  return <AlertsContext.Provider value={value}>{children}</AlertsContext.Provider>;
}

/** The one alerts state shared by the nav badge, the dashboard and /alerts, so they always agree. */
export function useAlertsState() {
  const state = useContext(AlertsContext);
  if (state === null) throw new Error("useAlertsState must be used inside AlertsProvider");
  return state;
}

/** Current time in ms on the backend's clock. Countdowns must use this, not Date.now(), so they
 *  run on the simulated clock (and at its speed) during replay. */
export function useServerNow() {
  const { clock } = useAlertsState();
  return useCallback(
    () => (clock ? clock.simulatedMs + (Date.now() - clock.fetchedAtMs) * clock.speed : Date.now()),
    [clock],
  );
}
