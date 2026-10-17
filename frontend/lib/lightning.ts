import type { LightningApproach, LightningCell } from "@shared/types";

// Advisories update every 20 s, with a 2 min grace period. Allow a short buffer for site polling.
const APPROACH_STALE_MS = 3 * 60_000;
// Cells use the last 5 min of flashes for motion. Older motion is no longer current.
const CELL_STALE_MS = 5 * 60_000;

export function approachUnconfirmed(approach: LightningApproach, nowMs: number | null): boolean {
  const updated = Date.parse(approach.updated_at);
  return !Number.isFinite(updated) || (nowMs !== null && (nowMs - updated > APPROACH_STALE_MS || updated > nowMs + 60_000));
}

// A replay cell's flashes are hours older than real time (the recorded storm's date).
const REPLAY_AGE_MS = 3 * 60 * 60_000;

/** A storm cell from a running replay: LightningCell.replay when the server sends it (#52), else the
 *  "replay-" id prefix, else a last flash hours older than real time. */
export function cellIsReplay(cell: LightningCell, realNowMs: number): boolean {
  const flag = (cell as LightningCell & { replay?: boolean }).replay;
  if (typeof flag === "boolean") return flag;
  if (cell.id.startsWith("replay-")) return true;
  const updated = Date.parse(cell.last_flash_at);
  return Number.isFinite(updated) && realNowMs - updated > REPLAY_AGE_MS;
}

/** Each layer on its own clock: a replay cell against the replay clock (`nowMs`), a real cell against
 *  real time (`realNowMs`, defaulting to `nowMs` outside a replay), so real cells stay during a replay. */
export function cellUnconfirmed(cell: LightningCell, nowMs: number, realNowMs: number = nowMs): boolean {
  const clock = cellIsReplay(cell, realNowMs) ? nowMs : realNowMs;
  const updated = Date.parse(cell.last_flash_at);
  return !Number.isFinite(updated) || clock - updated > CELL_STALE_MS || updated > clock + 60_000;
}

/** Destination on a sphere; bearings are clockwise from north and distances are miles. */
function destination(lon: number, lat: number, bearing: number, miles: number): number[] {
  const radians = Math.PI / 180;
  const distance = miles / 3958.7613;
  const heading = bearing * radians;
  const phi = lat * radians;
  const lambda = lon * radians;
  const nextPhi = Math.asin(Math.sin(phi) * Math.cos(distance) + Math.cos(phi) * Math.sin(distance) * Math.cos(heading));
  const nextLambda = lambda + Math.atan2(Math.sin(heading) * Math.sin(distance) * Math.cos(phi), Math.cos(distance) - Math.sin(phi) * Math.sin(nextPhi));
  return [nextLambda / radians, nextPhi / radians];
}

/** Geographic circles use radius_mi, so they retain the right size as the map zooms.
 * Arrows show direction only; their length is not an arrival or travel-distance forecast. */
export function stormCellsGeoJson(cells: LightningCell[], nowMs: number, unconfirmed: boolean, demo = false, realNowMs: number = nowMs): GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiLineString> {
  const features: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiLineString>[] = [];
  for (const cell of cells) {
    if (!Number.isFinite(cell.lat) || !Number.isFinite(cell.lon) || !Number.isFinite(cell.radius_mi) || cell.radius_mi < 0) continue;
    const uncertain = unconfirmed || (!demo && cellUnconfirmed(cell, nowMs, realNowMs));
    // Replay cells are drawn blue; real ones keep the storm colors.
    const properties = { uncertain, replay: cellIsReplay(cell, realNowMs) };
    const ring = Array.from({ length: 64 }, (_, i) => destination(cell.lon, cell.lat, i * 360 / 64, cell.radius_mi));
    ring.push(ring[0]);
    features.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties });

    // Untracked and stationary cells have no reliable direction: draw their circle without an arrow.
    if (!cell.tracked || cell.heading_deg === null || !Number.isFinite(cell.heading_deg) || cell.speed_mph === null || !Number.isFinite(cell.speed_mph) || cell.speed_mph < 2) continue;
    const length = Math.max(2, cell.radius_mi * 0.8);
    const tip = destination(cell.lon, cell.lat, cell.heading_deg, length);
    const left = destination(tip[0], tip[1], cell.heading_deg + 150, length * 0.3);
    const right = destination(tip[0], tip[1], cell.heading_deg - 150, length * 0.3);
    features.push({ type: "Feature", geometry: { type: "MultiLineString", coordinates: [[[cell.lon, cell.lat], tip], [left, tip, right]] }, properties });
  }
  return { type: "FeatureCollection", features };
}
