"use client";

import type { Site } from "@shared/types";
import AlertBanner from "@/components/AlertBanner";
import { useAlerts } from "@/components/AlertsProvider";

export default function AlertsList({ sites }: { sites: Site[] }) {
  const alerts = useAlerts();
  const sitesById = new Map(sites.map((site) => [site.id, site]));

  return (
    <>
      <p role="status" className="mb-4 text-sm text-muted">
        {alerts.length} active {alerts.length === 1 ? "alert" : "alerts"} · Newest first · Updates every 15 seconds
      </p>
      {alerts.length === 0 ? (
        <p className="rounded-card border border-border bg-risk-green-bg p-4 font-medium text-risk-green">
          No active alerts.
        </p>
      ) : (
        <ul className="grid gap-4">
          {alerts.map((alert) => (
            <li key={alert.id}>
              <AlertBanner alert={alert} site={sitesById.get(alert.site_id)} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
