"use client";

import Link from "next/link";
import type { BriefingKeyNumbers } from "@shared/types";
import { useAlertsState, useServerNow } from "@/components/AlertsProvider";
import { formatAlertTime } from "@/lib/alerts";
import { GO_LABEL, GO_STYLE, KEY_NUMBER_LABEL, briefingDay, formatForDate, formatKeyNumber } from "@/lib/briefings";
import { briefingHeadline } from "@/lib/crew";
import { useCrewSiteData } from "@/lib/useCrewSiteData";

function BriefingContent({ site_id }: { site_id: string }) {
  const { briefing, detail, briefingFailed, loading, refresh } = useCrewSiteData(site_id);
  const { status, setDemo } = useAlertsState();
  const serverNow = useServerNow();
  const timezone = detail?.timezone ?? "America/New_York";
  const day = briefing ? briefingDay(briefing.for_date, timezone, serverNow()) : null;
  const unavailable = new Set(briefing?.unavailable ?? []);
  // Same look as the briefing card: date line, verdict top right, the headline as the largest text,
  // key numbers as label/value pairs, then roomy lists.
  return <main className="mx-auto max-w-3xl space-y-6 px-4 py-6">
    <Link href="/crew" className="pc-link">← Crew view</Link>
    <h1 className="pc-title">Full briefing</h1>
    {status === "demo" && <p role="status" className="text-sm text-muted">Demo data · sample briefing. <button type="button" onClick={() => setDemo(false)} className="pc-link">Exit demo</button></p>}
    {briefing ? <article className={`flex flex-col gap-6 rounded-card bg-surface p-6 max-sm:p-5 ${briefingFailed ? "border-2 border-dashed border-border text-muted grayscale" : "shadow-card"}`}>
      <header className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xs text-muted">{briefing.site_name} · Briefing for {day === "today" ? "today" : formatForDate(briefing.for_date)}</h2>
          {briefing.go_status && <span className={`pc-chip shrink-0 ${briefingFailed ? "pc-chip--unknown" : GO_STYLE[briefing.go_status]}`}>{GO_LABEL[briefing.go_status]}{briefingFailed ? "?" : ""}</span>}
        </div>
        <p className="max-w-[68ch] text-xl font-semibold leading-snug text-balance">{briefingHeadline(briefing)}</p>
        {briefingFailed && <p role="status" className="text-sm font-semibold">Not confirmed · connection lost. Showing the last loaded briefing.</p>}
      </header>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
        {(Object.keys(KEY_NUMBER_LABEL) as (keyof BriefingKeyNumbers)[]).map((key) => {
          const value = briefing.key_numbers?.[key];
          const missing = unavailable.has(key) || typeof value !== "number";
          return <div key={key} className="flex min-w-0 flex-col">
            <dt className="text-xs text-muted">{KEY_NUMBER_LABEL[key]}</dt>
            <dd className="text-xl font-semibold tabular-nums">{missing ? <span className="text-muted" title="No live data behind this number">—</span> : formatKeyNumber(key, value)}</dd>
          </div>;
        })}
      </dl>
      {/* Older briefings may lack the structured parts: show the full text instead. */}
      {!briefing.risks?.length && !briefing.actions?.length && <p className="max-w-[68ch] whitespace-pre-wrap">{briefing.text}</p>}
      <div className="grid gap-6 md:grid-cols-2 md:gap-10">
        {!!briefing.risks?.length && <section className="flex flex-col gap-2"><h3 className="text-xs text-muted">Top risks</h3><ol className="flex list-decimal flex-col gap-2 ps-5">{briefing.risks.map((risk, index) => <li key={index}>{risk}</li>)}</ol></section>}
        {!!briefing.actions?.length && <section className="flex flex-col gap-2"><h3 className="text-xs text-muted">Actions</h3><ul className="flex list-disc flex-col gap-2 ps-5">{briefing.actions.map((action, index) => <li key={index}>{action}</li>)}</ul></section>}
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-x-6">
        <p className="text-xs text-muted">Generated {formatAlertTime(briefing.generated_at, detail?.timezone)}</p>
        {status !== "demo" && <button type="button" onClick={() => void refresh()} className="pc-link text-xs">Refresh briefing</button>}
      </footer>
    </article> : <section role="status" className="rounded-card border-2 border-dashed border-border bg-surface p-6 text-muted"><p className="text-xl font-semibold">{loading ? "Loading briefing…" : "Briefing unavailable"}</p><p className="mbs-2">A next-day briefing may not have been generated yet. It is normally available at 6 PM site time.</p>
      {status !== "demo" && !loading && <button type="button" onClick={() => void refresh()} className="pc-link">Try again</button>}</section>}
  </main>;
}

export default function FullBriefing({ site_id }: { site_id: string }) {
  const demo = useAlertsState().status === "demo";
  return <BriefingContent key={`${site_id}:${demo}`} site_id={site_id} />;
}
