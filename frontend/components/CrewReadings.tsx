import type { HazardCard, OshaHeatRisk, SiteDetail } from "@shared/types";
import type { ReactNode } from "react";
import { hasReading } from "@/lib/crew";
import { formatAlertTime } from "@/lib/alerts";

const COLORS = {
  ok: "border-risk-green bg-risk-green-bg text-risk-green",
  watch: "border-risk-amber bg-risk-amber-bg text-risk-amber",
  danger: "border-risk-red bg-risk-red-bg text-risk-red",
};
const OSHA: Record<OshaHeatRisk, string> = { lower: "Lower", moderate: "Moderate", high: "High", very_high: "Very high" };

function Reading({ title, card, value, children, stale, timezone }: { title: string; card?: HazardCard | null; value: ReactNode; children?: ReactNode; stale: boolean; timezone: string }) {
  const known = hasReading(card);
  return <article className={`min-w-0 rounded-card border p-4 ${stale || !known ? "border-border bg-surface text-muted" : COLORS[card!.hazard_status!]}`}>
    <h3 className="font-semibold">{title}</h3>
    <p className="mbs-2 break-words text-3xl font-bold leading-tight tabular-nums">{known ? value : "No data"}{known && stale ? " ?" : ""}</p>
    {known && <div className="mbs-2 space-y-1 text-sm font-medium">{children}</div>}
    {known && card?.as_of && <p className="mbs-3 text-xs">{stale ? "Not confirmed · " : "Updated "}{formatAlertTime(card.as_of, timezone)}</p>}
  </article>;
}

export default function CrewReadings({ detail, stale }: { detail: SiteDetail | null; stale: boolean }) {
  const conditions = detail?.conditions;
  const heat = conditions?.heat, rain = conditions?.flood, soil = conditions?.soil, wildlife = conditions?.wildlife_summary;
  const finite = (value: number | null | undefined, decimals: number, unit: string) => value !== null && value !== undefined && Number.isFinite(value) ? `${value.toFixed(decimals)} ${unit}` : "No data";
  const timezone = detail?.timezone ?? "UTC";
  return <section aria-labelledby="readings-heading" className={stale ? "grayscale" : ""}>
    <h2 id="readings-heading" className="mbe-3 text-xl font-bold">Today&apos;s key readings</h2>
    {stale && <p role="status" className="mbe-3 font-semibold text-muted">Readings not confirmed · showing the last real readings.</p>}
    <div className="grid grid-cols-2 gap-3">
      <Reading title="Heat index" card={heat} stale={stale} timezone={timezone} value={finite(heat?.heat_index_f, 0, "°F")}>
        {/* risk_band is for today's whole-day peak; the card's color is the rest of today. */}
        <p>OSHA at today&apos;s peak: {heat?.risk_band ? OSHA[heat.risk_band] : "Unknown"}</p>
      </Reading>
      <Reading title="Rain · past 24 h" card={rain} stale={stale} timezone={timezone} value={finite(rain?.rain_past_24h_in, 1, "in")}>
        <p>Next 24 h: {finite(rain?.rain_next_24h_in, 1, "in")}</p>
      </Reading>
      <Reading title="Soil moisture" card={soil} stale={stale} timezone={timezone} value={finite(soil?.moisture_pct, 0, "%")}>
        <p className="capitalize">{soil?.level ?? (soil?.saturated ? "Saturated" : "Ground condition unknown")}</p>
        {soil?.reading && <p>{soil.reading}</p>}
      </Reading>
      <Reading title="Nearby wildlife" card={wildlife} stale={stale} timezone={timezone} value={wildlife ? `${wildlife.observations_30d} sightings` : "No data"}>
        <p>Past 30 days · {wildlife?.crew_reports_2mi ?? "—"} crew reports within 2 mi</p>
        {[...(conditions?.wildlife ?? [])].sort((a, b) => a.distance_mi - b.distance_mi).slice(0, 2).map((sighting, index) => <p key={`${sighting.species}-${index}`}>{sighting.species} · {sighting.distance_mi.toFixed(1)} mi</p>)}
      </Reading>
    </div>
  </section>;
}
