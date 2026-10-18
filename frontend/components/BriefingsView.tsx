"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Briefing, GoStatus, Site } from "@shared/types";
import { useAlertsState, useServerNow } from "@/components/AlertsProvider";
import BriefingCard from "@/components/BriefingCard";
import type { BriefingEntry } from "@/components/BriefingCard";
import { useDemoCode } from "@/components/DemoCode";
import { DEMO_DATA, getSites, sendBriefingNow } from "@/lib/api";
import { GO_LABEL } from "@/lib/briefings";
import { loadBriefings } from "@/lib/loadBriefings";
import type { BriefingResult } from "@/lib/loadBriefings";
import { usePolling } from "@/lib/usePolling";

// Briefings change once a day (6 PM site time) or on send-now, so poll slowly, except right after
// "Send briefings now", when they arrive one by one from the background job (all 55 take ~15-20 min
// with Gemini). Each poll is one cached GET /briefings, so following for longer is cheap.
const POLL_MS = 5 * 60_000;
const FOLLOW_MS = 5_000;
const FOLLOW_FOR_MS = 25 * 60_000;
const RETRY_MS = 5_000;

type Filter = "all" | GoStatus;
const FILTERS: Filter[] = ["all", "go", "caution", "no_go"];

type Loaded = { sites: Site[]; results: Record<string, BriefingResult> };

function toEntry(result: BriefingResult | undefined): BriefingEntry {
  if (result === undefined || result === "error") return { kind: "unknown" };
  return result === null ? { kind: "none" } : { kind: "briefing", briefing: result };
}

/** Merge a refresh into the last good data: a briefing that failed to reload stays, marked stale. */
function merge(prev: Loaded | null, next: Loaded): { data: Loaded; staleIds: Set<string> } {
  const staleIds = new Set<string>();
  const results = { ...next.results };
  for (const [id, r] of Object.entries(results)) {
    const old = prev?.results[id];
    if (r === "error" && old && old !== "error") {
      results[id] = old;
      staleIds.add(id);
    }
  }
  return { data: { sites: next.sites, results }, staleIds };
}

export default function BriefingsView({ initial }: { initial: Loaded | null }) {
  const { status, setDemo, connection } = useAlertsState();
  const serverNow = useServerNow();
  const demo = status === "demo";
  const [live, setLive] = useState<Loaded | null>(initial);
  const [staleIds, setStaleIds] = useState<Set<string>>(new Set());
  const [sitesFailed, setSitesFailed] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [followUntil, setFollowUntil] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendMessage, setSendMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const demoCode = useDemoCode();
  const generation = useRef(0);
  const liveRef = useRef(live);
  useEffect(() => { liveRef.current = live; }, [live]);

  // Leaving demo starts unknown until a real request succeeds (same as the other pages).
  const previousDemo = useRef(demo);
  useEffect(() => {
    if (previousDemo.current !== demo) {
      generation.current++;
      setLive(null);
      setStaleIds(new Set());
      setSitesFailed(false);
      previousDemo.current = demo;
    }
  }, [demo]);

  const refresh = useCallback(async () => {
    if (demo) return;
    const current = generation.current;
    try {
      const sites = await getSites();
      const results = await loadBriefings(sites.map((s) => s.id));
      if (current !== generation.current) return;
      const merged = merge(liveRef.current, { sites, results });
      setLive(merged.data);
      setStaleIds(merged.staleIds);
      setSitesFailed(false);
    } catch {
      // Sites unreachable: keep the last real briefings, greyed and marked last known.
      if (current === generation.current) setSitesFailed(true);
    }
  }, [demo]);

  const following = followUntil > Date.now();
  usePolling(refresh, demo ? null : live === null ? RETRY_MS : following ? FOLLOW_MS : POLL_MS);
  useEffect(() => {
    if (!following) return;
    const timer = window.setTimeout(() => setFollowUntil(0), followUntil - Date.now());
    return () => window.clearTimeout(timer);
  }, [following, followUntil]);

  // Real clock for today/tomorrow and ages (briefings run on real time, even during replay);
  // the demo clock in demo mode, since the sample briefings are fixed.
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNowMs(demo ? serverNow() : Date.now());
    tick();
    const timer = window.setInterval(tick, 60_000);
    return () => window.clearInterval(timer);
  }, [demo, serverNow]);

  // Last known as soon as any request fails (shared connection), or when this page's own refresh failed.
  const connectionLost = !demo && live !== null && (sitesFailed || connection.level !== "online");

  const data: Loaded | null = demo ? { sites: DEMO_DATA.sites, results: DEMO_DATA.briefings } : live;

  const rows = useMemo(() => {
    if (!data) return [];
    return data.sites
      .map((site) => ({ site, entry: toEntry(data.results[site.id]) }))
      // Tomorrow's hazard index, highest first; sites without a briefing last.
      .sort((a, b) => {
        const ai = a.entry.kind === "briefing" ? a.entry.briefing.key_numbers?.hazard_index ?? -1 : -2;
        const bi = b.entry.kind === "briefing" ? b.entry.briefing.key_numbers?.hazard_index ?? -1 : -2;
        return bi - ai || a.site.name.localeCompare(b.site.name);
      });
  }, [data]);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: rows.length, go: 0, caution: 0, no_go: 0 };
    for (const r of rows) if (r.entry.kind === "briefing" && r.entry.briefing.go_status) c[r.entry.briefing.go_status]++;
    return c;
  }, [rows]);
  const missing = rows.filter((r) => r.entry.kind !== "briefing").length;
  const undecided = rows.filter((r) => r.entry.kind === "briefing" && !r.entry.briefing.go_status).length;
  const shown = filter === "all" ? rows : rows.filter((r) => r.entry.kind === "briefing" && r.entry.briefing.go_status === filter);

  async function sendAll() {
    setConfirming(false);
    setSending(true);
    setSendMessage(null);
    try {
      // Needs the demo code: on a 401 this asks for it, then retries.
      await demoCode.call(async () => {
        const res = await sendBriefingNow();
        setSendMessage({ tone: "ok", text: `Generating ${res.queued} briefings in the background. They appear here as they finish.` });
        setFollowUntil(Date.now() + FOLLOW_FOR_MS);
      }, () => void sendAll());
    } catch (err) {
      setSendMessage({ tone: "error", text: `Couldn't send briefings: ${(err as Error).message}` });
    } finally {
      setSending(false);
    }
  }

  const regenerate = useCallback(async (siteId: string) => {
    const res = await sendBriefingNow({ site_id: siteId });
    const fresh: Briefing | undefined = res.generated[0];
    if (!fresh) throw new Error("The server didn't return a briefing.");
    setLive((prev) => (prev ? { ...prev, results: { ...prev.results, [siteId]: fresh } } : prev));
    setStaleIds((prev) => { const next = new Set(prev); next.delete(siteId); return next; });
  }, []);

  if (!data) {
    return (
      <section role="status" className="pc-panel flex flex-col gap-4 p-6 max-sm:p-5">
        <h2 className="text-xl font-semibold">Can&apos;t reach the server</h2>
        <p className="max-w-[68ch] text-muted">Tomorrow&apos;s briefings are unknown. This does not mean conditions are safe. Retrying every 5 seconds.</p>
        <div className="flex flex-wrap items-center gap-6">
          <button type="button" onClick={() => void refresh()} className="pc-btn pc-btn--primary">Retry now</button>
          <button type="button" onClick={() => setDemo(true)} className="pc-link">Show demo data</button>
        </div>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {demo && (
        <p role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted">
          <span className="pc-chip pc-chip--unknown">Demo data</span>
          Sample briefings from shared/mocks, not live conditions.
          <button type="button" onClick={() => setDemo(false)} className="pc-link">Exit demo</button>
        </p>
      )}
      {connectionLost && (
        <p role="alert" className="rounded-card bg-risk-red-bg px-4 py-3 font-semibold text-risk-red">
          Connection lost. Showing the last loaded briefings; ? means it may be out of date.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div role="group" aria-label="Filter by decision" className="flex flex-wrap gap-0.5 rounded-card bg-surface-2 p-1">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={`min-h-10 rounded-[6px] px-4 text-xs font-semibold focus-visible:outline-2 focus-visible:outline-notice ${filter === f ? "bg-surface text-text shadow-card" : "text-muted hover:text-text"}`}
            >
              {f === "all" ? "All" : GO_LABEL[f]} <span className="font-normal tabular-nums text-muted">{counts[f]}{connectionLost ? "?" : ""}</span>
            </button>
          ))}
        </div>
        {!demo && (
          confirming ? (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <span>Regenerate tomorrow&apos;s briefing for all {data.sites.length} sites? This replaces the stored ones.</span>
              <button type="button" onClick={() => void sendAll()} className="pc-btn pc-btn--primary">Regenerate all {data.sites.length}</button>
              <button type="button" onClick={() => setConfirming(false)} className="pc-link">Cancel</button>
            </div>
          ) : (
            <button type="button" disabled={sending} onClick={() => setConfirming(true)} className="pc-btn pc-btn--quiet">
              {sending ? "Sending…" : "Send briefings now"}
            </button>
          )
        )}
      </div>
      {demoCode.form}
      {sendMessage && (
        <p role={sendMessage.tone === "error" ? "alert" : "status"} className={sendMessage.tone === "error" ? "text-risk-red" : "text-muted"}>
          {sendMessage.text}{following && sendMessage.tone === "ok" ? " Checking every 5 seconds…" : ""}
        </p>
      )}

      <p role="status" className="text-xs text-muted">
        {shown.length} {shown.length === 1 ? "site" : "sites"}, highest hazard index tomorrow first.
        {missing > 0 && ` ${missing} ${missing === 1 ? "has" : "have"} no briefing yet.`}
        {undecided > 0 && ` ${undecided} ${undecided === 1 ? "has" : "have"} no go / no-go decision and ${undecided === 1 ? "shows" : "show"} only under All.`}
      </p>

      {shown.length === 0 ? (
        <p className="pc-panel p-6 text-muted">No briefings with this decision.</p>
      ) : (
        // Row by row, highest first: the riskiest card is always top left.
        <ul className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
          {shown.map(({ site, entry }) => (
            <li key={site.id}>
              <BriefingCard
                collapsible
                siteId={site.id}
                siteName={site.name}
                timeZone={site.timezone}
                entry={entry}
                nowMs={nowMs}
                connectionLost={connectionLost || staleIds.has(site.id)}
                linkSite
                onRegenerate={demo ? undefined : () => regenerate(site.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
