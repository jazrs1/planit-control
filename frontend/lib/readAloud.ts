import type { Alert, LightningApproach, Site } from "@shared/types";
import { formatStrikeDistance, replayCleared } from "@/lib/alerts";
import { HAZARD_LABEL } from "@/lib/risk";

// What the crew view's read-aloud says. Pure, so the rules are testable:
// - one site only, and only when its state changes (a new strike resetting the countdown is not a change);
// - replay alerts are prefixed "Replay:";
// - unknown is never "All clear": an alert can only end while the alert state is known.

/** The site's spoken state: unknown, or the set of active things, each with its own key. */
export type ReadAloudState =
  | { known: false }
  | { known: true; items: Map<string, string> };

/** Alert state that can't be trusted: no data yet, or the connection dropped. */
export function alertsKnown(alerts: Alert[] | null, status: string) {
  return alerts !== null && (status === "live" || status === "demo");
}

const miles = (text: string) => text.replace(/ mi$/, " miles");

export function readAloudState(site: Pick<Site, "id" | "name">, alerts: Alert[] | null, status: string, approach: LightningApproach | null | undefined, replayNowMs: number | null): ReadAloudState {
  if (!alertsKnown(alerts, status)) return { known: false };
  const items = new Map<string, string>();
  const mine = (alerts ?? []).filter((alert) => alert.site_id === site.id);
  for (const alert of mine) {
    // A replay stop-work whose countdown has ended on the replay clock is over.
    if (replayCleared(alert, replayNowMs)) continue;
    const prefix = alert.replay ? "Replay: " : "";
    const key = `${alert.type}:${alert.replay ? "replay" : "real"}`;
    if (alert.type === "lightning") {
      const distance = formatStrikeDistance(alert.last_strike_distance_mi);
      items.set(key, `${prefix}Stop work at ${site.name}. ${distance ? `Lightning ${miles(distance)} away.` : "Lightning within 10 miles."}`);
    } else if (alert.type === "flood") {
      items.set(key, `${prefix}Flood risk at ${site.name}.`);
    } else {
      items.set(key, `${prefix}${HAZARD_LABEL[alert.type]} alert at ${site.name}.`);
    }
  }
  // An advisory is hidden only by a stop-work of its own kind (real by real, replay by replay).
  if (approach && !items.has(`lightning:${approach.replay ? "replay" : "real"}`)) {
    items.set(`approach:${approach.replay ? "replay" : "real"}`, `${approach.replay ? "Replay: " : ""}Lightning possible within the hour at ${site.name}.`);
  }
  return { known: true, items };
}

/** What ending a state sounds like. An advisory ending says nothing: that's not an all clear. */
function ended(key: string, siteName: string): string | null {
  const [type, kind] = key.split(":");
  const prefix = kind === "replay" ? "Replay: " : "";
  if (type === "lightning") return `${prefix}All clear at ${siteName}. Stop work has ended.`;
  if (type === "flood") return `${prefix}Flood risk has ended at ${siteName}.`;
  if (type === "approach") return null;
  return `${prefix}${HAZARD_LABEL[type as keyof typeof HAZARD_LABEL] ?? "Alert"} alert has ended at ${siteName}.`;
}

/** The lines to speak going from `previous` (the last known state) to `next`, in priority order:
 *  real before replay, stop-work first. `wasUnknown`: the state in between was unknown. */
export function readAloudChanges(siteName: string, previous: ReadAloudState, next: ReadAloudState, wasUnknown: boolean): string[] {
  if (!next.known) return wasUnknown ? [] : [`Connection lost. Stop-work status at ${siteName} is unknown.`];
  const before = previous.known ? previous.items : new Map<string, string>();
  const lines: { order: number; text: string }[] = [];
  const order = (key: string) => (key.endsWith(":replay") ? 10 : 0) + (key.startsWith("lightning") ? 0 : key.startsWith("approach") ? 1 : 2);
  for (const [key, text] of next.items) if (!before.has(key)) lines.push({ order: order(key), text });
  for (const key of before.keys()) {
    if (next.items.has(key)) continue;
    const text = ended(key, siteName);
    if (text) lines.push({ order: order(key), text });
  }
  return lines.sort((a, b) => a.order - b.order).map((line) => line.text);
}
