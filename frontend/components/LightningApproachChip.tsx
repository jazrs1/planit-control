import type { LightningApproach } from "@shared/types";
import { approachUnconfirmed } from "@/lib/lightning";

type LightningApproachChipProps = {
  approach: LightningApproach | null | undefined;
  stopWork: boolean;
  unconfirmed: boolean;
  nowMs: number | null;
  demo?: boolean;
};

/** Arrival estimates run late. Always use a broad heads-up, never an arrival time or countdown. */
export default function LightningApproachChip({ approach, stopWork, unconfirmed, nowMs, demo = false }: LightningApproachChipProps) {
  if (stopWork || !approach) return null;
  const uncertain = unconfirmed || (!demo && approachUnconfirmed(approach, nowMs));
  const motion = approach.from_direction && Number.isFinite(approach.speed_mph)
    ? `Storm approaching from the ${approach.from_direction} at ${Math.round(approach.speed_mph)} mph`
    : "Storm direction and speed unavailable";

  return <div role="status" className={`space-y-1.5 border-2 border-dashed p-3 ${uncertain ? "border-muted bg-bg text-muted" : "border-risk-amber-solid bg-risk-amber-bg text-text"}`}>
    <p>
      {approach.replay && <span className="pc-chip pc-chip--replay me-2 align-middle" title="From a storm replay, not a real advisory">REPLAY</span>}
      <span className={`pc-chip ${uncertain ? "pc-chip--unknown" : approach.replay ? "pc-chip--replay-stop" : "pc-chip--approach"}`}>LIGHTNING POSSIBLE WITHIN THE HOUR</span>
      {uncertain && <span className="pc-label ms-2 align-middle">Unconfirmed</span>}
    </p>
    <p className="text-sm font-semibold">{uncertain && "Last known: "}{motion}</p>
    <p className="text-xs">{demo ? "Demo data · " : ""}{uncertain ? "Not confirmed · " : ""}Lightning can arrive sooner. Stay alert for stop-work orders.</p>
  </div>;
}
