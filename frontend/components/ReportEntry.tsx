"use client";

import { useCallback, useState } from "react";
import type { Site } from "@shared/types";
import { useAlertsState } from "@/components/AlertsProvider";
import ReportForm from "@/components/ReportForm";
import { getSites } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";

export default function ReportEntry({ initialSites, initialSiteId = "" }: { initialSites: Site[] | null; initialSiteId?: string }) {
  const { status, replay, setDemo } = useAlertsState();
  const [sites, setSites] = useState(initialSites);
  const refreshSites = useCallback(async () => {
    try { setSites(await getSites()); }
    catch { setSites(null); }
  }, []);
  usePolling(refreshSites, status === "demo" ? null : replay?.running ? 3_000 : sites === null ? 5_000 : 30_000);

  if (status === "demo") return (
    <section role="status" className="pc-panel flex flex-col items-start gap-4 p-6 max-sm:p-5">
      <span className="pc-chip pc-chip--unknown">Demo data</span>
      <p className="text-muted">Reporting is disabled in demo mode. Exit demo to submit a real crew report.</p>
      <button type="button" onClick={() => setDemo(false)} className="pc-btn pc-btn--primary">Exit demo</button>
    </section>
  );

  return <ReportForm key={initialSiteId} sites={sites} initialSiteId={initialSiteId} />;
}
