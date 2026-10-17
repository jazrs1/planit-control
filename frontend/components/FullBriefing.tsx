"use client";

import Link from "next/link";
import { useAlertsState } from "@/components/AlertsProvider";
import { formatAlertTime } from "@/lib/alerts";
import { GO_LABEL, GO_STYLE, formatForDate } from "@/lib/briefings";
import { briefingHeadline } from "@/lib/crew";
import { useCrewSiteData } from "@/lib/useCrewSiteData";

function BriefingContent({ site_id }: { site_id: string }) {
  const { briefing, detail, briefingFailed, loading, refresh } = useCrewSiteData(site_id);
  const { status, setDemo } = useAlertsState();
  return <main className="mx-auto max-w-2xl space-y-4 px-4 py-6">
    <Link href="/crew" className="inline-flex min-h-12 items-center font-semibold text-brand">Back to crew view</Link>
    <h1 className="pc-title">Full safety briefing</h1>
    {status === "demo" && <p role="status" className="font-semibold text-muted">Demo data · sample briefing. <button type="button" onClick={() => setDemo(false)} className="min-h-12 px-2 text-brand underline">Exit demo</button></p>}
    {briefing ? <article className={`space-y-4 rounded-card border-2 border-rule bg-surface p-5 ${briefingFailed ? "text-muted grayscale" : "text-text"}`}>
      <h2 className="text-xl font-bold">{briefing.site_name}</h2>
      {briefing.go_status && <p className={`inline-block rounded-chip px-3 py-1 text-sm font-bold uppercase ${briefingFailed ? "bg-bg text-muted" : GO_STYLE[briefing.go_status]}`}>{GO_LABEL[briefing.go_status]}</p>}
      <p className="text-2xl font-bold">{briefingHeadline(briefing)}{briefingFailed ? " ?" : ""}</p>
      {briefingFailed && <p role="status" className="font-semibold">Not confirmed · connection lost. Showing the last loaded briefing.</p>}
      <p className="text-sm text-muted">Covers {formatForDate(briefing.for_date)} · Generated {formatAlertTime(briefing.generated_at, detail?.timezone)}</p>
      {/* Older briefings may lack the structured parts: show the full text instead. */}
      {!briefing.risks?.length && !briefing.actions?.length && <p className="whitespace-pre-wrap text-lg leading-relaxed">{briefing.text}</p>}
      {!!briefing.risks?.length && <section><h3 className="font-bold">Top risks</h3><ul className="mbs-2 list-disc space-y-2 ps-5">{briefing.risks.map((risk, index) => <li key={index}>{risk}</li>)}</ul></section>}
      {!!briefing.actions?.length && <section><h3 className="font-bold">Actions</h3><ul className="mbs-2 list-disc space-y-2 ps-5">{briefing.actions.map((action, index) => <li key={index}>{action}</li>)}</ul></section>}
    </article> : <section role="status" className="rounded-card border-2 border-rule bg-surface p-5 text-muted"><p className="text-xl font-semibold">{loading ? "Loading briefing…" : "Briefing unavailable"}</p><p className="mbs-2">A next-day briefing may not have been generated yet. It is normally available at 6 PM site time.</p></section>}
    {status !== "demo" && <button type="button" onClick={() => void refresh()} className="min-h-12 rounded-card border-2 border-rule bg-surface px-4 font-semibold text-brand">Refresh briefing</button>}
  </main>;
}

export default function FullBriefing({ site_id }: { site_id: string }) {
  const demo = useAlertsState().status === "demo";
  return <BriefingContent key={`${site_id}:${demo}`} site_id={site_id} />;
}
