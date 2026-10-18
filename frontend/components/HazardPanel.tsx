"use client";

import { useId, useState } from "react";
import type { ReactNode } from "react";
import type { HazardCard, HazardStatus } from "@shared/types";
import { formatPageTime } from "@/lib/siteTime";
import { formatAgo } from "@/lib/time";

// One hazard card on the site detail page. Structure follows SiteCard: shared/types props, token colors.
// One idea per card: the status, one big value, one sentence; the detail rows sit behind "Show details".
//
// Unknown must look unknown. When a source has no reading yet the backend still fills the card's
// required numbers from a placeholder, so this panel only shows its value and rows when the card is live:
// hazard_status is set and (for polled sources) as_of is set.

// Color only for status: a shape and a word. Danger is a safety state, so it gets the solid red band.
const STATUS_STYLES: Record<HazardStatus, { text: string; shape: string; label: string }> = {
  ok: { text: "text-risk-green", shape: "pc-shape--green", label: "OK" },
  watch: { text: "text-risk-amber", shape: "pc-shape--amber", label: "Watch" },
  danger: { text: "text-on-risk-red", shape: "", label: "Danger" },
};

/** A detail row; a null value renders as an unknown "—", never as zero or "none". */
export type HazardRow = { label: string; value: ReactNode | null };

type Freshness =
  /** Polled source: as_of says when it last produced a reading; older than this is an old reading. */
  | { kind: "polled"; staleAfterMin: number }
  /** Computed on every request (lightning): current whenever the page is. */
  | { kind: "live" };

type HazardPanelProps = {
  title: string;
  card: HazardCard | null | undefined;
  /** The one number the card leads with ("91°F"), and what it is ("Heat index now"). */
  value: string | null;
  caption: string;
  /** An optional small secondary line under the caption ("NWS: 7.1 in"). */
  note?: string | null;
  rows: HazardRow[];
  freshness: Freshness;
  timeZone: string;
  /** Viewer's "now" for reading ages; null until mounted (keeps server and hydration render equal). */
  nowMs: number | null;
  /** The page lost its connection: everything shown is last known. */
  connectionLost: boolean;
  children?: ReactNode;
};

/** "3 hours", "90 minutes", "18 hours". */
function overMinutes(min: number) {
  return min >= 120 && min % 60 === 0 ? `${min / 60} hours` : `${min} minutes`;
}

export default function HazardPanel({ title, card, value, caption, note = null, rows, freshness, timeZone, nowMs, connectionLost, children }: HazardPanelProps) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const status = card?.hazard_status ?? null;
  const asOf = card?.as_of ?? null;
  const live = status !== null && (freshness.kind === "live" || asOf !== null);
  const ageMs = asOf !== null && nowMs !== null ? Math.max(0, nowMs - Date.parse(asOf)) : null;
  const oldReading = freshness.kind === "polled" && ageMs !== null && ageMs > freshness.staleAfterMin * 60_000;
  // Last-known or old data keeps its status but greyed, with "?": it may no longer be true.
  const uncertain = status !== null && (connectionLost || oldReading);
  const style = status === null ? null : STATUS_STYLES[status];
  const band = status === "danger" && !uncertain;
  const hasDetails = live && (rows.length > 0 || !!children);
  const statusLabel = status === null ? `${title}: no data` : `${title}: ${style!.label}${uncertain ? ", may be out of date" : ""}`;

  return (
    <article className={`flex flex-col overflow-clip rounded-card bg-surface ${style && !uncertain ? "shadow-card" : "border-2 border-dashed border-muted"}`}>
      {band && (
        <header className="flex items-center justify-between gap-3 bg-risk-red-solid px-6 py-3 text-on-risk-red max-sm:px-5">
          <h2 className="pc-label">{title}</h2>
          <span className="pc-label" aria-label={statusLabel}>Danger</span>
        </header>
      )}
      <div className="flex flex-1 flex-col gap-4 p-6 max-sm:p-5">
        {!band && (
          <header className="flex items-baseline justify-between gap-3">
            <h2 className="text-xs text-muted">{title}</h2>
            <span aria-label={statusLabel} className={`flex shrink-0 items-center gap-1.5 text-xs font-semibold ${style && !uncertain ? style.text : "text-muted"}`}>
              <span aria-hidden="true" className={`pc-shape ${style && !uncertain ? style.shape : "pc-shape--unknown"}`} />
              {status === null ? "No data" : `${style!.label}${uncertain ? "?" : ""}`}
            </span>
          </header>
        )}

        {live && (
          <div className={uncertain ? "text-muted" : ""}>
            <p className="text-[2rem] font-semibold leading-tight tracking-[-0.01em]">{value ?? "—"}</p>
            <p className="text-xs text-muted">{caption}</p>
            {note && <p className="text-xs text-muted">{note}</p>}
          </div>
        )}

        <p className={`max-w-[68ch] ${live && !uncertain ? "text-text" : "text-muted"}`}>
          {card?.reading ?? (status === null ? "No data from this source yet." : "The source sent numbers but no summary.")}
        </p>

        {hasDetails && open && (
          <div id={detailsId} className="pc-reveal flex flex-col gap-4">
            {rows.length > 0 && (
              <dl className={`flex flex-col gap-2 ${uncertain ? "text-muted" : ""}`}>
                {rows.map((row) => (
                  // Label and value on one line; a long value wraps below its label instead of squeezing it.
                  <div key={row.label} className="flex flex-wrap items-baseline justify-between gap-x-4">
                    <dt className="text-muted">{row.label}</dt>
                    <dd className="ms-auto text-end font-semibold tabular-nums">
                      {row.value ?? <span className="text-muted" title="Not available">—<span className="sr-only">not available</span></span>}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {children}
          </div>
        )}

        <footer className="mbs-auto flex flex-wrap items-center justify-between gap-x-4">
          {hasDetails
            ? <button type="button" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen((v) => !v)} className="pc-link text-xs">{open ? "Hide details" : "Show details"}</button>
            : <span />}
          <p className="ms-auto flex min-h-11 flex-col items-end justify-center text-end text-xs text-muted">
            {freshness.kind === "live"
              ? status === null ? "No live reading" : connectionLost ? "Last known" : "Live"
              : asOf === null
                ? "No live reading yet"
                : <span>As of {formatPageTime(asOf, timeZone, nowMs)}{ageMs !== null && `, ${formatAgo(ageMs)}`}</span>}
            {oldReading && freshness.kind === "polled" && <span className="font-semibold">Old reading: no update in over {overMinutes(freshness.staleAfterMin)}.</span>}
          </p>
        </footer>
      </div>
    </article>
  );
}
