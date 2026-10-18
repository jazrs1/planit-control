"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Site } from "@shared/types";
import { SITE_FILTERS, SITE_FILTER_LABEL, filterCounts, siteBand, siteListView } from "@/lib/siteFinder";
import type { SiteFilter } from "@/lib/siteFinder";

// "Sites by risk" on the dashboard: search, one-at-a-time filter chips and, by default, low-risk sites
// folded into one row. The dashboard keeps its order, its rows (renderSite) and every real-vs-replay
// rule; this only decides which rows show. Counts and groups follow the view's sites (lib/siteFinder.ts).

type SiteListFinderProps = {
  /** Sites in the dashboard's order (real stop-work first, then by live hazard index). */
  sites: Site[];
  /** Sites whose row shows a lightning stop-work in this view: real only in Live view. */
  stops: ReadonlySet<string>;
  /** Whether the stop-work set is confirmed: "stale" shows "?" on its count, "unknown" shows "—". */
  alertsState: "known" | "stale" | "unknown";
  /** One row of the list (the dashboard's SiteCard). */
  renderSite: (site: Site) => ReactNode;
  /** A site that must be visible (e.g. picked on the map): opens the low-risk group when it's in it, and
   *  clears a search or filter that hides it. */
  revealId?: string | null;
  /** The row element for each site, so the dashboard can scroll a picked site into view. */
  itemRef?: (siteId: string, element: HTMLLIElement | null) => void;
  /** Classes for the scrolling list (the dashboard's overflow rules). */
  listClassName?: string;
};

function SearchIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true" className="pointer-events-none absolute inset-s-3 top-1/2 size-4 -translate-y-1/2 text-muted"><circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="m13 13 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>;
}

export default function SiteListFinder({ sites, stops, alertsState, renderSite, revealId = null, itemRef, listClassName = "" }: SiteListFinderProps) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SiteFilter>("all");
  const [lowOpen, setLowOpen] = useState(false);
  const counts = useMemo(() => filterCounts(sites, stops), [sites, stops]);
  const view = useMemo(() => siteListView(sites, { query, filter, stops }), [sites, query, filter, stops]);
  const searching = query.trim() !== "";

  // A site picked elsewhere (the map) is never hidden: not by a search or filter, nor inside the folded
  // group. Only when the pick changes, so typing a new search afterwards isn't undone.
  const latest = useRef({ sites, stops, view });
  useEffect(() => { latest.current = { sites, stops, view }; });
  useEffect(() => {
    if (!revealId) return;
    const { sites: all, stops: stopped, view: current } = latest.current;
    const site = all.find((s) => s.id === revealId);
    if (!site) return;
    if (current.low.includes(site)) { setLowOpen(true); return; }
    if (current.shown.includes(site)) return;
    setQuery("");
    setFilter("all");
    if (siteBand(site) === "low" && !stopped.has(site.id)) setLowOpen(true);
  }, [revealId]);

  const countText = (f: SiteFilter) => f !== "stop" || alertsState === "known" ? String(counts[f]) : alertsState === "stale" ? `${counts[f]}?` : "—";
  const total = view.shown.length + view.low.length;
  const row = (site: Site) => <li key={site.id} ref={itemRef ? (element) => itemRef(site.id, element) : undefined}>{renderSite(site)}</li>;

  return (
    <div className="flex min-h-0 min-w-0 flex-col">
      <div className="flex shrink-0 flex-col gap-3 px-5 pbs-4 pbe-3">
        <div className="relative">
          <label htmlFor={`${id}-search`} className="sr-only">Search sites by plant name or county</label>
          <SearchIcon />
          <input
            id={`${id}-search`} type="search" value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder="Search plant or county" autoComplete="off" spellCheck={false}
            onKeyDown={(event) => { if (event.key === "Escape" && query) { event.preventDefault(); setQuery(""); } }}
            className="min-h-11 w-full rounded-card border border-border-strong bg-surface ps-9 pe-11 text-text placeholder:text-muted focus-visible:outline-2 focus-visible:outline-notice [&::-webkit-search-cancel-button]:appearance-none"
          />
          {query && (
            <button type="button" onClick={() => setQuery("")} aria-label="Clear search" className="absolute inset-e-0 top-0 grid size-11 place-items-center text-muted hover:text-text focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-notice">
              <svg viewBox="0 0 20 20" aria-hidden="true" className="size-4"><path d="m5 5 10 10M15 5 5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
            </button>
          )}
        </div>
        <div role="group" aria-label="Filter sites by risk" className="flex max-w-full flex-wrap gap-0.5 self-start rounded-card bg-surface-2 p-1">
          {SITE_FILTERS.map((f) => (
            <button
              key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}
              className={`min-h-9 rounded-[6px] px-2.5 text-xs font-semibold whitespace-nowrap focus-visible:outline-2 focus-visible:outline-notice ${filter === f ? "bg-surface text-text shadow-card" : "text-muted hover:text-text"}`}
            >
              {SITE_FILTER_LABEL[f]} <span className={`font-normal tabular-nums ${f === "stop" && counts.stop > 0 && alertsState === "known" ? "text-risk-red" : "text-muted"}`}>{countText(f)}</span>
            </button>
          ))}
        </div>
        <p role="status" className={searching || filter !== "all" ? "text-xs text-muted" : "sr-only"}>
          {total === 0 ? "No sites match" : `${total} of ${sites.length} ${sites.length === 1 ? "site" : "sites"}`}
        </p>
      </div>

      {total === 0 ? (
        <div className="flex flex-col items-start gap-1 px-5 py-6">
          <p className="font-semibold">No sites match{searching ? ` “${query.trim()}”` : ""}</p>
          <div className="flex flex-wrap gap-x-6">
            {searching && <button type="button" onClick={() => setQuery("")} className="pc-link text-xs">Clear search</button>}
            {filter !== "all" && <button type="button" onClick={() => setFilter("all")} className="pc-link text-xs">Show all sites</button>}
          </div>
        </div>
      ) : (
        <ul className={`relative divide-y divide-border/70 ${listClassName}`}>
          {view.shown.map(row)}
          {view.low.length > 0 && <>
            <li>
              <button
                type="button" aria-expanded={lowOpen} aria-controls={lowOpen ? `${id}-low` : undefined} onClick={() => setLowOpen((open) => !open)}
                className="flex min-h-14 w-full items-center gap-3 px-4 py-2 text-start focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-notice hover:bg-surface-2/60"
              >
                <span aria-hidden="true" className="pc-shape pc-shape--green" />
                <span className="flex-1 font-semibold">Low risk · {view.low.length} {view.low.length === 1 ? "site" : "sites"}</span>
                <svg viewBox="0 0 20 20" aria-hidden="true" className={`size-4 text-muted motion-safe:transition-transform ${lowOpen ? "rotate-180" : ""}`}><path d="m5 8 5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
            </li>
            {lowOpen && <li id={`${id}-low`} className="pc-reveal"><ul className="divide-y divide-border/70">{view.low.map(row)}</ul></li>}
          </>}
        </ul>
      )}
    </div>
  );
}
