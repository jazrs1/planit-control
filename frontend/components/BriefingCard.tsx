"use client";

import Link from "next/link";
import { useId, useState } from "react";
import type { Briefing, BriefingKeyNumbers, GoStatus } from "@shared/types";
import { useDemoCode } from "@/components/DemoCode";
import { GO_LABEL, KEY_NUMBER_LABEL, briefingDay, formatForDate } from "@/lib/briefings";
import { briefingHeadline } from "@/lib/crew";
import { factorHazardLabel, riskLevel } from "@/lib/risk";
import { formatPageTime } from "@/lib/siteTime";
import { formatAgo } from "@/lib/time";

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

const RISK_STYLES = {
  green: { text: "text-risk-green", shape: "pc-shape--green", label: "Low" },
  amber: { text: "text-risk-amber", shape: "pc-shape--amber", label: "Elevated" },
  red: { text: "text-risk-red", shape: "pc-shape--red", label: "High" },
} as const;

// No-go is a solid safety badge; Caution and Go are quiet tints with their shape.
const DECISION: Record<GoStatus, { badge: string; shape: string | null }> = {
  no_go: { badge: "pc-chip--stop", shape: null },
  caution: { badge: "bg-risk-amber-bg text-risk-amber", shape: "pc-shape--amber" },
  go: { badge: "bg-risk-green-bg text-risk-green", shape: "pc-shape--green" },
};

// Who wrote it: one small line inside the details only, never on the card face or footer.
const SOURCE = { claude: "Written by Claude", gemini: "Written by Gemini", template: "Standard template" } as const;

function keyValue(key: keyof BriefingKeyNumbers, v: number) {
  switch (key) {
    case "hazard_index": return v.toFixed(1);
    case "max_heat_index_f": return `${Math.round(v)}°F`;
    case "lightning_probability_pct":
    case "soil_moisture_pct": return `${Math.round(v)}%`;
    case "rain_in": return `${v.toFixed(1)} in`;
    case "wildfire_detections_25mi": return String(v);
  }
}

/** The index with its band: "7.0 ◆ High". Greyed when the briefing is last known. */
function IndexValue({ value, uncertain }: { value: number; uncertain: boolean }) {
  const risk = RISK_STYLES[riskLevel(value)];
  return <>
    {keyValue("hazard_index", value)}
    <span className={`ms-2 inline-flex items-center gap-1.5 text-xs font-semibold ${uncertain ? "text-muted" : risk.text}`}>
      <span aria-hidden="true" className={`pc-shape ${uncertain ? "pc-shape--unknown" : risk.shape}`} />{risk.label}
    </span>
  </>;
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
  /** List view: verdict, site, headline and index up front; risks, actions and numbers behind "Show details". */
  collapsible?: boolean;
  /** Regenerate this site's briefing (POST /briefing/send-now). Omit to hide the button (demo mode). */
  onRegenerate?: () => Promise<void>;
};

export default function BriefingCard({ siteId, siteName, timeZone, entry, nowMs, connectionLost = false, linkSite = false, collapsible = false, onRegenerate }: BriefingCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [fullText, setFullText] = useState(false);
  const detailsId = useId();
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
  const index = typeof b?.key_numbers?.hazard_index === "number" && !unavailable.has("hazard_index") ? b.key_numbers.hazard_index : null;
  const ago = b && nowMs !== null ? formatAgo(Math.max(0, nowMs - Date.parse(b.generated_at))) : null;
  // "Sun, Oct 18 · Tomorrow", or last night's briefing: "Sat, Oct 17 · Today · Next briefing at 6 PM".
  const when = b && <>
    {formatForDate(b.for_date)}
    {day === "tomorrow" && <>{" · "}Tomorrow</>}
    {day === "today" && <>{" · "}Today{" · "}Next briefing at 6 PM</>}
  </>;

  // Risks and actions side by side on the site page, stacked in the list.
  const lists = b && (structured ? (
    <div className={`grid gap-6 ${collapsible ? "" : "md:grid-cols-2 md:gap-10"}`}>
      {b.risks && b.risks.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs text-muted">Top risks</h3>
          <ol className="flex max-w-[68ch] list-decimal flex-col gap-2 ps-5">{b.risks.map((r, i) => <li key={i}>{r}</li>)}</ol>
        </section>
      )}
      {b.actions && b.actions.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs text-muted">Actions</h3>
          <ul className="flex max-w-[68ch] list-disc flex-col gap-2 ps-5">{b.actions.map((a, i) => <li key={i}>{a}</li>)}</ul>
        </section>
      )}
    </div>
  ) : (
    <p className="max-w-[68ch] whitespace-pre-wrap">{b.text}</p>
  ));

  // The key numbers in one row, each value under its label. The list already shows the index up front.
  const numbers = b && (
    <dl className={`grid grid-cols-2 gap-x-6 gap-y-4 ${collapsible ? "sm:grid-cols-3" : "sm:grid-cols-3 lg:grid-cols-6"}`}>
      {(Object.keys(KEY_NUMBER_LABEL) as (keyof BriefingKeyNumbers)[]).filter((key) => !collapsible || key !== "hazard_index").map((key) => {
        const v = b.key_numbers?.[key];
        const missing = unavailable.has(key) || typeof v !== "number";
        return (
          <div key={key} className="flex min-w-0 flex-col">
            <dt className="text-xs text-muted">{KEY_NUMBER_LABEL[key]}</dt>
            <dd className="text-xl font-semibold tabular-nums">
              {missing || v === undefined
                ? <span className="text-muted" title="No live data behind this number">—<span className="sr-only">no live data</span></span>
                : key === "hazard_index" ? <IndexValue value={v} uncertain={uncertain} /> : keyValue(key, v)}
            </dd>
          </div>
        );
      })}
    </dl>
  );

  const factors = b?.top_factors && b.top_factors.length > 0 && (
    <p className="text-xs text-muted">
      Main factors: {b.top_factors.map((f, i) => <span key={i}>{i > 0 && " · "}{factorHazardLabel(f.hazard)} {Math.round(f.weight * 100)}%</span>)}
    </p>
  );

  const source = b?.generator ? <p className="text-xs text-muted">{SOURCE[b.generator]}</p> : null;
  const fullTextBlock = structured && fullText && b && <p className="pc-reveal max-w-[68ch] whitespace-pre-wrap text-muted">{b.text}</p>;

  const regenerateLink = onRegenerate && entry.kind !== "loading" && (
    <button type="button" disabled={busy} onClick={() => void regenerate()} className="pc-link text-xs text-muted disabled:opacity-50">
      {busy ? "Regenerating…" : entry.kind === "briefing" ? "Regenerate" : "Generate now"}
    </button>
  );

  const badge = b && (
    <span
      className={`pc-chip shrink-0 ${go && !uncertain ? DECISION[go].badge : "pc-chip--unknown"}`}
      aria-label={go ? `${GO_LABEL[go]}${uncertain ? ", may be out of date" : ""}` : "No go / no-go decision"}
    >
      {go && !uncertain && DECISION[go].shape && <span aria-hidden="true" className={`pc-shape ${DECISION[go].shape}`} />}
      {go ? `${GO_LABEL[go]}${uncertain ? "?" : ""}` : "No decision"}
    </span>
  );

  const status = <>
    {entry.kind === "none" && <p className="text-muted">No briefing yet. Briefings are generated at 6 PM site time.</p>}
    {entry.kind === "loading" && <div role="status" className="space-y-2"><span className="sr-only">Loading briefing…</span><div aria-hidden="true" className="pc-skeleton pc-skeleton--line w-full text-xl" /><div aria-hidden="true" className="pc-skeleton pc-skeleton--line w-2/3 text-xl" /></div>}
    {entry.kind === "unknown" && <p className="font-semibold text-muted">Briefing unknown: couldn&apos;t load it from the server.</p>}
  </>;

  const article = `flex flex-col gap-6 rounded-card bg-surface p-6 max-sm:p-5 ${b && !uncertain ? "shadow-card" : "border-2 border-dashed border-border"}`;

  // /briefings: decision, site, headline and index up front; numbers, risks and actions behind "Show details".
  if (collapsible) {
    return (
      <article className={`${article} gap-4`}>
        <header className="flex flex-col gap-1">
          <div className="flex items-start justify-between gap-3">
            <h2 className="min-w-0 break-words font-semibold">
              {linkSite ? <Link href={`/sites/${siteId}`} className="hover:underline focus-visible:outline-2 focus-visible:outline-notice">{siteName}</Link> : siteName}
            </h2>
            {badge}
          </div>
          {b && <p className="text-xs text-muted">{when}</p>}
        </header>
        {status}
        {b && (
          <div className={`flex flex-col gap-4 ${uncertain ? "text-muted" : ""}`}>
            {day === "old" && <p role="status" className="font-semibold">Old briefing: no newer one has been generated.</p>}
            <p className="text-xl font-semibold leading-snug text-balance">{briefingHeadline(b)}</p>
            {index !== null && <p className="flex items-baseline gap-2"><span className="text-xs text-muted">Hazard index</span><span className="font-semibold"><IndexValue value={index} uncertain={uncertain} /></span></p>}
          </div>
        )}
        <footer className="flex flex-wrap items-center justify-between gap-x-6">
          <span className="flex items-center gap-6">
            {b && <button type="button" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen((v) => !v)} className="pc-link text-xs">{open ? "Hide details" : "Show details"}</button>}
            {regenerateLink}
          </span>
          <p className="text-xs text-muted">
            {b ? <>Generated {ago ?? formatPageTime(b.generated_at, timeZone, nowMs)}{connectionLost && <>{" · "}last known</>}</> : entry.kind === "none" ? "No briefing stored" : entry.kind === "loading" ? "Loading…" : "Not loaded"}
          </p>
        </footer>
        {b && open && (
          <div id={detailsId} className={`pc-reveal flex flex-col gap-6 ${uncertain ? "text-muted" : ""}`}>
            {numbers}
            {lists}
            {factors}
            {structured && <button type="button" aria-expanded={fullText} onClick={() => setFullText((v) => !v)} className="pc-link self-start text-xs">{fullText ? "Hide full briefing text" : "Full briefing text"}</button>}
            {fullTextBlock}
            {source}
          </div>
        )}
        {demoCode.form}
        {error && <p role="alert" className="text-risk-red">Couldn&apos;t regenerate: {error}</p>}
      </article>
    );
  }

  // Site page: everything shown, key numbers right under the headline.
  return (
    <article className={article}>
      <header className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xs text-muted">
            {day === "today" ? "Today’s briefing" : day === "tomorrow" || !b ? "Tomorrow’s briefing" : "Briefing"}
            {b && <>{" · "}{formatForDate(b.for_date)}</>}
            {day === "today" && <>{" · "}Next briefing at 6 PM</>}
          </h2>
          {badge}
        </div>
        {b && <p className={`max-w-[68ch] text-xl font-semibold leading-snug text-balance ${uncertain ? "text-muted" : ""}`}>{briefingHeadline(b)}</p>}
      </header>
      {status}
      {b && (
        <div className={`flex flex-col gap-6 ${uncertain ? "text-muted" : ""}`}>
          {day === "old" && <p role="status" className="font-semibold">Old briefing: no newer one has been generated.</p>}
          {numbers}
          {lists}
          {factors}
          {fullTextBlock}
          {fullText && source}
        </div>
      )}
      <footer className="flex flex-wrap items-center justify-between gap-x-6">
        <p className="text-xs text-muted">
          {b ? (
            <>
              Generated <span className="whitespace-nowrap">{formatPageTime(b.generated_at, timeZone, nowMs)}{ago && `, ${ago}`}</span>
              {connectionLost && <>{" · "}last known</>}
            </>
          ) : entry.kind === "none" ? "No briefing stored" : entry.kind === "loading" ? "Loading…" : "Not loaded"}
        </p>
        <span className="flex items-center gap-6">
          {structured && <button type="button" aria-expanded={fullText} onClick={() => setFullText((v) => !v)} className="pc-link text-xs">{fullText ? "Hide full text" : "Full briefing text"}</button>}
          {regenerateLink}
        </span>
      </footer>
      {demoCode.form}
      {error && <p role="alert" className="text-risk-red">Couldn&apos;t regenerate: {error}</p>}
    </article>
  );
}
