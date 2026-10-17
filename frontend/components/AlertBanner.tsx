import type { Alert, Site } from "@shared/types";
import StopWorkCountdown from "@/components/StopWorkCountdown";
import { HAZARD_LABEL } from "@/lib/risk";

type AlertBannerProps = {
  alert: Alert;
  site?: Site;
};

export default function AlertBanner({ alert, site }: AlertBannerProps) {
  return (
    <article className="flex flex-col gap-3 rounded-card border border-risk-red bg-risk-red-bg p-4 text-risk-red shadow-card sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-bold uppercase tracking-wide">STOP WORK</p>
        <h2 className="break-words text-lg font-semibold">{site?.name ?? alert.site_id}</h2>
        <p className="mt-1 text-sm">
          {alert.type === "lightning"
            ? alert.last_strike_distance_mi === null
              ? "Lightning detected nearby. Last strike distance unavailable."
              : `Last lightning strike: ${alert.last_strike_distance_mi} miles away.`
            : `${HAZARD_LABEL[alert.type]} alert active.`}
        </p>
        {alert.type === "lightning" && (
          <p className="mt-1 text-sm">Each new strike restarts the 30-minute wait.</p>
        )}
      </div>
      <div className="shrink-0 sm:max-w-64">
        <StopWorkCountdown all_clear_at={alert.all_clear_at} />
      </div>
    </article>
  );
}
