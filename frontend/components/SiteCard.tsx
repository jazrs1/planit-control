import Link from "next/link";
import type { Alert, FloodConditions, Site } from "@shared/types";
import AlertBanner from "@/components/AlertBanner";
import LightningApproachChip from "@/components/LightningApproachChip";
import { HAZARD_LABEL, riskLevel } from "@/lib/risk";
import { timeZoneAbbr } from "@/lib/time";

// Reference component: copy this structure for new cards.
// - Props are shared/types shapes, not ad-hoc objects.
// - Colors come from tokens (bg-surface, text-muted, risk-*), never raw hex.
// - Risk color always goes through riskLevel().

const RISK_STYLES = {
  green: { badge: "bg-risk-green-bg text-risk-green", label: "Low" },
  amber: { badge: "bg-risk-amber-bg text-risk-amber", label: "Elevated" },
  red: { badge: "bg-risk-red-bg text-risk-red", label: "High" },
} as const;

type SiteCardProps = {
  site: Site;
  alerts?: Alert[];
  flood?: FloodConditions;
  alertsUnconfirmed?: boolean;
  approachUnconfirmed?: boolean;
  nowMs?: number | null;
  demo?: boolean;
  selected?: boolean;
  onSelect?: () => void;
};

export default function SiteCard({ site, alerts = [], flood, alertsUnconfirmed, approachUnconfirmed = false, nowMs = null, demo = false, selected, onSelect }: SiteCardProps) {
  const risk = RISK_STYLES[riskLevel(site.hazard_index)];

  return (
    <article className={`flex flex-col gap-3 rounded-card border border-border bg-surface p-4 shadow-card ${selected ? "ring-2 ring-brand" : ""}`}>
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-text">{site.name}</h2>
          <p className="text-sm text-muted">
            {site.county} County · {timeZoneAbbr(site.timezone)}
          </p>
        </div>
        <div
          className={`flex shrink-0 flex-col items-center rounded-card px-3 py-1 ${risk.badge}`}
          aria-label={`Hazard index ${site.hazard_index} of 10, ${risk.label} risk`}
        >
          <span className="font-mono text-2xl font-bold leading-tight">{site.hazard_index.toFixed(1)}</span>
          <span className="text-xs font-medium uppercase tracking-wide">{risk.label}</span>
        </div>
      </header>

      <p className="text-sm">
        <span className="text-muted">Top hazard: </span>
        <span className="font-medium">{HAZARD_LABEL[site.top_hazard]}</span>
      </p>

      <Link href={`/sites/${site.id}`} className="rounded-card border border-border px-3 py-2 text-sm font-medium text-brand hover:bg-bg focus-visible:outline-2 focus-visible:outline-brand">
        Site details →
      </Link>

      {onSelect && <button type="button" onClick={onSelect} aria-pressed={!!selected} className="rounded-card border border-border px-3 py-2 text-left text-sm text-brand hover:bg-bg focus-visible:outline-2 focus-visible:outline-brand">{selected ? "Selected on map" : "Show on map"}</button>}

      {alerts.map((alert) => <AlertBanner key={alert.id} alert={alert} site={site} flood={flood} compact unconfirmed={alertsUnconfirmed} />)}
      <LightningApproachChip approach={site.lightning_approach} stopWork={alerts.some((alert) => alert.type === "lightning")} unconfirmed={approachUnconfirmed} nowMs={nowMs} demo={demo} />
    </article>
  );
}
