import Link from "next/link";
import type { ReactNode } from "react";
import type { Alert, FloodConditions, Site } from "@shared/types";
import AlertBanner, { ReplayTag } from "@/components/AlertBanner";
import LightningApproachChip from "@/components/LightningApproachChip";
import StopWorkCountdown from "@/components/StopWorkCountdown";
import { HAZARD_LABEL, liveHazardIndex, replayRaised, riskLevel } from "@/lib/risk";
import { timeZoneAbbr } from "@/lib/time";

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
  /** Backend clock (simulated during a replay), for replay advisories. */
  nowMs?: number | null;
  /** Real time, for real advisories: during a replay the backend clock is simulated. Defaults to nowMs. */
  realNowMs?: number | null;
  demo?: boolean;
  /** Selected: the row expands to its details (alerts, countdown, history, actions). */
  selected?: boolean;
  /** Toggle the row (select it, or close it when it's already selected). */
  onSelect?: () => void;
  /** Center the map on this site. */
  onShowOnMap?: () => void;
};

/** One compact row in the ranked site list; the selected row expands to its details. */
export default function SiteCard({ site, alerts = [], flood, alertsUnconfirmed, approachUnconfirmed = false, nowMs = null, realNowMs, demo = false, history, selected = false, onSelect, onShowOnMap }: SiteCardProps) {
  // The index without replay overrides; a replay-raised index is never shown as real risk.
  const index = liveHazardIndex(site);
  const raised = replayRaised(site, alerts);
  const level = riskLevel(index);
  const risk = RISK_STYLES[level];
  // The real alert wins over a replay one: real look, red, real countdown.
  const lightning = alerts.find((alert) => alert.type === "lightning" && !alert.replay) ?? alerts.find((alert) => alert.type === "lightning");
  const floodAlert = alerts.find((alert) => alert.type === "flood" && !alert.replay) ?? alerts.find((alert) => alert.type === "flood");
  // Only a real stop-work tints the row red. A replay one stays white with a dashed blue edge.
  const realStop = !alertsUnconfirmed && !!lightning && !lightning.replay;
  const replayStop = !!lightning?.replay;
  const edge = realStop ? "border-s-risk-red-solid bg-risk-red-bg" : replayStop ? "border-s-notice [border-inline-start-style:dashed] bg-surface" : "border-s-transparent bg-surface";
  const approach = !lightning && site.lightning_approach ? site.lightning_approach : null;
  const approachNow = site.lightning_approach?.replay ? nowMs : realNowMs ?? nowMs;
  // Unknown after a dropped connection: the tag keeps its state and says so, in words.
  const lastKnown = alertsUnconfirmed && <span className="pc-label text-muted">Last known</span>;

  // Right side of the row: the most important state, or the risk band when there's none. Whether an
  // advisory is confirmed is shown in the expanded row, not here.
  const status = lightning
    ? <span className="flex items-center gap-1">
      {lightning.replay && <ReplayTag />}
      <span className={`pc-chip ${alertsUnconfirmed ? "pc-chip--unknown" : lightning.replay ? "pc-chip--replay-stop" : "pc-chip--stop"}`}>Stop work</span>
      {lastKnown}
      {!selected && <StopWorkCountdown all_clear_at={lightning.all_clear_at} replay={lightning.replay} inline />}
    </span>
    : floodAlert ? <span className="flex items-center gap-1">{floodAlert.replay && <ReplayTag />}<span className={`pc-chip ${alertsUnconfirmed ? "pc-chip--unknown" : "pc-chip--flood"}`}>Flood risk</span>{lastKnown}</span>
    : approach ? <span className="flex items-center gap-1">{approach.replay && <ReplayTag />}<span className="pc-chip pc-chip--approach">Lightning possible</span></span>
    : <span className={`text-xs font-semibold ${risk.text}`}>{risk.label}</span>;

  const row = <>
    <span className={`flex w-13 shrink-0 items-center gap-1.5 ${raised ? "outline-1 outline-offset-2 outline-dashed outline-notice" : ""}`}>
      <span aria-hidden="true" className={`pc-shape pc-shape--${realStop ? "stop" : level} text-[0.85rem]`} />
      <span aria-hidden="true" className="text-base font-bold leading-none tracking-[-0.02em] text-text">{index.toFixed(1)}</span>
      <span className="sr-only">Hazard index {index.toFixed(1)} of 10, {risk.label} risk{raised ? ", raised by a storm replay" : ""}.</span>
    </span>
    <span className="min-w-0 flex-1 text-start">
      <span className="block truncate text-sm font-bold leading-tight text-text">{site.name}</span>
      <span className="block truncate text-xs font-normal text-muted">{site.county} · {HAZARD_LABEL[site.top_hazard]}</span>
    </span>
    <span className="flex shrink-0 items-center">{status}</span>
  </>;

  return (
    <article className={`border-s-4 ${edge} ${selected ? "shadow-[inset_0_0_0_2px_var(--pc-notice)]" : ""}`}>
      {onSelect
        ? <h2 className="text-base"><button type="button" onClick={onSelect} aria-expanded={selected} className="flex min-h-14 w-full items-center gap-3 px-4 py-2 focus-visible:outline-2 focus-visible:-outline-offset-2 hover:bg-surface-2/60">{row}</button></h2>
        : <h2 className="flex min-h-14 items-center gap-3 px-4 py-2 text-base">{row}</h2>}

      {selected && <div className="flex flex-col gap-3 px-4 pbe-4">
        <p className="text-xs text-muted">{site.county} County · {timeZoneAbbr(site.timezone)} · Top hazard: <span className="text-text">{HAZARD_LABEL[site.top_hazard]}</span></p>
        {alerts.map((alert) => <AlertBanner key={alert.id} alert={alert} site={site} flood={flood} compact unconfirmed={alertsUnconfirmed} />)}
        <LightningApproachChip approach={site.lightning_approach} stopWork={!!lightning} unconfirmed={approachUnconfirmed} nowMs={approachNow} demo={demo} />
        {history}
        <div className="flex flex-wrap gap-2">
          <Link href={`/sites/${site.id}`} className="pc-btn pc-btn--quiet min-h-10 flex-1 text-sm">Site details →</Link>
          {onShowOnMap && <button type="button" onClick={onShowOnMap} className="pc-btn pc-btn--quiet min-h-10 flex-1 text-sm">Show on map</button>}
        </div>
      </div>}
    </article>
  );
}
