"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useAlertsState } from "@/components/AlertsProvider";
import { formatAgo } from "@/lib/time";

/** Wraps every page (root layout). After 2 minutes without a successful response it shows one
 *  full-width "Status unknown" banner and dims the page's last known data underneath. It clears by
 *  itself the moment any request succeeds again. Before then, pages show their own greyed "last known". */
export default function OutageShell({ children }: { children: ReactNode }) {
  const { connection } = useAlertsState();
  const outage = connection.level === "outage";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!outage) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [outage]);

  const last = connection.lastSuccessAt;
  return (
    <>
      {outage && (
        <div role="alert" className="sticky top-0 z-40 border-b-2 border-risk-red bg-risk-red px-4 py-3 text-surface shadow-card">
          <div className="mx-auto max-w-5xl">
            <p className="text-lg font-bold">Status unknown · don&apos;t treat any site as clear</p>
            <p className="text-sm">
              {last === null
                ? "No response from the server since this page opened."
                : `No response from the server for ${formatAgo(now - last).replace(" ago", "")} (last at ${new Date(last).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}).`}
              {" "}Everything below is last known data and may be wrong: stop-work alerts, lightning and countdowns could have changed. Reconnecting automatically…
            </p>
          </div>
        </div>
      )}
      <div className={outage ? "opacity-50 grayscale transition-[opacity,filter]" : "transition-[opacity,filter]"}>
        {children}
      </div>
    </>
  );
}
