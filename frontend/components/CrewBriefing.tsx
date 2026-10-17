"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import type { Briefing, Site } from "@shared/types";
import { useServerNow } from "@/components/AlertsProvider";
import { briefingDay, formatForDate } from "@/lib/briefings";
import { briefingHeadline } from "@/lib/crew";
import { formatAlertTime } from "@/lib/alerts";
import { usePolling } from "@/lib/usePolling";

export default function CrewBriefing({ briefing, site, failed, loading }: { briefing: Briefing | null; site: Site; failed: boolean; loading: boolean }) {
  const serverNow = useServerNow();
  // Last night's briefing covers today and stays current until tonight's 6 PM run.
  const [day, setDay] = useState<ReturnType<typeof briefingDay> | null>(null);
  const updateDay = useCallback(async () => {
    setDay(briefing ? briefingDay(briefing.for_date, site.timezone, serverNow()) : null);
  }, [briefing, serverNow, site.timezone]);
  usePolling(updateDay, 1000);
  const current = !!briefing && (day === "today" || day === "tomorrow");
  return <section aria-labelledby="briefing-heading" className="rounded-card border border-border bg-surface p-4 shadow-card">
    <h2 id="briefing-heading" className="text-xl font-bold">{day === "today" ? "Today\u2019s briefing" : "Tomorrow\u2019s briefing"}</h2>
    <div className={failed ? "text-muted grayscale" : ""}>
      {current ? <>
        <p className="mt-3 text-2xl font-bold">{briefingHeadline(briefing)}{failed ? " ?" : ""}</p>
        <p className="mt-2 text-sm text-muted">{failed ? "Not confirmed · last loaded briefing" : "Covers"} {formatForDate(briefing.for_date)}</p>
      </> : <p role="status" className="mt-3 text-lg font-semibold text-muted">{loading ? "Loading briefing…" : "No current briefing"}</p>}
      {briefing && <p className="mt-2 text-sm text-muted">Generated {formatAlertTime(briefing.generated_at, site.timezone)}{!current ? ` · Covers ${formatForDate(briefing.for_date)}` : ""}</p>}
    </div>
    <Link href={`/briefing/${encodeURIComponent(site.id)}`} className="mt-3 inline-flex min-h-12 items-center rounded-card border border-border px-4 font-semibold text-brand">{current ? "Read full briefing" : "View latest briefing"}</Link>
  </section>;
}
