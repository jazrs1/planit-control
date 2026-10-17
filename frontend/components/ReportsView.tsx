"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HazardReport, Site } from "@shared/types";
import { DEMO_DATA, getReports, getSites } from "@/lib/api";
import { useAlertsState } from "@/components/AlertsProvider";
import { usePolling } from "@/lib/usePolling";
import { REPORT_LABEL, ROLE_LABEL } from "@/lib/reports";
import ReportMap from "@/components/ReportMap";
import ReportPhoto from "@/components/ReportPhoto";

export default function ReportsView({ initialReports, sites }: { initialReports: HazardReport[] | null; sites: Site[] | null }) {
  const { status, replay, setDemo } = useAlertsState();
  const demo = status === "demo";
  const [reports, setReports] = useState(initialReports);
  const [liveSites, setLiveSites] = useState(sites);
  const [failed, setFailed] = useState(initialReports === null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const rows = useRef(new Map<string, HTMLLIElement>());
  const generation = useRef(0);
  const pending = useRef(false);
  const previousDemo = useRef(demo);
  useEffect(() => {
    if (previousDemo.current !== demo) {
      // Leaving demo starts unknown until a new real request succeeds.
      setReports(null); setFailed(true); setSelectedId(null);
      previousDemo.current = demo;
    }
    return () => { generation.current++; pending.current = false; };
  }, [demo]);
  const refresh = useCallback(async () => {
    if (demo || pending.current) return;
    pending.current = true;
    const current = generation.current;
    setRefreshing(true);
    const [nextReports, nextSites] = await Promise.allSettled([getReports(), getSites()]);
    if (current !== generation.current) return;
    if (nextReports.status === "fulfilled") { setReports(nextReports.value); setFailed(false); }
    else setFailed(true); // Preserve only the last real records, visibly unconfirmed.
    setLiveSites(nextSites.status === "fulfilled" ? nextSites.value : null);
    setRefreshing(false);
    pending.current = false;
  }, [demo]);
  usePolling(refresh, demo ? null : replay?.running ? 3_000 : reports === null ? 5_000 : 30_000);
  const unknown = !demo && reports === null;
  const stale = !demo && failed && reports !== null;
  const sorted = useMemo(() => [...(demo ? DEMO_DATA.reports : reports ?? [])].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)), [reports, demo]);
  const sitesById = new Map((demo ? DEMO_DATA.sites : liveSites ?? []).map((site) => [site.id, site]));
  const selectFromMap = useCallback((id: string) => {
    setSelectedId(id);
    rows.current.get(id)?.scrollIntoView({ block: "nearest" });
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p role="status" className="text-sm text-muted">{unknown ? "— Reports unknown" : `${sorted.length}${stale ? "? last known" : ""} ${sorted.length === 1 ? "report" : "reports"} · Newest first`}</p>
        {!demo && <button type="button" disabled={refreshing} className="pc-btn pc-btn--quiet" onClick={() => void refresh()}>{refreshing ? "Refreshing…" : "Refresh"}</button>}
      </div>
      {demo && <div role="status" className="rounded-card border border-border bg-surface p-3 text-sm text-muted"><strong>Demo data</strong> · Sample reports, not live conditions. <button type="button" onClick={() => setDemo(false)} className="min-h-11 px-2 font-semibold text-brand underline">Exit demo</button></div>}
      {unknown && <section role="status" className="space-y-3 rounded-card border border-border bg-surface p-4">
        <h2 className="font-semibold">Can&apos;t reach the server</h2>
        <p className="text-sm text-muted">Crew reports are unknown. This does not mean there are no reported hazards. Retrying automatically.</p>
        <button type="button" onClick={() => setDemo(true)} className="min-h-11 rounded-card border border-border px-4 font-semibold text-brand">Show demo data</button>
      </section>}
      {stale && <p role="alert" className="rounded-card border border-border bg-surface p-3 font-medium text-muted">Connection lost · Reports not confirmed. Showing the last real reports; new reports may be missing.</p>}
      {!unknown && <div className={stale ? "space-y-4 grayscale opacity-60" : "space-y-4"}>
      <ReportMap reports={sorted} selectedId={selectedId} onSelect={selectFromMap} />
      {sorted.length === 0 ? <p className="rounded-card border border-border bg-surface p-4 text-muted">{stale ? "The last loaded list was empty. Current reports are unknown." : "No crew hazard reports yet."}</p> : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {sorted.map((report) => {
            const site = report.site_id ? sitesById.get(report.site_id) : undefined;
            const time = new Intl.DateTimeFormat("en-US", { timeZone: site?.timezone ?? "UTC", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(report.created_at));
            return <li key={report.id} ref={(element) => { if (element) rows.current.set(report.id, element); else rows.current.delete(report.id); }}>
              <article className={`h-full rounded-card border bg-surface p-4 ${selectedId === report.id ? "border-brand ring-2 ring-brand" : "border-border"}`}>
                <div className="flex items-start gap-3">
                  <ReportPhoto key={report.photo_url} src={report.photo_url} alt={`${REPORT_LABEL[report.category]} reported by crew`} className="h-20 w-20 shrink-0" />
                  <div className="min-w-0">
                    <h2 className="break-words font-semibold">{REPORT_LABEL[report.category]}{report.species ? ` · ${report.species}` : ""}</h2>
                    <p className="break-words text-sm text-muted">{site?.name ?? (report.site_id ? `${report.site_id} · site details unavailable` : "Site unknown / not associated")}</p>
                    <time dateTime={report.created_at} className="text-sm text-muted">{time}</time>
                  </div>
                </div>
                {report.note && <p className="mbs-3 break-words whitespace-pre-wrap text-sm">{report.note}</p>}
                <p className="mbs-2 text-xs text-muted">{ROLE_LABEL[report.reporter_role]} · {report.lat.toFixed(5)}, {report.lon.toFixed(5)}</p>
                <button type="button" aria-pressed={selectedId === report.id} onClick={() => { setSelectedId(report.id); document.getElementById("reports-heading")?.scrollIntoView({ block: "start" }); }} className="mbs-2 min-h-11 rounded-card border border-border px-3 text-sm font-semibold text-brand">Show on map</button>
              </article>
            </li>;
          })}
        </ul>
      )}
      </div>}
    </div>
  );
}
