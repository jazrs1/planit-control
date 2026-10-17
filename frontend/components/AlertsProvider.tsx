"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { Alert } from "@shared/types";
import { getAlerts, getReplayStatus } from "@/lib/api";

/** The backend's clock: real time normally, the simulated replay clock while a replay runs. */
type ServerClock = { simulatedMs: number; fetchedAtMs: number; speed: number } | null;

type AlertsState = { alerts: Alert[]; staleSince: Date | null; clock: ServerClock };

const AlertsContext = createContext<AlertsState | null>(null);

function newestFirst(alerts: Alert[]) {
  return [...alerts].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
}

async function fetchClock(): Promise<ServerClock> {
  try {
    const status = await getReplayStatus();
    if (!status.running || !status.simulated_now || !status.speed) return null;
    return { simulatedMs: Date.parse(status.simulated_now), fetchedAtMs: Date.now(), speed: status.speed };
  } catch {
    return null; // replay status unavailable: assume real time
  }
}

export function AlertsProvider({ initialAlerts, children }: { initialAlerts: Alert[]; children: ReactNode }) {
  const [state, setState] = useState<AlertsState>(() => ({ alerts: newestFirst(initialAlerts), staleSince: null, clock: null }));

  useEffect(() => {
    let disposed = false;
    let pending = false;
    let lastGood = new Date();

    async function refresh() {
      if (pending) return;
      pending = true;
      try {
        // No mock fallback: a backend blip must never show mock STOP WORK alerts.
        const [next, clock] = await Promise.all([getAlerts({ fallbackToMocks: false }), fetchClock()]);
        lastGood = new Date();
        if (!disposed) setState({ alerts: newestFirst(next), staleSince: null, clock });
      } catch {
        // Keep the last real alerts and say they may be out of date.
        if (!disposed) setState((prev) => ({ ...prev, staleSince: lastGood }));
      } finally {
        pending = false;
      }
    }

    function onVisible() {
      if (!document.hidden) void refresh();
    }

    void refresh(); // pick up the replay clock right away
    const interval = window.setInterval(() => void refresh(), 15_000);
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return <AlertsContext.Provider value={state}>{children}</AlertsContext.Provider>;
}

function useAlertsState() {
  const state = useContext(AlertsContext);
  if (state === null) throw new Error("useAlerts must be used inside AlertsProvider");
  return state;
}

export function useAlerts() {
  return useAlertsState().alerts;
}

/** When the alerts last refreshed successfully, if the latest refresh failed; otherwise null. */
export function useAlertsStaleSince() {
  return useAlertsState().staleSince;
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
