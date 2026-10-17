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
