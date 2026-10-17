"use client";

import Link from "next/link";
import { useAlertsState } from "@/components/AlertsProvider";

export default function TopNavigation() {
  const { alerts, status } = useAlertsState();
  // Unknown is not zero: never show a green "0" before real alerts have loaded.
  const badge = alerts === null
    ? { text: "—", label: "Alerts, connecting to server", style: "bg-bg text-muted" }
    : {
      text: String(alerts.length),
      label: `Alerts, ${alerts.length} active${status === "demo" ? ", demo data" : ""}`,
      style: alerts.length > 0 ? "bg-risk-red-bg text-risk-red" : "bg-risk-green-bg text-risk-green",
    };

  return (
    <nav aria-label="Main navigation" className="h-(--pc-nav-height) border-b border-border bg-surface">
      <div className="mx-auto flex h-full max-w-5xl items-center justify-between gap-2 px-4">
        <Link href="/" className="flex min-h-11 items-center font-semibold text-brand focus-visible:outline-2 focus-visible:outline-brand">
          PlanIT Control
        </Link>
        <Link
          href="/alerts"
          className="flex min-h-11 items-center gap-2 rounded-pill px-3 text-sm font-semibold text-text focus-visible:outline-2 focus-visible:outline-brand"
          aria-label={badge.label}
        >
          Alerts
          <span aria-hidden="true" className={`min-w-6 rounded-pill px-2 py-0.5 text-center tabular-nums ${badge.style}`}>
            {badge.text}
          </span>
          {alerts === null && <span aria-hidden="true" className="text-xs font-normal text-muted">Connecting…</span>}
          {status === "demo" && <span aria-hidden="true" className="rounded-pill border border-border px-2 py-0.5 text-xs font-medium text-muted">Demo data</span>}
        </Link>
      </div>
    </nav>
  );
}
