"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAlertsState } from "@/components/AlertsProvider";
import { countAlerts } from "@/lib/alerts";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/alerts", label: "Alerts" },
  { href: "/crew", label: "Crew view" },
  { href: "/report", label: "Report hazard" },
  { href: "/reports", label: "Reports" },
  { href: "/briefings", label: "Briefings" },
  { href: "/about", label: "About" },
];

export default function TopNavigation() {
  const { alerts, status } = useAlertsState();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const nav = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") { setOpen(false); toggle.current?.focus(); }
    }
    function onOutside(event: PointerEvent) {
      if (event.target instanceof Node && !nav.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onOutside);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onOutside); };
  }, [open]);
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
    <nav ref={nav} aria-label="Main navigation" className="relative z-50 h-(--pc-nav-height) border-b border-border bg-surface">
      <div className="mx-auto flex h-full max-w-7xl items-center justify-between gap-2 px-3 sm:px-4">
        <Link href="/" className="flex min-h-12 shrink-0 items-center gap-2 font-semibold text-brand focus-visible:outline-2 focus-visible:outline-brand" aria-label="PlanIT Control dashboard">
          <img src="/icon.svg" width={28} height={28} alt="" />
          <span className="sm:hidden">PlanIT</span><span className="hidden sm:inline">PlanIT Control</span>
        </Link>
        <div className="hidden items-center gap-1 xl:flex">
          {LINKS.filter((link) => link.href !== "/alerts").map((link) => <Link key={link.href} href={link.href} aria-current={pathname === link.href ? "page" : undefined} className={`flex min-h-12 items-center rounded-card px-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-brand ${pathname === link.href ? "bg-bg text-brand" : "text-text"}`}>{link.label}</Link>)}
        </div>
        <div className="flex min-w-0 items-center gap-1 sm:gap-2">
        <Link
          href="/alerts"
          onClick={() => setOpen(false)}
          aria-current={pathname === "/alerts" ? "page" : undefined}
          className="flex min-h-12 min-w-0 max-w-44 flex-col justify-center rounded-card px-1 text-sm font-semibold text-text sm:px-2 focus-visible:outline-2 focus-visible:outline-brand"
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
        <button ref={toggle} type="button" aria-expanded={open} aria-controls="main-menu" onClick={() => setOpen((value) => !value)} className="flex min-h-12 shrink-0 items-center justify-center rounded-card border border-border px-3 text-sm font-semibold text-brand focus-visible:outline-2 focus-visible:outline-brand xl:hidden">{open ? "Close" : "Menu"}</button>
        </div>
      </div>
      {open && <div id="main-menu" className="absolute inset-x-0 top-full max-h-[calc(100dvh-var(--pc-nav-height))] overflow-y-auto border-b border-border bg-surface p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-card xl:hidden">
        <ul className="mx-auto max-w-5xl space-y-1">
          {LINKS.map((link) => <li key={link.href}><Link href={link.href} onClick={() => setOpen(false)} aria-current={pathname === link.href ? "page" : undefined} className={`flex min-h-14 items-center rounded-card px-4 text-base font-semibold focus-visible:outline-2 focus-visible:outline-brand ${link.href === "/report" ? "bg-brand text-surface" : pathname === link.href ? "bg-bg text-brand" : "text-text"}`}>{link.label}</Link></li>)}
        </ul>
      </div>}
      {!open && pathname !== "/report" && pathname !== "/crew" && <Link href="/report" className="fixed inset-x-4 bottom-[calc(env(safe-area-inset-bottom)+1rem)] z-50 flex min-h-12 items-center justify-center rounded-card bg-brand px-4 font-semibold text-surface shadow-card focus-visible:outline-2 focus-visible:outline-brand sm:hidden">Report hazard</Link>}
    </nav>
  );
}
