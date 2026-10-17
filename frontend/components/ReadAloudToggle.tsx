"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { LightningApproach, Site } from "@shared/types";
import { useAlertsState, useServerNow } from "@/components/AlertsProvider";
import { readAloudChanges, readAloudState } from "@/lib/readAloud";
import type { ReadAloudState } from "@/lib/readAloud";

// Crew view: read the selected site's alerts aloud. Off by default and not remembered, so a phone never
// starts talking on its own. Speaks only when the site's state changes (see lib/readAloud.ts).

type ReadAloudToggleProps = {
  site: Pick<Site, "id" | "name">;
  /** The site's lightning advisory (SiteDetail.lightning_approach), if the detail has loaded. */
  approach: LightningApproach | null | undefined;
};

function speak(text: string) {
  try {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-US";
    window.speechSynthesis.speak(utterance);
  } catch {
    // Speech can fail (no voices, blocked by the browser); the screen still shows everything.
  }
}

export default function ReadAloudToggle({ site, approach }: ReadAloudToggleProps) {
  const { alerts, status, replay } = useAlertsState();
  const serverNow = useServerNow();
  const id = useId();
  const [on, setOn] = useState(false);
  const [supported, setSupported] = useState(true);
  useEffect(() => setSupported(typeof window !== "undefined" && "speechSynthesis" in window), []);

  // The last known state, and whether it's unknown right now (so "connection lost" is said once).
  const lastKnown = useRef<ReadAloudState | null>(null);
  const unknownNow = useRef(false);
  const lastLine = useRef("");

  const state = readAloudState(site, alerts, status, approach, serverNow(), !!replay?.running);
  // A stable signature, so the effect runs only when what would be said changes.
  const signature = state.known ? [...state.items.entries()].sort().map(([key, text]) => `${key}=${text.split(".")[0]}`).join("|") + (state.replayRunning ? "|replay" : "") : "unknown";

  useEffect(() => {
    if (!on) return;
    if (lastKnown.current === null) {
      // First look after turning on: the baseline, nothing to say. Unknown at first: whatever is active
      // once the state is known gets said.
      lastKnown.current = state.known ? state : { known: true, items: new Map(), replayRunning: !!replay?.running };
      unknownNow.current = !state.known;
      return;
    }
    const lines = readAloudChanges(site.name, lastKnown.current, state, unknownNow.current);
    unknownNow.current = !state.known;
    if (state.known) lastKnown.current = state;
    for (const line of lines) {
      // Never the same line twice in a row (a flapping connection, a re-render).
      if (line === lastLine.current) continue;
      lastLine.current = line;
      speak(line);
    }
    // `state` is recomputed every render; `signature` is what changes when it matters.
  }, [on, signature, site.name]);

  function toggle() {
    const next = !on;
    setOn(next);
    lastKnown.current = null;
    lastLine.current = "";
    if (next) {
      // Said from the tap itself, which also unlocks speech on iPhone.
      speak(`Read aloud on for ${site.name}.`);
    } else {
      try { window.speechSynthesis.cancel(); } catch { /* nothing to stop */ }
    }
  }

  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p id={`${id}-label`} className="font-semibold">Read alerts aloud</p>
        <p id={`${id}-help`} className="text-xs text-muted">
          {supported ? `Speaks when ${site.name}'s stop-work, flood or lightning status changes.` : "This browser can't read aloud."}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-help`}
        disabled={!supported}
        onClick={toggle}
        className={`relative inline-flex h-8 w-14 shrink-0 items-center rounded-pill p-1 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-notice disabled:opacity-50 ${on ? "bg-brand" : "bg-border-strong"}`}
      >
        <span aria-hidden="true" className={`size-6 rounded-pill bg-surface shadow-card transition-transform ${on ? "translate-x-6" : ""}`} />
      </button>
    </div>
  );
}
