"use client";

import { useEffect, useState } from "react";
import { useAlertsState, useServerNow } from "@/components/AlertsProvider";
import { useDemoCode } from "@/components/DemoCode";
import { startReplay, stopReplay } from "@/lib/api";

function formatSimulated(ms: number) {
  return new Date(ms).toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

/** Starts and stops the backend's storm replay. Replay state lives in AlertsProvider, which also
 *  switches every dashboard refresh to the fast replay cadence while it runs. */
export default function ReplayControl() {
  const { replay, refresh, status, connection } = useAlertsState();
  const serverNow = useServerNow();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const demoCode = useDemoCode();
  const running = replay?.running ?? false;
  // Offline, the replay may have finished or been stopped: show what was last seen, not "running".
  const offline = connection.level !== "online";
  const unavailable = status === "demo" || status === "connecting" || status === "unreachable";

  // Tick the simulated clock between refreshes (not while offline: it would be a guess).
  useEffect(() => {
    if (!running || offline) return;
    setNow(serverNow());
    const tick = window.setInterval(() => setNow(serverNow()), 1000);
    return () => window.clearInterval(tick);
  }, [running, offline, serverNow]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      // Starting or stopping a replay needs the demo code: on a 401 this asks for it, then retries.
      await demoCode.call(action, () => void run(action));
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      await refresh(); // picks up the new replay status and cadence right away
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      {running && offline ? (
        <p role="status" className="flex flex-wrap items-center gap-x-2 text-muted">
          <span className="rounded-pill bg-bg px-2 py-0.5 text-xs font-semibold uppercase tracking-wide">Replay: last known</span>
          <span className="font-mono tabular-nums">{replay?.simulated_now ? formatSimulated(Date.parse(replay.simulated_now)) : "--"}</span>
          <span>simulated time when last seen · status unknown until the server answers</span>
        </p>
      ) : running ? (
        <>
          <p role="status" className="flex flex-wrap items-center gap-x-2">
            <span className="rounded-pill bg-risk-amber-bg px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-risk-amber">Replay running</span>
            <span className="font-mono tabular-nums">{now === null ? "--" : formatSimulated(now)}</span>
            <span className="text-muted">
              simulated · {replay?.speed}× · {replay?.files_done}/{replay?.files_total} files · {replay?.flashes_ingested.toLocaleString()} flashes
            </span>
          </p>
          <button type="button" disabled={busy} onClick={() => void run(stopReplay)} className="min-h-11 rounded-card border border-risk-red px-3 font-semibold text-risk-red hover:bg-risk-red-bg focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50">
            {busy ? "Stopping…" : "Stop replay"}
          </button>
        </>
      ) : (
        <button
          type="button"
          disabled={busy || unavailable}
          onClick={() => void run(() => startReplay())}
          title={unavailable ? "Needs a connection to the server" : "Play a recorded storm through the live pipeline on a simulated clock"}
          className="min-h-11 rounded-card bg-brand px-3 font-semibold text-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50"
        >
          {busy ? "Starting…" : "⚡ Replay storm"}
        </button>
      )}
      {demoCode.form}
      {message && <p role="alert" className="w-full text-risk-red">Replay: {message}</p>}
    </div>
  );
}
