"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { readViewMode, writeViewMode } from "@/lib/viewMode";
import type { ViewMode } from "@/lib/viewMode";

type ViewModeState = { mode: ViewMode; setMode: (mode: ViewMode) => void };

const ViewModeContext = createContext<ViewModeState>({ mode: "live", setMode: () => {} });

/** This device's view mode (Live by default), remembered on the device. */
export function ViewModeProvider({ children }: { children: ReactNode }) {
  // Live on the server and on first paint; the stored mode is read after hydration.
  const [mode, setModeState] = useState<ViewMode>("live");
  useEffect(() => { setModeState(readViewMode()); }, []);
  const setMode = useCallback((next: ViewMode) => { setModeState(next); writeViewMode(next); }, []);
  return <ViewModeContext.Provider value={{ mode, setMode }}>{children}</ViewModeContext.Provider>;
}

export function useViewMode() {
  return useContext(ViewModeContext);
}
