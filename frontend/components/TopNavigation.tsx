"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAlertsState } from "@/components/AlertsProvider";
import { countAlerts } from "@/lib/alerts";

export default function TopNavigation() {
  const { alerts, status } = useAlertsState();
  const pathname = usePathname();
  const counts = countAlerts(alerts ?? []);
  const count = (value: number) => alerts === null ? "—" : `${value}${status === "stale" ? "?" : ""}`;
  const breakdown = `${count(counts.lightning)} stop work · ${count(counts.flood)} flood risk${counts.other ? ` · ${count(counts.other)} other` : ""}`;
  // Unknown is not zero: never show a green "0" before real alerts have loaded.
  const badge = alerts === null
    ? { text: "—", label: "Alerts, connecting to server", style: "bg-bg text-muted" }
    : status === "stale"
    ? { text: `${alerts.length}?`, label: `Alerts, ${alerts.length} last known, connection lost`, style: "bg-bg text-muted" }
    : {
      text: String(alerts.length),
      label: `Alerts, ${alerts.length} active${status === "demo" ? ", demo data" : ""}`,
      style: counts.lightning > 0 ? "bg-risk-red-bg text-risk-red" : alerts.length > 0 ? "bg-risk-amber-bg text-risk-amber" : "bg-risk-green-bg text-risk-green",
    };

  return (
    <nav aria-label="Main navigation" className="h-(--pc-nav-height) border-b border-border bg-surface">
      <div className="mx-auto flex h-full max-w-5xl items-center justify-between gap-2 px-4">
        <Link href="/" className="flex min-h-11 items-center font-semibold text-brand focus-visible:outline-2 focus-visible:outline-brand">
          <span className="sm:hidden">PlanIT</span><span className="hidden sm:inline">PlanIT Control</span>
        </Link>
        <div className="flex min-w-0 items-center gap-1 sm:gap-2">
        <Link href="/how-it-works" aria-label="How it works" aria-current={pathname === "/how-it-works" ? "page" : undefined} className="flex min-h-11 items-center px-1.5 text-sm font-semibold text-brand sm:px-2">
          <span className="sm:hidden">About</span><span className="hidden sm:inline">How it works</span>
        </Link>
        <Link href="/briefings" aria-current={pathname === "/briefings" ? "page" : undefined} className="flex min-h-11 items-center px-1.5 text-sm font-semibold text-brand sm:px-2">Briefings</Link>
        <Link href="/reports" className="flex min-h-11 items-center px-1.5 text-sm font-semibold text-brand sm:px-2">Reports</Link>
        <Link
          href="/alerts"
          className="flex min-h-11 min-w-0 flex-col justify-center rounded-card px-1.5 text-sm font-semibold text-text sm:px-2 focus-visible:outline-2 focus-visible:outline-brand"
          aria-label={`${badge.label}, ${breakdown}`}
        >
          <span className="flex flex-wrap items-center gap-x-1">
          Alerts
          <span aria-hidden="true" className={`min-w-6 rounded-pill px-2 py-0.5 text-center tabular-nums ${badge.style}`}>
            {badge.text}
          </span>
          {(alerts === null || status === "stale") && (
            <span aria-hidden="true" className="text-xs font-normal text-muted">
              {status === "unreachable" || status === "stale" ? "Offline" : "Connecting…"}
            </span>
          )}
          {status === "demo" && <span aria-hidden="true" className="rounded-pill border border-border px-2 py-0.5 text-xs font-medium text-muted">Demo data</span>}
          </span>
          <span aria-hidden="true" className="text-[10px] font-normal text-muted sm:text-xs">{breakdown}</span>
        </Link>
        <Link href="/report" className={`min-h-12 items-center justify-center rounded-card bg-brand px-4 font-semibold text-surface shadow-card sm:static sm:flex sm:min-h-11 sm:text-sm ${pathname === "/report" ? "hidden" : "fixed inset-x-4 bottom-[calc(env(safe-area-inset-bottom)+1rem)] z-50 flex"}`}>Report hazard</Link>
        </div>
      </div>
    </nav>
  );
}
