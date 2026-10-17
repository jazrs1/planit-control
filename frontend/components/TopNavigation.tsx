"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAlertsState } from "@/components/AlertsProvider";
import { countAlerts, realAlerts } from "@/lib/alerts";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/alerts", label: "Alerts" },
  { href: "/crew", label: "Crew view" },
  { href: "/report", label: "Report hazard" },
  { href: "/reports", label: "Reports" },
  { href: "/briefings", label: "Briefings" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/about", label: "About" },
];

export default function TopNavigation() {
  const { alerts: allAlerts, status } = useAlertsState();
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
  // Real alerts only: a storm replay never adds to the badge (its counts are on the replay timeline).
  const alerts = allAlerts === null ? null : realAlerts(allAlerts);
  const counts = countAlerts(alerts ?? []);
  const count = (value: number) => alerts === null ? "—" : `${value}${status === "stale" ? "?" : ""}`;
  const breakdown = `${count(counts.lightning)} stop work · ${count(counts.flood)} flood risk${counts.other ? ` · ${count(counts.other)} other` : ""}`;
  // Unknown is not zero: never show a quiet "0" before real alerts have loaded. Solid color only for
  // something to act on: red for a stop-work, amber for flood risk alone.
  const badge = alerts === null
    ? { text: "—", label: "Alerts, connecting to server", style: "pc-chip--unknown" }
    : status === "stale"
    ? { text: `${alerts.length}?`, label: `Alerts, ${alerts.length} last known, connection lost`, style: "pc-chip--unknown" }
    : {
      text: String(alerts.length),
      label: `Alerts, ${alerts.length} active${status === "demo" ? ", demo data" : ""}`,
      style: counts.lightning > 0 ? "bg-risk-red-solid text-on-risk-red" : alerts.length > 0 ? "bg-risk-amber-solid text-on-risk-amber" : "bg-on-bar text-bar",
    };
  const linkStyle = (href: string) => `flex min-h-10 items-center px-2.5 text-[0.8125rem] font-bold tracking-[0.02em] focus-visible:outline-2 focus-visible:outline-offset-2 ${pathname === href ? "bg-on-bar text-bar" : "text-bar-muted hover:text-on-bar"}`;

  return (
    <nav ref={nav} aria-label="Main navigation" className="relative z-50 h-(--pc-nav-height) border-be-2 border-bar bg-bar text-on-bar">
      <div className="flex h-full items-center gap-3 px-3 sm:px-4">
        <Link href="/" className="flex min-h-12 shrink-0 items-center gap-2.5 focus-visible:outline-2 focus-visible:outline-offset-2" aria-label="PlanIT Control dashboard">
          <img src="/icon.svg" width={30} height={30} alt="" className="shrink-0" />
          <span className="text-[0.95rem] font-black uppercase tracking-[0.05em]">PlanIT<span className="hidden text-risk-amber-solid sm:inline"> Control</span></span>
        </Link>
        <div className="ms-auto hidden items-center gap-0.5 xl:flex">
          {LINKS.filter((link) => link.href !== "/alerts").map((link) => <Link key={link.href} href={link.href} aria-current={pathname === link.href ? "page" : undefined} className={linkStyle(link.href)}>{link.label}</Link>)}
        </div>
        <div className="ms-auto flex min-w-0 items-center gap-2 xl:ms-2">
        <Link
          href="/alerts"
          onClick={() => setOpen(false)}
          aria-current={pathname === "/alerts" ? "page" : undefined}
          className={`flex min-h-12 min-w-0 max-w-48 flex-col justify-center px-2 focus-visible:outline-2 focus-visible:outline-offset-2 ${pathname === "/alerts" ? "bg-on-bar text-bar" : ""}`}
          aria-label={`${badge.label}, ${breakdown}`}
        >
          <span className="flex flex-wrap items-center gap-x-1.5">
          <span className="pc-label">Alerts</span>
          <span aria-hidden="true" className={`pc-chip min-w-7 justify-center text-[0.8125rem] tabular-nums ${badge.style}`}>
            {badge.text}
          </span>
          {(alerts === null || status === "stale") && (
            <span aria-hidden="true" className="text-xs font-semibold opacity-80">
              {status === "unreachable" || status === "stale" ? "Offline" : "Connecting…"}
            </span>
          )}
          {status === "demo" && <span aria-hidden="true" className="pc-chip pc-chip--unknown">Demo data</span>}
          </span>
          <span aria-hidden="true" className="text-[0.6875rem] opacity-80 tabular-nums">{breakdown}</span>
        </Link>
        <button ref={toggle} type="button" aria-expanded={open} aria-controls="main-menu" onClick={() => setOpen((value) => !value)} className="pc-label flex min-h-11 shrink-0 items-center justify-center border-2 border-on-bar px-3 active:scale-97 focus-visible:outline-2 focus-visible:outline-offset-2 xl:hidden">{open ? "Close" : "Menu"}</button>
        </div>
      </div>
      {open && <div id="main-menu" className="absolute inset-x-0 inset-bs-full max-h-[calc(100dvh-var(--pc-nav-height))] overflow-y-auto overscroll-contain border-be-2 border-rule bg-surface p-4 pbe-[max(1rem,env(safe-area-inset-bottom,0px))] text-text xl:hidden">
        <ul className="mx-auto max-w-5xl space-y-1">
          {LINKS.map((link) => <li key={link.href}><Link href={link.href} onClick={() => setOpen(false)} aria-current={pathname === link.href ? "page" : undefined} className={`flex min-h-14 items-center px-4 text-base font-extrabold uppercase tracking-[0.04em] focus-visible:outline-2 ${link.href === "/report" ? "bg-brand text-on-brand" : pathname === link.href ? "border-s-4 border-rule bg-surface-2" : ""}`}>{link.label}</Link></li>)}
        </ul>
      </div>}
      {!open && pathname !== "/report" && pathname !== "/crew" && <Link href="/report" className="pc-btn pc-btn--primary pc-btn--large fixed inset-x-4 inset-be-[calc(env(safe-area-inset-bottom,0px)+1rem)] z-50 shadow-float sm:hidden">Report hazard</Link>}
    </nav>
  );
}
