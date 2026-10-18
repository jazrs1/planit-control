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
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <p role="status" className="text-xs text-muted">{unknown ? "Reports unknown" : `${sorted.length}${stale ? "?" : ""} ${sorted.length === 1 ? "report" : "reports"}${stale ? " (last known)" : ""}, newest first`}</p>
        {!demo && <button type="button" disabled={refreshing} className="pc-link text-xs disabled:opacity-50" onClick={() => void refresh()}>{refreshing ? "Refreshing…" : "Refresh"}</button>}
      </div>
      {demo && <p role="status" className="flex flex-wrap items-center gap-x-3 text-muted"><span className="pc-chip pc-chip--unknown">Demo data</span>Sample reports, not live conditions.<button type="button" onClick={() => setDemo(false)} className="pc-link">Exit demo</button></p>}
      {unknown && <section role="status" className="pc-panel flex flex-col gap-4 p-6 max-sm:p-5">
        <h2 className="text-xl font-semibold">Can&apos;t reach the server</h2>
        <p className="max-w-[68ch] text-muted">Crew reports are unknown. This does not mean there are no reported hazards. Retrying automatically.</p>
        <button type="button" onClick={() => setDemo(true)} className="pc-link self-start">Show demo data</button>
      </section>}
      {stale && <p role="alert" className="rounded-card border-2 border-dashed border-muted px-4 py-3 font-semibold text-muted">Connection lost. Showing the last loaded reports; new ones may be missing.</p>}
      {!unknown && <div className={`flex flex-col gap-6 ${stale ? "grayscale opacity-60" : ""}`}>
      <ReportMap reports={sorted} selectedId={selectedId} onSelect={selectFromMap} emptyText={sorted.length === 0 && !stale ? "No reports yet" : undefined} />
      {sorted.length === 0 ? <p className="pc-panel p-6 text-muted">{stale ? "The last loaded list was empty. Current reports are unknown." : "No crew hazard reports yet."}</p> : (
        <ul className="pc-enter grid items-start gap-4 sm:grid-cols-2">
          {sorted.map((report) => {
            const site = report.site_id ? sitesById.get(report.site_id) : undefined;
            const time = new Intl.DateTimeFormat("en-US", { timeZone: site?.timezone ?? "UTC", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(report.created_at));
            return <li key={report.id} ref={(element) => { if (element) rows.current.set(report.id, element); else rows.current.delete(report.id); }}>
              <article className={`flex flex-col gap-4 rounded-card bg-surface p-6 shadow-card max-sm:p-5 ${selectedId === report.id ? "outline-2 outline-notice" : ""}`}>
                <div className="flex items-start gap-4">
                  <ReportPhoto key={report.photo_url} src={report.photo_url} alt={`${REPORT_LABEL[report.category]} reported by crew`} className="size-22 shrink-0" />
                  <div className="flex min-w-0 flex-col">
                    <h2 className="break-words text-xl font-semibold">{REPORT_LABEL[report.category]}{report.species ? ` · ${report.species}` : ""}</h2>
                    <p className="break-words text-xs text-muted">{site?.name ?? (report.site_id ? `${report.site_id} · site details unavailable` : "No site chosen")}</p>
                    <time dateTime={report.created_at} className="text-xs text-muted">{time}</time>
                  </div>
                </div>
                {report.note && <p className="max-w-[68ch] break-words whitespace-pre-wrap">{report.note}</p>}
                <footer className="flex flex-wrap items-center justify-between gap-x-6">
                  <p className="text-xs text-muted">{ROLE_LABEL[report.reporter_role]} · {report.lat.toFixed(5)}, {report.lon.toFixed(5)}</p>
                  <button type="button" aria-pressed={selectedId === report.id} onClick={() => { setSelectedId(report.id); document.getElementById("reports-heading")?.scrollIntoView({ block: "start" }); }} className="pc-link text-xs">Show on map</button>
                </footer>
              </article>
            </li>;
          })}
        </ul>
      )}
      </div>}
    </div>
  );
}
