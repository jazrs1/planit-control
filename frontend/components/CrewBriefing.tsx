"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import type { Briefing, Site } from "@shared/types";
import { useServerNow } from "@/components/AlertsProvider";
import { briefingDay, formatForDate } from "@/lib/briefings";
import { briefingHeadline } from "@/lib/crew";
import { formatAlertTime } from "@/lib/alerts";
import { usePolling } from "@/lib/usePolling";

// The go / caution / no-go call is made in code on the backend, never by the model.
const GO: Record<NonNullable<Briefing["go_status"]>, { label: string; style: string }> = {
  go: { label: "GO", style: "pc-chip--clear" },
  caution: { label: "CAUTION", style: "pc-chip--flood" },
  no_go: { label: "NO-GO", style: "pc-chip--stop" },
};

export default function CrewBriefing({ briefing, site, failed, loading }: { briefing: Briefing | null; site: Site; failed: boolean; loading: boolean }) {
  const serverNow = useServerNow();
  // Last night's briefing covers today and stays current until tonight's 6 PM run.
  const [day, setDay] = useState<ReturnType<typeof briefingDay> | null>(null);
  const updateDay = useCallback(async () => {
    setDay(briefing ? briefingDay(briefing.for_date, site.timezone, serverNow()) : null);
  }, [briefing, serverNow, site.timezone]);
  usePolling(updateDay, 1000);
  const current = !!briefing && (day === "today" || day === "tomorrow");
  const go = briefing?.go_status ? GO[briefing.go_status] : null;
  const forecast = briefing && Number.isFinite(briefing.key_numbers.hazard_index) ? briefing.key_numbers.hazard_index : null;
  // Last night's briefing covers today; tonight's (after 6 PM) covers tomorrow.
  const source = day === "today" ? "Forecast from last night\u2019s briefing" : "Forecast for tomorrow, from tonight\u2019s briefing";
  return <section aria-labelledby="briefing-heading" className="pc-panel overflow-clip">
    <h2 id="briefing-heading" className="pc-label flex h-9 items-center border-be border-border px-4 text-xs text-muted">{day === "today" ? "Today\u2019s briefing" : "Tomorrow\u2019s briefing"}</h2>
    <div className={`space-y-3 p-4 ${failed ? "text-muted grayscale" : ""}`}>
      {current ? <>
        <p className="flex flex-wrap items-center gap-2">
          {go && <span className={`pc-chip text-sm ${go.style}`}>{go.label}</span>}
          <span className="text-sm font-bold">{failed ? "Not confirmed · last loaded briefing" : "Covers"} {formatForDate(briefing.for_date)}</span>
        </p>
        <p className="text-xl font-semibold leading-snug">{briefingHeadline(briefing)}{failed ? " ?" : ""}</p>
        {forecast !== null && <div className="flex items-baseline justify-between gap-3 border-bs-2 border-border pbs-3">
          <span className="pc-label text-muted">{source}</span>
          <span className="shrink-0 font-mono text-xl font-bold tabular-nums">{forecast.toFixed(1)}<span className="text-sm text-muted"> / 10</span></span>
        </div>}
      </> : <p role="status" className="text-lg font-semibold text-muted">{loading ? "Loading briefing…" : "No current briefing"}</p>}
      {briefing && <p className="text-sm text-muted">Generated {formatAlertTime(briefing.generated_at, site.timezone)}{!current ? ` · Covers ${formatForDate(briefing.for_date)}` : ""}</p>}
      <Link href={`/briefing/${encodeURIComponent(site.id)}`} className="pc-link">{current ? "Read full briefing →" : "View latest briefing →"}</Link>
    </div>
  </section>;
}
