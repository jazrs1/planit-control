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

  // An advisory, not an order: quiet (thin dashed outline, sentence case) and labeled as an advisory.
  return <div role="status" className={`space-y-1 rounded-card border border-dashed px-3 py-2.5 ${uncertain ? "border-muted bg-bg text-muted" : approach.replay ? "border-notice bg-surface text-text" : "border-risk-amber-solid bg-risk-amber-bg/60 text-text"}`}>
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {approach.replay && <span className="pc-chip pc-chip--replay" title="From a storm replay, not a real advisory">REPLAY</span>}
      <span className={`text-sm font-semibold ${uncertain ? "" : approach.replay ? "text-notice" : "text-risk-amber"}`}>Lightning possible within the hour</span>
      <span className="text-xs text-muted">{uncertain ? "Advisory · unconfirmed" : "Advisory"}</span>
    </p>
    <p className="text-sm">{uncertain && "Last known: "}{motion}</p>
    <p className="text-xs text-muted">{demo ? "Demo data · " : ""}{uncertain ? "Not confirmed · " : ""}Lightning can arrive sooner. Stay alert for stop-work orders.</p>
  </div>;
}
