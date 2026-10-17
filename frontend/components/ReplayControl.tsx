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

  const stopIcon = <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" fill="currentColor" /></svg>;
  const playIcon = <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16l13-8z" fill="currentColor" /></svg>;
  const simulated = (label: string, time: string, detail: string, muted = false) => (
    <p role="status" className={`grid leading-tight ${muted ? "text-muted" : ""}`}>
      <span className="pc-label text-muted">{label}</span>
      <span className="font-mono text-xl font-bold tabular-nums">{time}</span>
      <span className="text-xs text-muted">{detail}</span>
    </p>
  );

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      {running && offline ? (
        <>
          <span className="pc-chip pc-chip--unknown">Replay: last known</span>
          {simulated("Simulated time when last seen", replay?.simulated_now ? formatSimulated(Date.parse(replay.simulated_now)) : "--", "Status unknown until the server answers", true)}
        </>
      ) : running ? (
        <>
          <button type="button" disabled={busy} onClick={() => void run(stopReplay)} className="pc-btn pc-btn--danger">
            {stopIcon}{busy ? "Stopping…" : "Stop replay"}
          </button>
          <span className="pc-chip pc-chip--quiet text-[0.8125rem]" title="Simulated seconds per real second">{replay?.speed}×</span>
          {simulated("Simulated time", now === null ? "--" : formatSimulated(now), `${replay?.files_done}/${replay?.files_total} files · ${replay?.flashes_ingested.toLocaleString()} flashes`)}
        </>
      ) : (
        <button
          type="button"
          disabled={busy || unavailable}
          onClick={() => void run(() => startReplay())}
          title={unavailable ? "Needs a connection to the server" : "Play a recorded storm through the live pipeline on a simulated clock"}
          className="pc-btn pc-btn--primary"
        >
          {playIcon}{busy ? "Starting…" : "Replay storm"}
        </button>
      )}
      {demoCode.form}
      {message && <p role="alert" className="w-full font-semibold text-risk-red">Replay: {message}</p>}
    </div>
  );
}
