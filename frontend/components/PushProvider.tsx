"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useAlertsState } from "@/components/AlertsProvider";
import { DEMO_DATA } from "@/lib/api";
import { DevicePush, INITIAL_PUSH_STATE } from "@/lib/push";
import type { DevicePushState, PushPreferences } from "@/lib/push";

type PushContextValue = DevicePushState & {
  enable: (preferences: PushPreferences) => Promise<void>;
  sendTest: () => Promise<void>;
  unsubscribe: () => Promise<void>;
};
const PushContext = createContext<PushContextValue | null>(null);

function PushModeProvider({ children, demo }: { children: ReactNode; demo: boolean }) {
  const [state, setState] = useState<DevicePushState>(() => demo ? {
    ...INITIAL_PUSH_STATE, phase: "demo", busy: false, restored: true,
    info: DEMO_DATA.pushSubscription,
    preferences: { site_ids: DEMO_DATA.pushSubscription.site_ids, role: DEMO_DATA.pushSubscription.role },
    message: "Demo data · sample registration. Exit demo mode to enable real device alerts.",
  } : INITIAL_PUSH_STATE);
  const client = useRef<DevicePush | null>(null);
  useEffect(() => {
    if (demo) return;
    const device = new DevicePush(setState);
    client.current = device;
    void device.initialize();
    return () => { device.dispose(); client.current = null; };
  }, [demo]);
  const value = useMemo<PushContextValue>(() => ({ ...state,
    enable: async (preferences) => { await client.current?.enable(preferences); },
    sendTest: async () => { await client.current?.sendTest(); },
    unsubscribe: async () => { await client.current?.unsubscribe(); },
  }), [state]);
  return <PushContext.Provider value={value}>{children}</PushContext.Provider>;
}

export function PushProvider({ children }: { children: ReactNode }) {
  const demo = useAlertsState().status === "demo";
  return <PushModeProvider key={demo ? "demo" : "live"} demo={demo}>{children}</PushModeProvider>;
}

export function useDevicePush() {
  const value = useContext(PushContext);
  if (!value) throw new Error("useDevicePush must be used inside PushProvider");
  return value;
}
