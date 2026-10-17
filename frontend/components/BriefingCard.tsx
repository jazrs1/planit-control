"use client";

import Link from "next/link";
import { useState } from "react";
import type { Briefing, BriefingKeyNumbers } from "@shared/types";
import { useDemoCode } from "@/components/DemoCode";
import { GO_LABEL, GO_STYLE, KEY_NUMBER_LABEL, briefingDay, formatForDate } from "@/lib/briefings";
import { factorHazardLabel, riskLevel } from "@/lib/risk";
import { formatAgo, formatSiteDateTime } from "@/lib/time";

// One site's next-day briefing. Used on /briefings and on the site detail page.
// Structure follows SiteCard: shared/types props, token colors, risk color via riskLevel().
// Every Briefing field beyond the original contract is optional, so each one is rendered only when present.

export type BriefingEntry =
  | { kind: "briefing"; briefing: Briefing }
  /** The backend has no briefing for this site yet (GET returned 404). Known, not unknown. */
  | { kind: "none" }
  /** Couldn't load: the briefing is unknown. */
  | { kind: "unknown" }
  /** First request still in flight. */
  | { kind: "loading" };

const RISK_BADGE = { green: "bg-risk-green-bg text-risk-green", amber: "bg-risk-amber-bg text-risk-amber", red: "bg-risk-red-bg text-risk-red" } as const;

function keyValue(key: keyof BriefingKeyNumbers, v: number) {
  switch (key) {
    case "hazard_index": return `${v.toFixed(1)} / 10`;
    case "max_heat_index_f": return `${Math.round(v)}°F`;
    case "lightning_probability_pct":
    case "soil_moisture_pct": return `${Math.round(v)}%`;
    case "rain_in": return `${v.toFixed(1)} in`;
    case "wildfire_detections_25mi": return String(v);
  }
}

type BriefingCardProps = {
  siteId: string;
  siteName: string;
  timeZone: string;
  entry: BriefingEntry;
  /** "Now" for today/tomorrow and ages: real time, or the demo clock in demo mode. null until mounted. */
  nowMs: number | null;
  /** Connection lost: this is the last known briefing. */
  connectionLost?: boolean;
  /** Link the site name to its detail page (on /briefings). */
  linkSite?: boolean;
  /** Regenerate this site's briefing (POST /briefing/send-now). Omit to hide the button (demo mode). */
  onRegenerate?: () => Promise<void>;
};

export default function BriefingCard({ siteId, siteName, timeZone, entry, nowMs, connectionLost = false, linkSite = false, onRegenerate }: BriefingCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const demoCode = useDemoCode();

  async function regenerate() {
    if (!onRegenerate) return;
    setBusy(true);
    setError(null);
    try {
      // Regenerating calls a paid model, so it needs the demo code: on a 401 this asks for it, then retries.
      await demoCode.call(onRegenerate, () => void regenerate());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const b = entry.kind === "briefing" ? entry.briefing : null;
  const day = b && nowMs !== null ? briefingDay(b.for_date, timeZone, nowMs) : null;
  // Last known or an old briefing: keep it visible but greyed with "?", never as current.
  const uncertain = b !== null && (connectionLost || day === "old");
  const go = b?.go_status ?? null;
  const unavailable = new Set(b?.unavailable ?? []);
  const structured = (b?.risks?.length ?? 0) > 0 || (b?.actions?.length ?? 0) > 0;
  const title = linkSite
    ? <Link href={`/sites/${siteId}`} className="text-brand hover:underline focus-visible:outline-2 focus-visible:outline-brand">{siteName}</Link>
    : "Tomorrow's briefing";

  return (
    <article className={`flex flex-col gap-3 rounded-card border bg-surface p-4 ${b && !uncertain ? "border-border" : "border-dashed border-border"}`}>
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="break-words text-base font-semibold text-text">{title}</h2>
          {b && (
            <p className="text-sm text-muted">
              For {formatForDate(b.for_date)}
              {day === "tomorrow" && " · tomorrow"}
              {day === "today" && " · today (tomorrow's briefing comes at 6 PM site time)"}
            </p>
          )}
        </div>
        {b && (
          <span
            className={`shrink-0 rounded-chip px-3 py-1 text-sm font-bold uppercase tracking-wide ${go && !uncertain ? GO_STYLE[go] : "bg-bg text-muted"}`}
            aria-label={go ? `${GO_LABEL[go]}${uncertain ? ", may be out of date" : ""}` : "No go / no-go decision"}
          >
            {go ? `${GO_LABEL[go]}${uncertain ? "?" : ""}` : "No decision"}
          </span>
        )}
      </header>

      {entry.kind === "none" && <p className="text-sm text-muted">No briefing yet. Briefings are generated at 6 PM site time.</p>}
      {entry.kind === "loading" && <p role="status" className="text-sm text-muted">Loading briefing…</p>}
      {entry.kind === "unknown" && <p className="text-sm font-medium text-muted">Briefing unknown · couldn&apos;t load it from the server.</p>}

      {b && (
        <div className={`flex flex-col gap-3 ${uncertain ? "text-muted" : ""}`}>
          {day === "old" && <p role="status" className="text-sm font-semibold">Old briefing: no newer one has been generated.</p>}
          {b.headline && <p className="font-semibold">{b.headline}</p>}

          {structured ? (
            <>
              {b.risks && b.risks.length > 0 && (
                <section>
                  <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Top risks</h3>
                  <ol className="mbs-1 list-decimal space-y-1 ps-5 text-sm">{b.risks.map((r, i) => <li key={i}>{r}</li>)}</ol>
                </section>
              )}
              {b.actions && b.actions.length > 0 && (
                <section>
                  <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Actions</h3>
                  <ul className="mbs-1 list-disc space-y-1 ps-5 text-sm">{b.actions.map((a, i) => <li key={i}>{a}</li>)}</ul>
                </section>
              )}
            </>
          ) : (
            <p className="whitespace-pre-wrap text-sm">{b.text}</p>
          )}

          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
            {(Object.keys(KEY_NUMBER_LABEL) as (keyof BriefingKeyNumbers)[]).map((key) => {
              const missing = unavailable.has(key) || typeof b.key_numbers?.[key] !== "number";
              const v = b.key_numbers?.[key];
              return (
                <div key={key} className="flex justify-between gap-2">
                  <dt className="text-muted">{KEY_NUMBER_LABEL[key]}</dt>
                  <dd className="font-medium tabular-nums">
                    {missing || v === undefined
                      ? <span className="text-muted" title="No live data behind this number">—<span className="sr-only">no live data</span></span>
                      : key === "hazard_index"
                        ? <span className={`whitespace-nowrap rounded-chip px-2 ${uncertain ? "" : RISK_BADGE[riskLevel(v)]}`}>{keyValue(key, v)}</span>
                        : keyValue(key, v)}
                  </dd>
                </div>
              );
            })}
          </dl>

          {b.top_factors && b.top_factors.length > 0 && (
            <p className="text-xs text-muted">
              Why: {b.top_factors.map((f) => `${factorHazardLabel(f.hazard)} (${Math.round(f.weight * 100)}%)`).join(" · ")}
            </p>
          )}
          {structured && (
            <details className="text-sm">
              <summary className="cursor-pointer text-brand">Full briefing text</summary>
              <p className="mbs-1 whitespace-pre-wrap">{b.text}</p>
            </details>
          )}
        </div>
      )}

      <footer className="mbs-auto flex flex-wrap items-center justify-between gap-2 border-bs border-border pbs-3 text-xs text-muted">
        <p>
          {b ? (
            <>
              Generated {formatSiteDateTime(b.generated_at, timeZone)}
              {nowMs !== null && ` · ${formatAgo(Math.max(0, nowMs - Date.parse(b.generated_at)))}`}
              {b.generator === "claude" && ` · Written by Claude${b.model ? ` (${b.model})` : ""}`}
              {b.generator === "gemini" && ` · Written by Gemini${b.model ? ` (${b.model})` : ""}`}
              {b.generator === "template" && " · Template"}
              {connectionLost && " · last known"}
            </>
          ) : entry.kind === "none" ? "No briefing stored" : entry.kind === "loading" ? "Loading…" : "Not loaded"}
        </p>
        {onRegenerate && entry.kind !== "loading" && (
          <button type="button" disabled={busy} onClick={() => void regenerate()} className="min-h-11 rounded-card border-2 border-rule px-3 text-sm font-semibold text-brand hover:bg-bg focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50">
            {busy ? "Regenerating…" : entry.kind === "briefing" ? "Regenerate" : "Generate now"}
          </button>
        )}
      </footer>
      {demoCode.form}
      {error && <p role="alert" className="text-sm text-risk-red">Couldn&apos;t regenerate: {error}</p>}
    </article>
  );
}
