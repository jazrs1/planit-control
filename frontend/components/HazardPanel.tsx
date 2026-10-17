import type { ReactNode } from "react";
import type { HazardCard, HazardStatus } from "@shared/types";
import { formatAgo, formatSiteDateTime } from "@/lib/time";

// One hazard card on the site detail page. Structure follows SiteCard: shared/types props, token colors.
//
// Unknown must look unknown. When a source has no reading yet the backend still fills the card's
// required numbers from a placeholder, so this panel only shows detail rows when the card is live:
// hazard_status is set and (for polled sources) as_of is set.

// Calm card with a status band across the top: OK and Watch are quiet tints; Danger is a safety state,
// so it gets the sign treatment (solid red band, heavy rule).
const STATUS_STYLES: Record<HazardStatus, { band: string; border: string; label: string }> = {
  ok: { band: "bg-risk-green-bg text-risk-green", border: "border border-border", label: "OK" },
  watch: { band: "bg-risk-amber-bg text-risk-amber", border: "border border-border", label: "Watch" },
  danger: { band: "bg-risk-red-solid text-on-risk-red", border: "border-2 border-rule", label: "Danger" },
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
    <article className={`flex flex-col gap-3 bg-surface p-4 pbs-0 ${style && !uncertain ? style.border : "border-2 border-dashed border-muted"}`}>
      <header className={`-mx-4 flex min-h-9 items-center justify-between gap-3 px-4 ${style && !uncertain ? style.band : "border-be border-dashed border-muted text-muted"}`}>
        <h2 className="pc-label truncate text-xs">{title}</h2>
        <span
          className="pc-label shrink-0 text-xs"
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
              <dd className="text-end font-semibold tabular-nums">
                {row.value ?? <span className="text-muted" title="Not available">—<span className="sr-only">not available</span></span>}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {live && children}

      <p className="mbs-auto text-xs text-muted">
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
