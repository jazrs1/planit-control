import type { Alert, Site } from "@shared/types";
import StopWorkCountdown from "@/components/StopWorkCountdown";
import { HAZARD_LABEL, riskLevel } from "@/lib/risk";

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
  /** Active lightning alert for this site, if any. */
  lightningAlert?: Alert;
  selected?: boolean;
  onSelect?: () => void;
};

function formatLocalTime(iso: string, timeZone: string) {
  return new Date(iso).toLocaleTimeString("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/** "ET" / "CT". The panhandle sites run on Central time. */
function timeZoneAbbr(timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortGeneric" }).formatToParts();
  return parts.find((p) => p.type === "timeZoneName")?.value ?? timeZone;
}

export default function SiteCard({ site, lightningAlert, selected, onSelect }: SiteCardProps) {
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

      {onSelect && <button type="button" onClick={onSelect} aria-pressed={!!selected} className="rounded-card border border-border px-3 py-2 text-left text-sm text-brand hover:bg-bg focus-visible:outline-2 focus-visible:outline-brand">{selected ? "Selected on map" : "Show on map"}</button>}

      {lightningAlert && (
        <div className="flex flex-col gap-2 rounded-card bg-risk-red p-3 text-sm font-semibold text-surface">
          <p>
            ⚡ STOP WORK: {lightningAlert.last_strike_distance_mi === null
              ? "lightning nearby"
              : `lightning ${lightningAlert.last_strike_distance_mi} mi away`}
          </p>
          {/* Same live countdown as /alerts; it resets when a new strike moves all_clear_at. */}
          <StopWorkCountdown all_clear_at={lightningAlert.all_clear_at} />
          {lightningAlert.all_clear_at && (
            <p className="font-normal">
              All clear at {formatLocalTime(lightningAlert.all_clear_at, site.timezone)} if no new strikes
            </p>
          )}
        </div>
      )}
    </article>
  );
}
