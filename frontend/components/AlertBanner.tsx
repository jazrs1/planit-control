import type { Alert, FloodConditions, Site } from "@shared/types";
import StopWorkCountdown from "@/components/StopWorkCountdown";
import { HAZARD_LABEL } from "@/lib/risk";
import { floodReason, formatAlertTime, formatStrikeDistance } from "@/lib/alerts";

type AlertBannerProps = {
  alert: Alert;
  site?: Site;
  flood?: FloodConditions;
  compact?: boolean;
  unconfirmed?: boolean;
  prominent?: boolean;
};

/** Marks an alert from a lightning replay (simulated, not real). Real alerts carry no tag. */
export function ReplayTag() {
  return (
    <span className="mr-2 inline-block rounded-pill bg-text px-2 py-0.5 align-middle text-xs font-bold tracking-wide text-surface" title="From a storm replay, not a real alert">
      REPLAY
    </span>
  );
}

export default function AlertBanner({ alert, site, flood, compact = false, unconfirmed = false, prominent = false }: AlertBannerProps) {
  const lightning = alert.type === "lightning";
  const distance = formatStrikeDistance(alert.last_strike_distance_mi);
  const style = unconfirmed ? "border-border bg-bg text-muted grayscale" : lightning
    ? "border-risk-red bg-risk-red-bg text-risk-red" : "border-risk-amber bg-risk-amber-bg text-risk-amber";
  return (
    <article className={`flex flex-col gap-3 rounded-card border p-4 shadow-card ${style} ${compact ? "" : "sm:flex-row sm:items-center sm:justify-between"}`}>
      <div className="min-w-0">
        <p className={`${prominent ? "text-3xl" : "text-sm"} font-bold uppercase tracking-wide`}>
          {alert.replay && <ReplayTag />}
          {lightning ? "STOP WORK" : alert.type === "flood" ? "FLOOD RISK" : `${HAZARD_LABEL[alert.type]} alert`}{unconfirmed ? " · Not confirmed" : ""}
        </p>
        {!compact && <h2 className="break-words text-lg font-semibold">{site?.name ?? alert.site_id}</h2>}
        <p className="mt-1 text-sm">
          {lightning
            ? distance === null
              ? "Lightning detected nearby. Last strike distance unavailable."
              : `Last lightning strike: ${distance} away.`
            : alert.type === "flood" ? `Reason: ${floodReason(flood)}` : `${HAZARD_LABEL[alert.type]} alert active.`}
        </p>
        {!lightning && <p className="mt-1 text-sm">Started <time dateTime={alert.started_at}>{formatAlertTime(alert.started_at, site?.timezone)}</time></p>}
        {lightning && (
          <p className="mt-1 text-sm">Each new strike restarts the 30-minute wait.</p>
        )}
      </div>
      {lightning && <div className="shrink-0 sm:max-w-64">
        <StopWorkCountdown all_clear_at={alert.all_clear_at} replay={alert.replay} prominent={prominent} />
      </div>}
    </article>
  );
}
