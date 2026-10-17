import Link from "next/link";
import type { ReactNode } from "react";
import type { Alert, FloodConditions, Site } from "@shared/types";
import AlertBanner from "@/components/AlertBanner";
import LightningApproachChip from "@/components/LightningApproachChip";
import { HAZARD_LABEL, riskLevel } from "@/lib/risk";
import { timeZoneAbbr } from "@/lib/time";

// Reference component: copy this structure for new cards.
// - Props are shared/types shapes, not ad-hoc objects.
// - Colors come from tokens (bg-surface, text-muted, risk-*), never raw colors.
// - Risk color always goes through riskLevel(), and always comes with its shape (pc-shape--*).
// - Solid sign color only for something a crew must act on; everything else is white with black type.

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
  nowMs?: number | null;
  demo?: boolean;
  selected?: boolean;
  onSelect?: () => void;
};

export default function SiteCard({ site, alerts = [], flood, alertsUnconfirmed, approachUnconfirmed = false, nowMs = null, demo = false, history, selected, onSelect }: SiteCardProps) {
  const level = riskLevel(site.hazard_index);
  const risk = RISK_STYLES[level];
  // Only a real stop-work tints the card red. A replay one stays white with a dashed blue edge.
  const realStop = !alertsUnconfirmed && alerts.some((alert) => alert.type === "lightning" && !alert.replay);
  const replayStop = alerts.some((alert) => alert.type === "lightning" && alert.replay);
  const edge = realStop ? "border-s-risk-red-solid bg-risk-red-bg" : replayStop ? "border-s-notice [border-inline-start-style:dashed] bg-surface" : "border-s-transparent bg-surface";

  return (
    <article className={`flex flex-col gap-3 border-s-4 px-4 py-3.5 ${edge} ${selected ? "outline-3 -outline-offset-3 outline-notice" : ""}`}>
      <header className="flex items-start gap-3">
        <div
          className={`flex w-16 shrink-0 items-center gap-1.5 pbs-0.5 ${risk.text}`}
          aria-label={`Hazard index ${site.hazard_index} of 10, ${risk.label} risk`}
        >
          <span aria-hidden="true" className={`pc-shape pc-shape--${realStop || replayStop ? "stop" : level} text-[0.95rem]`} />
          <span className="text-xl font-bold leading-none tracking-[-0.02em] text-text">{site.hazard_index.toFixed(1)}</span>
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-bold leading-tight text-text">{site.name}</h2>
          <p className="text-[0.8125rem] text-muted">
            {site.county} County · {timeZoneAbbr(site.timezone)} · <span className="text-text">{HAZARD_LABEL[site.top_hazard]}</span>
          </p>
        </div>
        <span className={`shrink-0 pbs-0.5 text-xs font-semibold ${risk.text}`}>{risk.label}</span>
      </header>

      {alerts.map((alert) => <AlertBanner key={alert.id} alert={alert} site={site} flood={flood} compact unconfirmed={alertsUnconfirmed} />)}
      <LightningApproachChip approach={site.lightning_approach} stopWork={alerts.some((alert) => alert.type === "lightning")} unconfirmed={approachUnconfirmed} nowMs={nowMs} demo={demo} />

      {history}

      <div className="flex flex-wrap gap-2">
        <Link href={`/sites/${site.id}`} className="pc-btn pc-btn--quiet min-h-10 flex-1 text-sm">
          Site details →
        </Link>
        {onSelect && <button type="button" onClick={onSelect} aria-pressed={!!selected} className={`pc-btn pc-btn--quiet min-h-10 flex-1 text-sm ${selected ? "border-notice text-notice" : ""}`}>{selected ? "Selected on map" : "Show on map"}</button>}
      </div>
    </article>
  );
}
