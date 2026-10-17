import type { HazardCard, OshaHeatRisk, SiteDetail } from "@shared/types";
import type { ReactNode } from "react";
import { hasReading } from "@/lib/crew";
import { formatAlertTime, formatMiles } from "@/lib/alerts";

// A sign band across the top of each reading: one line, the same height on every card.
const BANDS = {
  ok: { band: "bg-risk-green-solid text-on-risk-green", label: "OK" },
  watch: { band: "bg-risk-amber-solid text-on-risk-amber", label: "Watch" },
  danger: { band: "bg-risk-red-solid text-on-risk-red", label: "Danger" },
};
const OSHA: Record<OshaHeatRisk, string> = { lower: "Lower", moderate: "Moderate", high: "High", very_high: "Very high" };

function Reading({ title, card, value, children, stale, timezone }: { title: string; card?: HazardCard | null; value: ReactNode; children?: ReactNode; stale: boolean; timezone: string }) {
  const known = hasReading(card);
  const band = known && !stale ? BANDS[card!.hazard_status!] : null;
  return <article className={`flex min-w-0 flex-col border-[length:var(--pc-rule-heavy)] bg-surface ${band ? "border-rule" : "border-dashed border-muted text-muted"}`}>
    <h3 className={`flex h-9 items-center justify-between gap-2 px-3 ${band ? band.band : "border-be-2 border-dashed border-muted"}`}>
      <span className="pc-label truncate text-[0.6875rem] tracking-[0.03em]">{title}</span>
      <span className="pc-label shrink-0 text-[0.6875rem] tracking-[0.03em]">{band ? band.label : known ? `${BANDS[card!.hazard_status!].label}?` : "No data"}</span>
    </h3>
    <div className="flex flex-1 flex-col gap-2 p-3">
      <p className="break-words font-mono text-[2rem] font-bold leading-none tabular-nums">{known ? value : "No data"}{known && stale ? " ?" : ""}</p>
      {known && <div className="space-y-1 text-sm font-semibold">{children}</div>}
      {known && card?.as_of && <p className="mbs-auto pbs-1 text-xs text-muted">{stale ? "Not confirmed · " : "Updated "}{formatAlertTime(card.as_of, timezone)}</p>}
    </div>
  </article>;
}

export default function CrewReadings({ detail, stale }: { detail: SiteDetail | null; stale: boolean }) {
  const conditions = detail?.conditions;
  const heat = conditions?.heat, rain = conditions?.flood, soil = conditions?.soil, wildlife = conditions?.wildlife_summary;
  const finite = (value: number | null | undefined, decimals: number, unit: string) => value !== null && value !== undefined && Number.isFinite(value) ? `${value.toFixed(decimals)} ${unit}` : "No data";
  const big = (value: number | null | undefined, decimals: number, unit: string) => value !== null && value !== undefined && Number.isFinite(value) ? <>{value.toFixed(decimals)}<span className="ms-1 font-sans text-base font-extrabold">{unit}</span></> : "No data";
  const timezone = detail?.timezone ?? "UTC";
  return <section aria-labelledby="readings-heading" className={stale ? "grayscale" : ""}>
    <h2 id="readings-heading" className="pc-label mbe-3 text-sm">Today&apos;s key readings · now</h2>
    {stale && <p role="status" className="mbe-3 font-semibold text-muted">Readings not confirmed · showing the last real readings.</p>}
    <div className="grid grid-cols-2 gap-3">
      <Reading title="Heat index" card={heat} stale={stale} timezone={timezone} value={big(heat?.heat_index_f, 0, "°F")}>
        {/* risk_band is for today's whole-day peak; the card's color is the rest of today. */}
        <p>OSHA at today&apos;s peak: {heat?.risk_band ? OSHA[heat.risk_band] : "Unknown"}</p>
      </Reading>
      <Reading title="Rain · 24 h" card={rain} stale={stale} timezone={timezone} value={big(rain?.rain_past_24h_in, 1, "in")}>
        <p>Past 24 hours</p>
        <p>Next 24 h: {finite(rain?.rain_next_24h_in, 1, "in")}</p>
      </Reading>
      <Reading title="Soil moisture" card={soil} stale={stale} timezone={timezone} value={big(soil?.moisture_pct, 0, "%")}>
        <p className="capitalize">{soil?.level ?? (soil?.saturated ? "Saturated" : "Ground condition unknown")}</p>
        {soil?.reading && <p>{soil.reading}</p>}
      </Reading>
      <Reading title="Wildlife" card={wildlife} stale={stale} timezone={timezone} value={wildlife ? <>{wildlife.observations_30d}<span className="ms-1 font-sans text-base font-extrabold">sightings</span></> : "No data"}>
        <p>Past 30 days · {wildlife?.crew_reports_2mi ?? "—"} crew reports within 2 mi</p>
        {[...(conditions?.wildlife ?? [])].sort((a, b) => a.distance_mi - b.distance_mi).slice(0, 2).map((sighting, index) => <p key={`${sighting.species}-${index}`}>{sighting.species} · {formatMiles(sighting.distance_mi) ?? "distance unknown"}</p>)}
      </Reading>
    </div>
  </section>;
}
