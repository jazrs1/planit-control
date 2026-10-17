import type { ReactNode } from "react";
import type { HazardCard, HazardStatus } from "@shared/types";
import { formatAgo, formatSiteDateTime } from "@/lib/time";

// One hazard card on the site detail page. Structure follows SiteCard: shared/types props, token colors.
//
// Unknown must look unknown. When a source has no reading yet the backend still fills the card's
// required numbers from a placeholder, so this panel only shows detail rows when the card is live:
// hazard_status is set and (for polled sources) as_of is set.

const STATUS_STYLES: Record<HazardStatus, { chip: string; border: string; label: string }> = {
  ok: { chip: "bg-risk-green-bg text-risk-green", border: "border-border", label: "OK" },
  watch: { chip: "bg-risk-amber-bg text-risk-amber", border: "border-risk-amber", label: "Watch" },
  danger: { chip: "bg-risk-red-bg text-risk-red", border: "border-risk-red", label: "Danger" },
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
  rows: HazardRow[];
  freshness: Freshness;
  timeZone: string;
  /** Viewer's "now" for reading ages; null until mounted (keeps server and hydration render equal). */
  nowMs: number | null;
  /** The page lost its connection: everything shown is last known. */
  connectionLost: boolean;
  children?: ReactNode;
};

export default function HazardPanel({ title, card, rows, freshness, timeZone, nowMs, connectionLost, children }: HazardPanelProps) {
  const status = card?.hazard_status ?? null;
  const asOf = card?.as_of ?? null;
  const live = status !== null && (freshness.kind === "live" || asOf !== null);
  const ageMs = asOf !== null && nowMs !== null ? Math.max(0, nowMs - Date.parse(asOf)) : null;
  const oldReading = freshness.kind === "polled" && ageMs !== null && ageMs > freshness.staleAfterMin * 60_000;
  // Last-known or old data keeps its status but greyed, with "?": it may no longer be true.
  const uncertain = status !== null && (connectionLost || oldReading);
  const style = status === null ? null : STATUS_STYLES[status];

  return (
    <article className={`flex flex-col gap-3 rounded-card border bg-surface p-4 shadow-card ${style && !uncertain ? style.border : "border-dashed border-border"}`}>
      <header className="flex items-start justify-between gap-3">
        <h2 className="text-base font-semibold text-text">{title}</h2>
        <span
          className={`shrink-0 rounded-pill px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${style && !uncertain ? style.chip : "bg-bg text-muted"}`}
          aria-label={status === null ? `${title}: no data` : `${title}: ${style!.label}${uncertain ? ", may be out of date" : ""}`}
        >
          {status === null ? "No data" : `${style!.label}${uncertain ? "?" : ""}`}
        </span>
      </header>

      <p className={`text-sm ${live && !uncertain ? "text-text" : "text-muted"}`}>
        {card?.reading ?? (status === null ? "No data from this source yet." : "No summary available.")}
      </p>

      {live && rows.length > 0 && (
        <dl className={`grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm ${uncertain ? "text-muted" : ""}`}>
          {rows.map((row) => (
            <div key={row.label} className="contents">
              <dt className="text-muted">{row.label}</dt>
              <dd className="text-right font-medium tabular-nums">
                {row.value ?? <span className="text-muted" title="Not available">—<span className="sr-only">not available</span></span>}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {live && children}

      <p className="mt-auto text-xs text-muted">
        {freshness.kind === "live"
          ? status === null ? "No live reading" : connectionLost ? "Last known before the connection was lost" : "Live"
          : asOf === null
            ? "No live reading yet"
            : <>
              As of {formatSiteDateTime(asOf, timeZone)}
              {ageMs !== null && ` · ${formatAgo(ageMs)}`}
              {oldReading && <span className="block font-semibold">Old reading: the source hasn&apos;t updated since.</span>}
            </>}
      </p>
    </article>
  );
}
