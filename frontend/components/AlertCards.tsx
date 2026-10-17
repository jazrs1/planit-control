import type { ReactNode } from "react";
import type { Alert } from "@shared/types";
import { ReplayTag } from "@/components/AlertBanner";
import StopWorkCountdown from "@/components/StopWorkCountdown";
import { formatStrikeDistance, replayCleared, replayClearedLabel } from "@/lib/alerts";
import { HAZARD_LABEL } from "@/lib/risk";

// Alert cards for the site detail page and /alerts. A real stop-work gets the one hard edge on the page
// (a solid red band); a replay one is blue and dashed, never red; last known is grey and dashed.

function alertLabel(alert: Alert) {
  return alert.type === "lightning" ? "Stop work" : alert.type === "flood" ? "Flood risk" : `${HAZARD_LABEL[alert.type]} alert`;
}

/** A lightning stop-work, real or replay. `siteName` titles the card on /alerts. */
export function StopWorkCard({ alert, siteName, lastKnown }: { alert: Alert; siteName?: string; lastKnown: boolean }) {
  const distance = formatStrikeDistance(alert.last_strike_distance_mi);
  const frame = lastKnown ? "border-2 border-dashed border-muted text-muted" : alert.replay ? "outline-2 -outline-offset-2 outline-dashed outline-notice" : "shadow-card";
  return (
    <article className={`overflow-clip rounded-card bg-surface ${frame}`}>
      {alert.replay || lastKnown ? (
        <header className="flex flex-wrap items-center gap-2 px-6 pbs-5 max-sm:px-5">
          {alert.replay && <ReplayTag />}
          <span className={`pc-chip ${lastKnown ? "pc-chip--unknown" : "pc-chip--replay-stop"}`}>Stop work</span>
          {lastKnown && <span className="text-xs font-semibold">Last known · connection lost</span>}
        </header>
      ) : (
        <header className="flex items-center gap-2 bg-risk-red-solid px-6 py-3 text-on-risk-red max-sm:px-5">
          <span aria-hidden="true" className="pc-shape pc-shape--stop [--pc-shape:currentColor]" />
          <p className="pc-label">Stop work · lightning</p>
        </header>
      )}
      <div className="flex flex-col gap-4 p-6 max-sm:p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          {siteName && <h2 className="break-words text-xl font-semibold">{siteName}</h2>}
          {/* Same rounding as every other page: down, so a strike inside 10 mi never reads 10.0. */}
          <p className={siteName ? "" : "text-xl font-semibold"}>{distance === null ? "Lightning within 10 mi." : `Last strike ${distance} away.`}</p>
          <p className="text-muted">Each new strike restarts the 30-minute wait.</p>
        </div>
        {/* The shared countdown, without its box: the card is the frame. */}
        <div className="shrink-0 sm:min-w-48 [&>div]:border-0 [&>div]:bg-transparent [&>div]:p-0 [&_[role=timer]]:text-[2rem]">
          <StopWorkCountdown all_clear_at={alert.all_clear_at} replay={alert.replay} />
        </div>
      </div>
    </article>
  );
}

/** Flood risk and any other alert type: a calm card led by its safety badge. */
export function NoticeCard({ alert, siteName, started, lastKnown, children }: { alert: Alert; siteName?: string; started: string | null; lastKnown: boolean; children?: ReactNode }) {
  const flood = alert.type === "flood";
  const frame = lastKnown ? "border-2 border-dashed border-muted text-muted" : alert.replay ? "outline-2 -outline-offset-2 outline-dashed outline-notice" : "shadow-card";
  const chip = lastKnown ? "pc-chip--unknown" : alert.replay ? "pc-chip--replay-stop" : flood ? "pc-chip--flood" : "pc-chip--stop";
  return (
    <article className={`flex flex-col gap-4 rounded-card bg-surface p-6 max-sm:p-5 ${frame}`}>
      <p className="flex flex-wrap items-center gap-2">
        {alert.replay && <ReplayTag />}
        <span className={`pc-chip ${chip}`}>{alertLabel(alert)}</span>
        {lastKnown && <span className="text-xs font-semibold">Last known · connection lost</span>}
        {started && <span className="ms-auto text-xs text-muted">Started <time dateTime={alert.started_at}>{started}</time></span>}
      </p>
      {(siteName || children) && <div className="flex flex-col gap-1">
        {siteName && <h2 className="break-words text-xl font-semibold">{siteName}</h2>}
        {children && <p className="max-w-[68ch]">{children}</p>}
      </div>}
    </article>
  );
}

/** A replay alert on the site page: a secondary blue tag, or grey once it has cleared on the replay clock. */
export function ReplayLine({ alert, timeZone, replayNowMs }: { alert: Alert; timeZone: string; replayNowMs: number | null }) {
  if (replayCleared(alert, replayNowMs)) return <p className="text-xs text-muted">{replayClearedLabel(alert, timeZone)}</p>;
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs">
      <span className="pc-chip pc-chip--replay">Replay</span>
      <span className="pc-chip pc-chip--replay-stop">{alertLabel(alert)}</span>
      {alert.type === "lightning" && <StopWorkCountdown all_clear_at={alert.all_clear_at} replay inline />}
    </p>
  );
}
