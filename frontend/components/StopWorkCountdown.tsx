"use client";

import { useEffect, useRef, useState } from "react";
import type { Alert } from "@shared/types";
import { useAlertsState, useServerNow } from "@/components/AlertsProvider";

export default function StopWorkCountdown({ all_clear_at }: Pick<Alert, "all_clear_at">) {
  // Start with a placeholder so the server and hydration render agree.
  const [now, setNow] = useState<number | null>(null);
  const [resetting, setResetting] = useState(false);
  // Backend clock, so replayed alerts count down in simulated time (and at replay speed).
  const serverNow = useServerNow();
  // Offline (last known alerts): reaching zero can't confirm the all-clear; a new strike may have reset it.
  const offline = useAlertsState().status === "stale";
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
  const unconfirmed = seconds === 0 && offline;
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
    <div className={`rounded-card px-3 py-2 ${cleared ? "bg-risk-green-bg text-risk-green" : "bg-surface text-risk-red"} ${resetting ? "stop-work-reset" : ""}`}>
      <span className="block text-xs font-medium">
        {target === null ? "Stop-work status" : "All-clear countdown"}
      </span>
      <span role="timer" aria-live="off" className="block font-mono text-2xl font-bold tabular-nums">
        {label}
      </span>
      <span role="status" className={resetting || unconfirmed ? "block text-sm font-semibold" : "sr-only"}>
        {resetting ? "New strike — timer reset" : unconfirmed ? "All clear not confirmed: connection lost" : cleared ? "All clear" : ""}
      </span>
    </div>
  );
}
