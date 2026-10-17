"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Briefing, GoStatus, Site } from "@shared/types";
import { useAlertsState, useServerNow } from "@/components/AlertsProvider";
import BriefingCard from "@/components/BriefingCard";
import type { BriefingEntry } from "@/components/BriefingCard";
import { useDemoCode } from "@/components/DemoCode";
import { DEMO_DATA, getSites, sendBriefingNow } from "@/lib/api";
import { GO_LABEL, GO_STYLE } from "@/lib/briefings";
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
      <section role="status" className="space-y-3 rounded-card border border-border bg-surface p-4">
        <h2 className="font-semibold">Can&apos;t reach the server</h2>
        <p className="text-sm text-muted">Tomorrow&apos;s briefings are unknown. This does not mean conditions are safe. Retrying every 5 seconds.</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void refresh()} className="min-h-11 rounded-card bg-brand px-4 font-semibold text-on-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">Retry now</button>
          <button type="button" onClick={() => setDemo(true)} className="min-h-11 rounded-card border border-border px-4 font-semibold text-brand focus-visible:outline-2 focus-visible:outline-brand">Show demo data</button>
        </div>
      </section>
    );
  }

  return (
    <div className="space-y-4">
      {demo && (
        <div role="status" className="rounded-card border border-border bg-surface p-3 text-sm text-muted">
          <strong>Demo data</strong> · Sample briefings from shared/mocks, not live conditions.
          <button type="button" onClick={() => setDemo(false)} className="min-h-11 px-2 font-semibold text-brand underline">Exit demo</button>
        </div>
      )}
      {connectionLost && (
        <p role="alert" className="rounded-card border border-risk-red bg-risk-red-bg p-3 text-sm font-semibold text-risk-red">
          Connection lost · showing the last loaded briefings · ? = may be out of date
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Filter by decision" className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={`min-h-11 rounded-chip border px-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-brand ${filter === f ? (f === "all" ? "border-brand bg-brand text-surface" : `border-transparent ${GO_STYLE[f]} ring-2 ring-brand`) : "border-border bg-surface text-text"}`}
            >
              {f === "all" ? "All" : GO_LABEL[f]} <span className="tabular-nums">({counts[f]}{connectionLost ? "?" : ""})</span>
            </button>
          ))}
        </div>
        {!demo && (
          confirming ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span>Regenerate tomorrow&apos;s briefing for all {data.sites.length} sites? This replaces the stored ones.</span>
              <button type="button" onClick={() => void sendAll()} className="min-h-11 rounded-card bg-brand px-3 font-semibold text-on-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">Yes, send now</button>
              <button type="button" onClick={() => setConfirming(false)} className="min-h-11 rounded-card border border-border px-3 font-semibold text-text focus-visible:outline-2 focus-visible:outline-brand">Cancel</button>
            </div>
          ) : (
            <button type="button" disabled={sending} onClick={() => setConfirming(true)} className="min-h-11 rounded-card bg-brand px-4 font-semibold text-on-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50">
              {sending ? "Sending…" : "Send briefings now"}
            </button>
          )
        )}
      </div>
      {demoCode.form}
      {sendMessage && (
        <p role={sendMessage.tone === "error" ? "alert" : "status"} className={`text-sm ${sendMessage.tone === "error" ? "text-risk-red" : "text-muted"}`}>
          {sendMessage.text}{following && sendMessage.tone === "ok" ? " Checking every 5 seconds…" : ""}
        </p>
      )}

      <p role="status" className="text-sm text-muted">
        {shown.length} {shown.length === 1 ? "site" : "sites"} · Highest hazard index tomorrow first
        {missing > 0 && ` · ${missing} without a briefing`}
        {undecided > 0 && ` · ${undecided} without a go / no-go decision (shown under All)`}
      </p>

      {shown.length === 0 ? (
        <p className="rounded-card border border-border bg-surface p-4 text-muted">No sites match this filter.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-4 lg:grid-cols-2">
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
