"use client";

import { useEffect, useRef } from "react";

/** Run `poll` now and then every `ms` (null pauses it), plus when the tab comes back into view.
 *  Calls never overlap. Changing `ms` polls immediately, so a faster cadence takes effect at once. */
export function usePolling(poll: () => Promise<void>, ms: number | null) {
  const latest = useRef(poll);
  const pending = useRef(false);
  useEffect(() => { latest.current = poll; });

  useEffect(() => {
    if (ms === null) return;
    async function run() {
      if (pending.current) return;
      pending.current = true;
      try { await latest.current(); } finally { pending.current = false; }
    }
    function onVisible() {
      if (!document.hidden) void run();
    }

    void run();
    const interval = window.setInterval(() => void run(), ms);
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ms]);
}
