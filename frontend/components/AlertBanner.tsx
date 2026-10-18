import type { Alert, FloodConditions, Site } from "@shared/types";
import StopWorkCountdown from "@/components/StopWorkCountdown";
import { HAZARD_LABEL } from "@/lib/risk";
import { floodReason, formatAlertTime, formatStrikeDistance, heldForLightningData } from "@/lib/alerts";

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
    <span className="pc-chip pc-chip--replay me-2 align-middle" title="From a storm replay, not a real alert">
      REPLAY
    </span>
  );
}

/** The octagon of a stop sign, with a lightning bolt. */
function StopSign() {
  return (
    <span aria-hidden="true" className="grid size-14 shrink-0 place-items-center bg-on-risk-red text-risk-red-solid [clip-path:polygon(30%_0,70%_0,100%_30%,100%_70%,70%_100%,30%_100%,0_70%,0_30%)]">
      <svg viewBox="0 0 24 24" className="size-7"><path d="M13 2 4 14h7l-1 8 9-12h-7z" fill="currentColor" /></svg>
    </span>
  );
}

export default function AlertBanner({ alert, site, flood, compact = false, unconfirmed = false, prominent = false }: AlertBannerProps) {
  const lightning = alert.type === "lightning";
  const distance = formatStrikeDistance(alert.last_strike_distance_mi);
  const label = lightning ? "STOP WORK" : alert.type === "flood" ? "FLOOD RISK" : `${HAZARD_LABEL[alert.type].toUpperCase()} ALERT`;
  const detail = lightning
    ? distance === null
      ? "Lightning detected nearby. Last strike distance unavailable."
      : `Last lightning strike: ${distance} away.`
    : alert.type === "flood" ? `Reason: ${floodReason(flood)}` : `${HAZARD_LABEL[alert.type]} alert active.`;
  const started = !lightning && <p className="mbs-1 text-sm">Started <time dateTime={alert.started_at}>{formatAlertTime(alert.started_at, site?.timezone)}</time></p>;
  const held = heldForLightningData(alert);
  const restart = lightning && <p className="mbs-1 text-sm font-semibold">{held ? "Lightning data is delayed. Stop work stays in place until it’s back." : "Each new strike restarts the 30-minute wait."}</p>;

  // Crew view: the whole alert is a sign. Solid red (or amber) header, white body.
  if (prominent) {
    // A replay alert is never drawn as a real sign: blue, not red or amber.
    const header = unconfirmed ? "bg-surface-2 text-muted grayscale" : alert.replay ? "bg-notice text-on-notice" : lightning ? "bg-risk-red-solid text-on-risk-red" : "bg-risk-amber-solid text-on-risk-amber";
    return (
      <article className={`pc-panel pc-panel--heavy ${unconfirmed ? "pc-panel--unknown" : ""}`}>
        <header className={`flex items-center gap-4 p-4 ${header}`}>
          {lightning && !unconfirmed && !alert.replay && <StopSign />}
          <div className="min-w-0">
            <p className="text-sign font-black leading-none tracking-[0.02em]">
              {alert.replay && <ReplayTag />}{label}
            </p>
            {unconfirmed && <p className="pc-label pc-label--sign mbs-2">Last known · connection lost</p>}
            {lightning && distance !== null && <p className="pc-label pc-label--sign mbs-2 text-base">Lightning {distance} away</p>}
          </div>
        </header>
        {lightning && <div className="border-be-[length:var(--pc-rule-heavy)] border-rule">
          <StopWorkCountdown all_clear_at={alert.all_clear_at} replay={alert.replay} prominent held={held} />
        </div>}
        <div className="p-4">
          <p className="font-semibold">{detail}</p>
          {started}
          {restart}
        </div>
      </article>
    );
  }

  // Dashboard and alerts list: a quiet tint with a solid tag. Replay alerts stay white with a dashed edge.
  const style = unconfirmed ? "border-dashed border-muted bg-bg text-muted grayscale"
    : alert.replay ? "border-dashed border-notice bg-surface text-text"
    : lightning ? "border-risk-red bg-risk-red-bg text-text" : "border-risk-amber bg-risk-amber-bg text-text";
  const tag = unconfirmed ? "pc-chip--unknown" : lightning ? alert.replay ? "pc-chip--replay-stop" : "pc-chip--stop" : "pc-chip--flood";
  return (
    <article className={`flex flex-col gap-3 border-2 border-s-[6px] p-3 ${style} ${compact ? "" : "sm:flex-row sm:items-center sm:justify-between"}`}>
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {alert.replay && !lightning && <ReplayTag />}
          <span className={`pc-chip ${tag} text-xs`}>{alert.replay && lightning ? "REPLAY STOP WORK" : label}</span>
          {unconfirmed && <span className="pc-label">Last known · connection lost</span>}
        </p>
        {!compact && <h2 className="mbs-1.5 break-words text-lg font-extrabold">{site?.name ?? alert.site_id}</h2>}
        <p className="mbs-1.5 text-sm">{detail}</p>
        {started}
        {restart}
      </div>
      {lightning && <div className="shrink-0 sm:max-w-64">
        <StopWorkCountdown all_clear_at={alert.all_clear_at} replay={alert.replay} held={held} />
      </div>}
    </article>
  );
}
