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

  return <div role="status" className={`space-y-1 rounded-card border p-3 ${uncertain ? "border-dashed border-border bg-bg text-muted" : "border-risk-amber bg-risk-amber-bg text-risk-amber"}`}>
    <p className="text-xs font-bold tracking-wide">
      <span className="inline-block rounded-pill bg-surface px-2 py-1">LIGHTNING POSSIBLE WITHIN THE HOUR{uncertain && " ?"}</span>
    </p>
    <p className="pt-1 text-sm font-medium">{uncertain && "Last known: "}{motion}</p>
    <p className="text-xs">{demo ? "Demo data · " : ""}{uncertain ? "Not confirmed · " : ""}Lightning can arrive sooner. Stay alert for stop-work orders.</p>
  </div>;
}
