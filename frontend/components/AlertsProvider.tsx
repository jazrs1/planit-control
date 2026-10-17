"use client";

import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { Alert } from "@shared/types";
import { getAlerts } from "@/lib/api";

const AlertsContext = createContext<Alert[] | null>(null);

function newestFirst(alerts: Alert[]) {
  return [...alerts].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
}

export function AlertsProvider({ initialAlerts, children }: { initialAlerts: Alert[]; children: ReactNode }) {
  const [alerts, setAlerts] = useState(() => newestFirst(initialAlerts));

  useEffect(() => {
    let disposed = false;
    let pending = false;

    async function refresh() {
      if (pending) return;
      pending = true;
      try {
        const next = await getAlerts();
        if (!disposed) setAlerts(newestFirst(next));
      } finally {
        pending = false;
      }
    }

    function onVisible() {
      if (!document.hidden) void refresh();
    }

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

  return <AlertsContext.Provider value={alerts}>{children}</AlertsContext.Provider>;
}

export function useAlerts() {
  const alerts = useContext(AlertsContext);
  if (alerts === null) throw new Error("useAlerts must be used inside AlertsProvider");
  return alerts;
}
