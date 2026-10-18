import type { Map as LibreMap } from "maplibre-gl";
import { resolveColor } from "@/lib/themeColor";

/** Recolor the Carto basemap from the --pc-map-* tokens. */
export function paintBasemap(instance: LibreMap) {
  const c = (token: string) => resolveColor(token);
  const land = c("--pc-map-land"), landAlt = c("--pc-map-land-alt"), water = c("--pc-map-water"), road = c("--pc-map-road"), roadCase = c("--pc-map-road-case");
  const boundary = c("--pc-map-boundary"), label = c("--pc-map-label"), waterLabel = c("--pc-map-water-label");
  for (const layer of instance.getStyle().layers ?? []) {
    const id = layer.id;
    if (id.startsWith("pc-")) continue;
    const set = (property: string, value: string) => { try { instance.setPaintProperty(id, property as Parameters<LibreMap["setPaintProperty"]>[1], value); } catch { /* property not on this layer type */ } };
    if (layer.type === "background") set("background-color", land);
    else if (id === "water" || id === "water_shadow") set("fill-color", water);
    else if (layer.type === "fill") set("fill-color", landAlt);
    else if (layer.type === "line" && /road|tunnel|bridge|rail|aeroway/.test(id)) set("line-color", id.includes("case") ? roadCase : road);
    else if (layer.type === "line" && id.startsWith("boundary")) set("line-color", boundary);
    else if (layer.type === "line" && id.startsWith("waterway")) set("line-color", water);
    else if (layer.type === "symbol") { set("text-color", /water/.test(id) ? waterLabel : label); set("text-halo-color", land); }
  }
}

/** Map glyphs, 24×24 SVG paths. Shapes (circle, triangle, diamond, octagon) are reserved for site risk,
 *  so other map symbols use these. A flame for satellite fire detections: */
export const FLAME_PATH = "M12 1.5C13.6 6.4 19.5 9.2 19.5 15.2 19.5 19.6 16.2 22.5 12 22.5S4.5 19.6 4.5 15.2C4.5 11.6 6.8 9.7 8.2 7.4 8.7 10 10 11.6 11.2 11.9 10.6 8.8 10.9 5.3 12 1.5Z";
/** A lightning bolt, for the "lightning possible" badge on a site marker. */
export const BOLT_PATH = "M13 2 4 14h7l-1 8 9-12h-7z";
