"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Alert } from "@shared/types";
import { useAlertsState, useServerNow } from "@/components/AlertsProvider";

export default function StopWorkCountdown({ all_clear_at, replay, prominent = false }: Pick<Alert, "all_clear_at"> & Partial<Pick<Alert, "replay">> & { prominent?: boolean }) {
  // Start with a placeholder so the server and hydration render agree.
  const [now, setNow] = useState<number | null>(null);
  const [resetting, setResetting] = useState(false);
  // Backend clock, so replayed alerts count down in simulated time (and at replay speed). A real
  // alert shown during a replay (replay === false) counts down on real time.
  const backendNow = useServerNow();
  const alertsState = useAlertsState();
  const realDuringReplay = replay === false && alertsState.replay?.running === true;
  const serverNow = useCallback(() => (realDuringReplay ? Date.now() : backendNow()), [realDuringReplay, backendNow]);
  // Offline (last known alerts): reaching zero can't confirm the all-clear; a new strike may have reset it.
  const offline = alertsState.status === "stale";
  const previousTarget = useRef(all_clear_at === null ? null : Date.parse(all_clear_at));
  const target = all_clear_at === null ? null : Date.parse(all_clear_at);

  useEffect(() => {
    const nextTarget = all_clear_at === null ? null : Date.parse(all_clear_at);
    const previous = previousTarget.current;
    const extended =
      nextTarget !== null && previous !== null && nextTarget > previous;
    previousTarget.current = nextTarget;

    setNow(serverNow());
    setResetting(extended);
    const flash = extended ? window.setTimeout(() => setResetting(false), 1200) : null;
    const tick = nextTarget !== null && Number.isFinite(nextTarget)
      ? window.setInterval(() => setNow(serverNow()), 1000)
      : null;

    return () => {
      if (tick !== null) window.clearInterval(tick);
      if (flash !== null) window.clearTimeout(flash);
    };
  }, [all_clear_at, serverNow]);

  const seconds = target !== null && Number.isFinite(target) && now !== null
    ? Math.max(0, Math.ceil((target - now) / 1000))
    : null;
  const unconfirmed = offline;
  const cleared = seconds === 0 && !offline;
  const label = target === null
    ? "Awaiting all-clear"
    : !Number.isFinite(target)
      ? "All-clear time unavailable"
      : unconfirmed
        ? "Not confirmed"
        : cleared
        ? "All clear"
        : seconds === null
          ? "--:--"
          : `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

  return (
    <div className={`${prominent ? "px-4 py-3" : "border-2 border-current px-3 py-2"} ${cleared ? "bg-risk-green-bg text-risk-green" : "bg-surface text-risk-red"} ${resetting ? "stop-work-reset" : ""}`}>
      <span className="pc-label block">
        {target === null ? "Stop-work status" : "All-clear countdown"}
      </span>
      <span role="timer" aria-live="off" className={`block font-mono ${prominent ? "text-timer leading-none" : "text-2xl leading-tight"} font-bold tabular-nums`}>
        {label}
      </span>
      <span role="status" className={resetting || unconfirmed ? "block text-sm font-semibold" : "sr-only"}>
        {resetting ? "New strike — timer reset" : unconfirmed ? "All clear not confirmed: connection lost" : cleared ? "All clear" : ""}
      </span>
    </div>
  );
}
