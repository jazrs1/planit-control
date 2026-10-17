"use client";

import type { Site } from "@shared/types";
import AlertBanner from "@/components/AlertBanner";
import { useAlertsState } from "@/components/AlertsProvider";
import { DEMO_DATA } from "@/lib/api";

export default function AlertsList({ sites }: { sites: Site[] }) {
  const { alerts, status, staleSince, replay } = useAlertsState();
  const sitesById = new Map((status === "demo" ? DEMO_DATA.sites : sites).map((site) => [site.id, site]));

  if (alerts === null) {
    return (
      <p role="status" className="rounded-card border border-border bg-surface p-4 font-medium text-muted">
        {status === "unreachable" ? "Can't reach the server · stop-work status unknown · retrying…" : "Connecting…"}
      </p>
    );
  }

  return (
    <>
      {status === "demo" && (
        <p role="status" className="mb-4 rounded-card border border-border bg-surface p-3 text-sm font-semibold text-muted">
          Demo data · sample alerts from shared/mocks, not live conditions
        </p>
      )}
      {staleSince && (
        <p role="status" className="mb-4 rounded-card border border-risk-red bg-risk-red-bg p-3 text-sm font-semibold text-risk-red">
          Connection lost · showing alerts from {staleSince.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
        </p>
      )}
      <p role="status" className="mb-4 text-sm text-muted">
        {alerts.length} active {alerts.length === 1 ? "alert" : "alerts"} · Newest first
        {status !== "demo" && (replay?.running ? " · Storm replay: updates every 3 seconds" : " · Updates every 30 seconds")}
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
