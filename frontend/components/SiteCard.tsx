import Link from "next/link";
import type { ReactNode } from "react";
import type { Alert, FloodConditions, Site } from "@shared/types";
import AlertBanner from "@/components/AlertBanner";
import LightningApproachChip from "@/components/LightningApproachChip";
import StopWorkCountdown from "@/components/StopWorkCountdown";
import { replayCleared, replayClearedLabel } from "@/lib/alerts";
import { hazardHref } from "@/lib/hazardLinks";
import { HAZARD_LABEL, liveHazardIndex, replayRaised, riskLevel } from "@/lib/risk";

// Reference component: copy this structure for new cards.
// - Props are shared/types shapes, not ad-hoc objects.
// - Colors come from tokens (bg-surface, text-muted, risk-*), never raw colors.
// - Risk color always goes through riskLevel(), and always comes with its shape (pc-shape--*).
// - Solid sign color only for safety states (stop work, flood risk); everything else stays calm.

const RISK_STYLES = {
  green: { text: "text-risk-green", label: "Low" },
  amber: { text: "text-risk-amber", label: "Elevated" },
  red: { text: "text-risk-red", label: "High" },
} as const;

type SiteCardProps = {
  site: Site;
  alerts?: Alert[];
  flood?: FloodConditions;
  alertsUnconfirmed?: boolean;
  history?: ReactNode;
  approachUnconfirmed?: boolean;
  /** Backend clock (simulated during a replay), for replay countdowns. */
  nowMs?: number | null;
  demo?: boolean;
  /** Selected: the row expands to its details (alerts, countdown, history, actions). */
  selected?: boolean;
  /** Toggle the row (select it, or close it when it's already selected). */
  onSelect?: () => void;
  /** Center the map on this site. */
  onShowOnMap?: () => void;
};

/** One compact row in the ranked site list; the selected row expands to its details. */
export default function SiteCard({ site, alerts = [], flood, alertsUnconfirmed, approachUnconfirmed = false, nowMs = null, demo = false, history, selected = false, onSelect, onShowOnMap }: SiteCardProps) {
  // The index without replay overrides; a replay-raised index is never shown as real risk.
  const index = liveHazardIndex(site);
  const raised = replayRaised(site, alerts);
  const level = riskLevel(index);
  const risk = RISK_STYLES[level];
  // Real always beats replay (like the beacon): the row's chip shows the real state (stop work, then a
  // lightning advisory, then flood risk), and a replay stop-work is only a secondary tag.
  const realLightning = alerts.find((alert) => alert.type === "lightning" && !alert.replay);
  const replayLightning = alerts.find((alert) => alert.type === "lightning" && alert.replay);
  const realFlood = alerts.find((alert) => alert.type === "flood" && !alert.replay);
  const replayFlood = alerts.find((alert) => alert.type === "flood" && alert.replay);
  // A replay stop-work whose countdown has ended is over: "Replay · cleared 6:55 PM", never "stop work".
  const replayDone = replayCleared(replayLightning, nowMs);
  const replayActive = !!replayLightning && !replayDone;
  const realStop = !alertsUnconfirmed && !!realLightning;
  const edge = realStop ? "border-s-risk-red-solid bg-risk-red-bg" : replayActive ? "border-s-notice [border-inline-start-style:dashed] bg-surface" : "border-s-transparent bg-surface";
  // A real stop-work makes the advisory moot; a replay one never hides a real advisory.
  const approach = !realLightning && site.lightning_approach ? site.lightning_approach : null;
  const realApproach = approach && !approach.replay ? approach : null;
  // Unknown after a dropped connection: the tag keeps its state and says so, in words.
  const lastKnown = alertsUnconfirmed && <span className="pc-label text-muted">Last known</span>;

  const primary = realLightning
    ? <span className="flex items-center gap-1.5">
      <span className={`pc-chip ${alertsUnconfirmed ? "pc-chip--unknown" : "pc-chip--stop"}`}>Stop work</span>
      {lastKnown}
      {!selected && <StopWorkCountdown all_clear_at={realLightning.all_clear_at} replay={false} inline />}
    </span>
    : realApproach ? <span className="flex items-center gap-1.5"><span className={`pc-chip ${approachUnconfirmed ? "pc-chip--unknown" : "pc-chip--approach"}`}>Lightning possible</span>{approachUnconfirmed && <span className="pc-label text-muted">Last known</span>}</span>
    : realFlood ? <span className="flex items-center gap-1.5"><span className={`pc-chip ${alertsUnconfirmed ? "pc-chip--unknown" : "pc-chip--flood"}`}>Flood risk</span>{lastKnown}</span>
    : null;
  // The replay, as a short secondary tag so the site name keeps its room.
  const secondary = replayActive
    ? <span className="flex items-center gap-1"><span className="pc-chip pc-chip--replay-stop" title="Replay stop work">REPLAY</span>{!selected && <StopWorkCountdown all_clear_at={replayLightning!.all_clear_at} replay inline />}</span>
    : replayDone ? <span className="whitespace-nowrap text-xs text-muted">{replayClearedLabel(replayLightning!, site.timezone)}</span>
    : replayFlood ? <span className="pc-chip pc-chip--replay-stop" title="Replay flood risk">REPLAY</span>
    : approach?.replay ? <span className="pc-chip pc-chip--replay-stop" title="Replay: lightning possible">REPLAY</span>
    : null;
  const status = primary || secondary
    ? <span className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">{primary}{secondary}</span>
    : <span className={`text-xs font-semibold ${risk.text}`}>{risk.label}</span>;

  const row = <>
    <span className={`flex w-16 shrink-0 items-center gap-1.5 ${raised ? "outline-1 outline-offset-2 outline-dashed outline-notice" : ""}`}>
      <span aria-hidden="true" className={`pc-shape pc-shape--${realStop ? "stop" : level} text-[0.85rem]`} />
      <span aria-hidden="true" className="text-xl font-semibold leading-none tracking-[-0.02em] text-text tabular-nums">{index.toFixed(1)}</span>
      <span className="sr-only">Hazard index {index.toFixed(1)} of 10, {risk.label} risk{raised ? ", raised by a storm replay" : ""}.</span>
    </span>
    {/* The name keeps at least ~12 characters; the status wraps instead. */}
    <span className="min-w-[12ch] flex-1 text-start">
      {/* The row toggles from the name's button, stretched over the whole row; the hazard tag is a link
          above it, so tapping the tag opens that hazard's card without toggling the row. */}
      {onSelect
        ? <button type="button" onClick={onSelect} aria-expanded={selected} title={site.name} className="block w-full text-start text-sm font-semibold leading-tight text-text after:absolute after:inset-0 after:content-[''] focus-visible:outline-2 focus-visible:outline-transparent">
          <span className={`block ${selected ? "" : "truncate"}`}>{site.name}</span>
        </button>
        : <span title={site.name} className={`block text-sm font-semibold leading-tight text-text ${selected ? "" : "truncate"}`}>{site.name}</span>}
      <span className="flex min-w-0 items-center gap-2 text-xs font-normal text-muted">
        <span className="truncate">{site.county}</span>
        <Link href={hazardHref(site.id, site.top_hazard)} className="pc-hazard-tag"><span className="sr-only">Top hazard: </span>{HAZARD_LABEL[site.top_hazard]}</Link>
      </span>
    </span>
    <span className="flex max-w-[55%] items-center justify-end">{status}</span>
  </>;

  return (
    <article className={`border-s-4 ${edge} ${selected ? "shadow-[inset_0_0_0_2px_var(--pc-notice)]" : ""}`}>
      <h2 className={`relative flex min-h-16 items-center gap-3 px-4 py-3 text-base ${onSelect ? "cursor-pointer hover:bg-surface-2/60 has-[button:focus-visible]:outline-2 has-[button:focus-visible]:-outline-offset-2" : ""}`}>{row}</h2>

      {selected && <div className="pc-reveal flex flex-col gap-3 px-4 pbe-3">
        {/* Real alerts first; a finished replay stop-work is one neutral line. */}
        {[...alerts].sort((a, b) => Number(a.replay) - Number(b.replay)).map((alert) => alert === replayLightning && replayDone
          ? <p key={alert.id} className="text-sm text-muted">{replayClearedLabel(alert, site.timezone)}</p>
          : <AlertBanner key={alert.id} alert={alert} site={site} flood={flood} compact unconfirmed={alertsUnconfirmed} />)}
        <LightningApproachChip approach={site.lightning_approach} stopWork={!!realLightning} unconfirmed={approachUnconfirmed} demo={demo} />
        {history}
        <div className="flex flex-wrap gap-x-6">
          <Link href={`/sites/${site.id}`} className="pc-link">Site details →</Link>
          {onShowOnMap && <button type="button" onClick={onShowOnMap} className="pc-link">Show on map</button>}
        </div>
      </div>}
    </article>
  );
}
