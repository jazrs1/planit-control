"use client";

import type { Site } from "@shared/types";
import { NoticeCard, StopWorkCard, replayClearedText } from "@/components/AlertCards";
import { useAlertsState, useServerNow } from "@/components/AlertsProvider";
import { DEMO_DATA } from "@/lib/api";
import { countAlerts, floodReason, formatAlertTime, realAlerts, replayCleared } from "@/lib/alerts";
import { useFloodConditions } from "@/lib/useFloodConditions";

export default function AlertsList({ sites }: { sites: Site[] }) {
  const { alerts, status, staleSince, replay } = useAlertsState();
  const serverNow = useServerNow();
  const floodConditions = useFloodConditions();
  // Counts never mix real and replay alerts: real first, replay ones named separately.
  const real = realAlerts(alerts ?? []);
  const counts = countAlerts(real);
  const replayCount = (alerts ?? []).length - real.length;
  const sitesById = new Map((status === "demo" ? DEMO_DATA.sites : sites).map((site) => [site.id, site]));
  const lastKnown = status === "stale";

  if (alerts === null) {
    return (
      <p role="status" className="rounded-card border-2 border-dashed border-muted px-6 py-4 font-semibold text-muted">
        {status === "unreachable" ? "Can't reach the server, so stop-work status is unknown. Retrying…" : "Connecting…"}
      </p>
    );
  }

  return (
    <>
      {status === "demo" && (
        <p role="status" className="flex flex-wrap items-center gap-x-3 text-muted">
          <span className="pc-chip pc-chip--unknown">Demo data</span>
          Sample alerts from shared/mocks, not live conditions.
        </p>
      )}
      {staleSince && (
        <p role="status" className="rounded-card bg-risk-red-bg px-4 py-3 font-semibold text-risk-red">
          Connection lost. Showing alerts from {staleSince.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
        </p>
      )}
      {/* One sentence for the counts, one for the order and refresh: no chain of middle dots. */}
      <p role="status" className="text-xs text-muted">
        {real.length > 0 && <>{real.length}{lastKnown ? "?" : ""} {real.length === 1 ? "alert" : "alerts"}{lastKnown ? " (last known)" : ""}: {counts.lightning} stop work, {counts.flood} flood risk{replayCount > 0 ? `, plus ${replayCount} from the storm replay` : ""}. Newest first. </>}
        {real.length === 0 && replayCount > 0 && <>{replayCount} from the storm replay. </>}
        {status !== "demo" && (replay?.running ? "Updates every 3 seconds during the replay." : "Updates every 30 seconds.")}
      </p>
      {alerts.length === 0 ? (
        <p className={`flex items-center gap-3 rounded-card px-6 py-5 font-semibold ${lastKnown ? "border-2 border-dashed border-muted text-muted" : "bg-surface shadow-card"}`}>
          <span aria-hidden="true" className={`pc-shape ${lastKnown ? "pc-shape--unknown" : "pc-shape--green"}`} />
          {lastKnown ? "Current alerts unknown. The last confirmed list was empty." : "No active alerts."}
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {alerts.map((alert) => {
            const site = sitesById.get(alert.site_id);
            const name = site?.name ?? alert.site_id;
            return (
              <li key={alert.id}>
                {replayCleared(alert, serverNow())
                  // A finished replay stop-work: over, never "stop work".
                  ? <p className="px-6 text-xs text-muted">{name}{" · "}{replayClearedText(alert, site?.timezone)}</p>
                  : alert.type === "lightning"
                    ? <StopWorkCard alert={alert} siteName={name} lastKnown={lastKnown} />
                    : <NoticeCard alert={alert} siteName={name} lastKnown={lastKnown} started={formatAlertTime(alert.started_at, site?.timezone)}>
                      {alert.type === "flood" ? floodReason(floodConditions[alert.site_id]) : null}
                    </NoticeCard>}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
