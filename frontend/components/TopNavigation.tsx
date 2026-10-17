"use client";

import Link from "next/link";
import { useAlerts } from "@/components/AlertsProvider";

export default function TopNavigation() {
  const alerts = useAlerts();

  return (
    <nav aria-label="Main navigation" className="border-b border-border bg-surface">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-2">
        <Link href="/" className="flex min-h-11 items-center font-semibold text-brand focus-visible:outline-2 focus-visible:outline-brand">
          PlanIT Control
        </Link>
        <Link
          href="/alerts"
          className="flex min-h-11 items-center gap-2 rounded-pill px-3 text-sm font-semibold text-text focus-visible:outline-2 focus-visible:outline-brand"
          aria-label={`Alerts, ${alerts.length} active`}
        >
          Alerts
          <span aria-hidden="true" className={`min-w-6 rounded-pill px-2 py-0.5 text-center tabular-nums ${alerts.length > 0 ? "bg-risk-red-bg text-risk-red" : "bg-risk-green-bg text-risk-green"}`}>
            {alerts.length}
          </span>
        </Link>
      </div>
    </nav>
  );
}
