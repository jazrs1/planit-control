"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Alert, Site } from "@shared/types";
import SiteCard from "@/components/SiteCard";
import SiteMap from "@/components/SiteMap";
import { getAlerts, getSites } from "@/lib/api";
import { riskLevel } from "@/lib/risk";

export default function SupervisorDashboard({ initialSites, initialAlerts }: { initialSites: Site[]; initialAlerts: Alert[] }) {
  const [sites, setSites] = useState(initialSites);
  const [alerts, setAlerts] = useState(initialAlerts);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const rows = useRef(new Map<string, HTMLLIElement>());
  useEffect(() => {
    let active = true;
    const timer = window.setInterval(async () => {
      const [nextSites, nextAlerts] = await Promise.all([getSites(), getAlerts()]);
      if (active) { setSites(nextSites); setAlerts(nextAlerts); }
    }, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  const sorted = useMemo(() => [...sites].sort((a, b) => b.hazard_index - a.hazard_index || a.name.localeCompare(b.name)), [sites]);
  const lightning = useMemo(() => new Map(alerts.filter((a) => a.type === "lightning").map((a) => [a.site_id, a])), [alerts]);
  const selectFromMap = useCallback((id: string) => {
    setSelectedId(id);
    rows.current.get(id)?.scrollIntoView({ block: "nearest" });
  }, []);
  return (
    <main className="flex min-h-dvh flex-col lg:h-dvh lg:overflow-hidden">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-surface px-5 py-4">
        <div><p className="text-sm font-bold tracking-wide text-brand">PlanIT Control</p><h1 className="text-xl font-semibold">Supervisor Dashboard</h1></div>
        <p className="text-sm text-muted">Florida field operations · Refreshes every 30 seconds</p>
      </header>
      <div className="grid flex-1 lg:min-h-0 lg:grid-cols-[2fr_1fr]">
        <section aria-label="Florida site safety map" className="relative h-[55dvh] min-h-80 lg:h-full">
          <SiteMap sites={sites} alerts={alerts} selectedId={selectedId} onSelect={selectFromMap} />
          <div className="absolute bottom-10 left-3 flex flex-wrap gap-3 rounded-card border border-border bg-surface px-3 py-2 text-xs shadow-card" aria-label="Map legend">
            <span className="text-risk-green">● Low &lt; 4</span><span className="text-risk-amber">● Elevated 4–&lt;7</span><span className="text-risk-red">● High ≥ 7</span><span>◎ Lightning stop work</span>
          </div>
        </section>
        <section aria-label="Sites ranked by hazard index" className="flex min-h-0 flex-col border-t border-border bg-bg lg:border-t-0 lg:border-l">
          <div className="shrink-0 border-b border-border bg-surface p-4">
            <dl className="grid grid-cols-3 gap-2 text-center">
              <div><dt className="text-xs text-muted">Sites</dt><dd className="text-2xl font-bold">{sites.length}</dd></div>
              <div><dt className="text-xs text-muted">High risk</dt><dd className="text-2xl font-bold text-risk-red">{sites.filter((s) => riskLevel(s.hazard_index) === "red").length}</dd></div>
              <div><dt className="text-xs text-muted">Stop work</dt><dd className="text-2xl font-bold text-risk-red">{sites.filter((s) => lightning.has(s.id)).length}</dd></div>
            </dl>
            <p className="mt-4 text-xs font-medium uppercase tracking-wide text-muted">Sites · Highest risk first</p>
          </div>
          <ul className="space-y-3 p-4 lg:overflow-y-auto">
            {sorted.map((site) => <li key={site.id} ref={(el) => { if (el) rows.current.set(site.id, el); else rows.current.delete(site.id); }} onClick={() => setSelectedId(site.id)}>
              <SiteCard site={site} lightningAlert={lightning.get(site.id)} selected={selectedId === site.id} onSelect={() => setSelectedId(site.id)} />
            </li>)}
          </ul>
          {sites.length === 0 && <p className="p-4 text-sm text-muted">No sites available.</p>}
        </section>
      </div>
    </main>
  );
}
