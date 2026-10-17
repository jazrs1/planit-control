"use client";

import { useEffect, useRef, useState } from "react";
import type { Alert, HazardReport, LightningCell, LightningFlash, Site } from "@shared/types";
import type { GeoJSONSource, Map as LibreMap, Marker } from "maplibre-gl";
import { riskLevel } from "@/lib/risk";
import { cellUnconfirmed, stormCellsGeoJson } from "@/lib/lightning";
import { resolveColor } from "@/lib/themeColor";

const LIGHTNING_SOURCE = "recent-lightning";
const CELLS_SOURCE = "storm-cells";
const REPORTS_SOURCE = "crew-reports";
/** Flashes older than this are gone; matches the /lightning/recent window the dashboard asks for. */
export const LIGHTNING_WINDOW_MIN = 15;
/** A tile that loads this long after the last error means the tile server has recovered. */
const TILE_RECOVERY_MS = 3_000;

/** Newest flash: opacity 1 and largest; a flash at the end of the window: faint (0.3) and small, but still findable. */
function lightningGeoJson(flashes: LightningFlash[], nowMs: number): GeoJSON.FeatureCollection<GeoJSON.Point> {
  const windowMs = LIGHTNING_WINDOW_MIN * 60_000;
  const features = flashes.map((flash) => {
    const age = Math.min(1, Math.max(0, (nowMs - Date.parse(flash.ts)) / windowMs));
    return {
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [flash.lon, flash.lat] },
      properties: { opacity: 1 - 0.7 * age, radius: 4.5 - 1.5 * age, age },
    };
  });
  // Oldest first, so the newest flashes draw on top.
  features.sort((a, b) => b.properties.age - a.properties.age);
  return { type: "FeatureCollection", features };
}

/** Map layers the dashboard's layers panel can hide. */
export type MapLayers = { lightning: boolean; cells: boolean; sites: boolean; reports: boolean };
const ALL_LAYERS: MapLayers = { lightning: true, cells: true, sites: true, reports: true };

/** Recolor the Carto basemap from the --pc-map-* tokens. */
function paintBasemap(instance: LibreMap) {
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

type SiteMapProps = {
  sites: Site[];
  alerts: Alert[];
  /** Recent flashes, any order. */
  flashes: LightningFlash[];
  cells: LightningCell[];
  cellsUnconfirmed: boolean;
  demo: boolean;
  /** Backend clock for cell freshness, simulated during replay. */
  nowMs: number;
  /** Freeze flash fading during a failed flash poll without freezing the cell freshness clock. */
  flashNowMs: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Which layers to draw; all of them unless the dashboard's layers panel hides some. */
  layers?: MapLayers;
  /** Crew hazard reports to pin on the map (newest first). */
  reports?: HazardReport[];
  /** Changes when "Show on map" asks to center on the selected site again. */
  focusKey?: number;
  /** Label stop-work and flood sites on the map. Labels never cover [data-map-avoid] panels or leave the map. */
  callouts?: boolean;
};

const PLACEMENTS = [
  { side: "east", anchor: "left", offset: [20, 0] },
  { side: "west", anchor: "right", offset: [-20, 0] },
  { side: "north", anchor: "bottom", offset: [0, -20] },
  { side: "south", anchor: "top", offset: [0, 20] },
] as const;

function escapeHtml(text: string) {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

export default function SiteMap({ sites, alerts, flashes, cells, cellsUnconfirmed, demo, nowMs, flashNowMs, selectedId, onSelect, layers = ALL_LAYERS, callouts = false, reports = [], focusKey = 0 }: SiteMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<LibreMap | null>(null);
  const markers = useRef(new Map<string, Marker>());
  const labels = useRef<Marker[]>([]);
  const fitted = useRef(false);
  const [ready, setReady] = useState(false);
  const [styleLoaded, setStyleLoaded] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | undefined;
    let lastErrorAt = 0;
    void import("maplibre-gl").then((lib) => {
      if (disposed || !container.current) return;
      // maplibre builds its worker URL at runtime relative to its own chunk, which Next's bundler
      // moves, so the worker 404s and no tiles render. A static new URL() lets the bundler emit it.
      lib.setWorkerUrl(new URL("maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url).href);
      const instance = new lib.Map({ container: container.current, style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json", center: [-83.5, 28.2], zoom: 5.5, attributionControl: { compact: false } });
      map.current = instance;
      instance.addControl(new lib.NavigationControl(), "top-right");
      instance.on("error", () => { lastErrorAt = Date.now(); setError(true); });
      instance.on("load", () => setError(false));
      // Custom layers can be added once the style is parsed; "load" also waits for every initial tile.
      instance.on("style.load", () => { paintBasemap(instance); setStyleLoaded(true); });
      // Clear the notice once basemap tiles load again after an error, without a reload.
      instance.on("sourcedata", (e) => {
        if (e.tile && e.sourceId !== LIGHTNING_SOURCE && Date.now() - lastErrorAt > TILE_RECOVERY_MS) setError(false);
      });
      observer = new ResizeObserver(() => instance.resize());
      observer.observe(container.current);
      setReady(true);
    }).catch(() => { if (!disposed) setError(true); });
    return () => { disposed = true; observer?.disconnect(); markers.current.forEach((m) => m.remove()); markers.current.clear(); map.current?.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    if (!ready || !map.current) return;
    let disposed = false;
    void import("maplibre-gl").then(({ Marker }) => {
      if (disposed || !map.current) return;
      markers.current.forEach((marker) => marker.remove());
      markers.current.clear();
      const lightning = new Map(alerts.filter((a) => a.type === "lightning").map((a) => [a.site_id, a]));
      for (const site of sites) {
        const stop = lightning.get(site.id);
        const button = document.createElement("button");
        button.type = "button";
        // Shape carries the band without color: circle, triangle, diamond; octagon for a stop-work.
        // A replay stop-work gets a dashed blue ring, never the real red halo.
        button.className = `site-marker${stop ? stop.replay ? " site-marker--replay" : " site-marker--lightning" : ""}`;
        const shape = document.createElement("span");
        shape.className = `pc-shape pc-shape--${stop ? "stop" : riskLevel(site.hazard_index)}`;
        button.append(shape);
        button.title = `${site.name}: ${site.hazard_index.toFixed(1)} / 10${stop ? stop.replay ? " · REPLAY lightning stop work" : " · Lightning stop work" : ""}`;
        button.setAttribute("aria-label", button.title);
        button.setAttribute("aria-pressed", String(site.id === selectedId));
        button.addEventListener("click", () => onSelect(site.id));
        if (!layers.sites) button.hidden = true;
        markers.current.set(site.id, new Marker({ element: button }).setLngLat([site.lon, site.lat]).addTo(map.current));
      }
    });
    return () => { disposed = true; };
  }, [ready, sites, alerts, onSelect, selectedId, layers.sites]);

  useEffect(() => {
    const instance = map.current;
    if (!styleLoaded || !instance) return;
    const data = stormCellsGeoJson(cells, nowMs, cellsUnconfirmed, demo);
    // Paint needs real colors, so resolve them from tokens.css (light or dark).
    const ink = resolveColor("--pc-risk-amber");
    const muted = resolveColor("--pc-text-muted");
    const fill = resolveColor("--pc-risk-amber-solid");
    const source = instance.getSource<GeoJSONSource>(CELLS_SOURCE);
    if (source) {
      void source.setData(data);
      instance.setPaintProperty(`${CELLS_SOURCE}-fill`, "fill-color", ["case", ["get", "uncertain"], muted, fill]);
      instance.setPaintProperty(`${CELLS_SOURCE}-outline`, "line-color", ["case", ["get", "uncertain"], muted, fill]);
      instance.setPaintProperty(`${CELLS_SOURCE}-arrows`, "line-color", ["case", ["get", "uncertain"], muted, ink]);
      return;
    }
    instance.addSource(CELLS_SOURCE, { type: "geojson", data });
    const before = instance.getLayer(LIGHTNING_SOURCE) ? LIGHTNING_SOURCE : undefined;
    instance.addLayer({
      id: `${CELLS_SOURCE}-fill`, type: "fill", source: CELLS_SOURCE,
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: {
        "fill-color": ["case", ["get", "uncertain"], muted, fill],
        "fill-opacity": ["case", ["get", "uncertain"], 0.1, 0.18],
      },
    }, before);
    instance.addLayer({
      id: `${CELLS_SOURCE}-outline`, type: "line", source: CELLS_SOURCE,
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "line-color": ["case", ["get", "uncertain"], muted, fill], "line-width": 1.5, "line-opacity": 0.8 },
    }, before);
    instance.addLayer({
      id: `${CELLS_SOURCE}-arrows`, type: "line", source: CELLS_SOURCE,
      filter: ["==", ["geometry-type"], "LineString"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["case", ["get", "uncertain"], muted, ink], "line-width": 2 },
    }, before);
  }, [styleLoaded, cells, cellsUnconfirmed, demo, nowMs]);

  // Recent lightning: a GeoJSON circle layer under the site markers (markers are DOM, always on top).
  useEffect(() => {
    const instance = map.current;
    if (!styleLoaded || !instance) return;
    const data = lightningGeoJson(flashes, flashNowMs);
    const flash = resolveColor("--pc-lightning"), ring = resolveColor("--pc-lightning-ring");
    const source = instance.getSource<GeoJSONSource>(LIGHTNING_SOURCE);
    if (source) {
      void source.setData(data);
      instance.setPaintProperty(`${LIGHTNING_SOURCE}-glow`, "circle-color", flash);
      instance.setPaintProperty(LIGHTNING_SOURCE, "circle-color", flash);
      instance.setPaintProperty(LIGHTNING_SOURCE, "circle-stroke-color", ring);
      return;
    }
    instance.addSource(LIGHTNING_SOURCE, { type: "geojson", data });
    // A soft glow under each flash that fades with age, like the dot itself.
    instance.addLayer({
      id: `${LIGHTNING_SOURCE}-glow`,
      type: "circle",
      source: LIGHTNING_SOURCE,
      paint: {
        "circle-color": flash,
        "circle-radius": ["*", 3.2, ["get", "radius"]],
        "circle-blur": 1,
        "circle-opacity": ["*", 0.55, ["get", "opacity"]],
      },
    });
    instance.addLayer({
      id: LIGHTNING_SOURCE,
      type: "circle",
      source: LIGHTNING_SOURCE,
      paint: {
        "circle-color": flash,
        "circle-stroke-color": ring,
        "circle-stroke-width": 1,
        "circle-radius": ["get", "radius"],
        "circle-opacity": ["get", "opacity"],
        // A faint ring keeps dots visible on the light basemap without muddying dense clusters.
        "circle-stroke-opacity": ["*", 0.7, ["get", "opacity"]],
      },
    });
  }, [styleLoaded, flashes, flashNowMs]);

  // The layers panel hides whole layers; the data keeps updating underneath.
  useEffect(() => {
    const instance = map.current;
    if (!styleLoaded || !instance) return;
    const show = (id: string, visible: boolean) => { if (instance.getLayer(id)) instance.setLayoutProperty(id, "visibility", visible ? "visible" : "none"); };
    show(LIGHTNING_SOURCE, layers.lightning);
    show(`${LIGHTNING_SOURCE}-glow`, layers.lightning);
    show(REPORTS_SOURCE, layers.reports);
    for (const part of ["fill", "outline", "arrows"]) show(`${CELLS_SOURCE}-${part}`, layers.cells);
  }, [styleLoaded, layers.lightning, layers.cells, layers.reports, flashes, cells, reports]);

  // Frame every site once, clear of the panels laid over the map (layers top-left, legend at the bottom).
  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance || fitted.current || sites.length === 0 || !container.current) return;
    fitted.current = true;
    const lons = sites.map((site) => site.lon), lats = sites.map((site) => site.lat);
    const wide = container.current.clientWidth > 700;
    instance.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], {
      // Wide: the site list floats over the right side and the replay panel over the bottom.
      padding: wide ? { top: 40, bottom: 250, left: 270, right: 460 } : { top: 64, bottom: 24, left: 24, right: 48 },
      animate: false,
    });
  }, [ready, sites]);

  // Callouts: one label per cluster of alert sites, placed east, west, north or south of it, whichever
  // fits inside the map without covering a panel. If none fits, the label is left out (the marker stays).
  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance || !callouts) return;
    let disposed = false;
    let MarkerClass: typeof Marker | null = null;
    const clear = () => { labels.current.forEach((label) => label.remove()); labels.current = []; };
    const layout = () => {
      if (disposed || !MarkerClass || !container.current) return;
      clear();
      if (!layers.sites) return;
      const box = container.current.getBoundingClientRect();
      const avoid = [...document.querySelectorAll("[data-map-avoid]"), ...(container.current.querySelectorAll(".maplibregl-ctrl-top-right, .maplibregl-ctrl-bottom-right"))]
        .map((el) => el.getBoundingClientRect()).filter((rect) => rect.width > 0 && rect.height > 0);
      const placed: DOMRect[] = [];
      const byId = new Map(sites.map((site) => [site.id, site]));
      const rows = new Map<string, { site: Site; text: string; tone: "stop" | "replay" | "flood" }>();
      for (const alert of alerts) {
        const site = byId.get(alert.site_id);
        if (!site || (alert.type !== "lightning" && alert.type !== "flood")) continue;
        if (rows.get(site.id)?.tone === "stop") continue;
        const distance = alert.last_strike_distance_mi;
        rows.set(site.id, alert.type === "flood" ? { site, text: "Flood risk", tone: "flood" }
          : alert.replay ? { site, text: "Stop work", tone: "replay" }
          : { site, text: distance !== null && Number.isFinite(distance) ? `Stop work · ${(Math.floor(distance * 10) / 10).toFixed(1)} mi` : "Stop work", tone: "stop" });
      }
      // Cluster in screen space so nearby sites share one label.
      const groups: { x: number; y: number; items: typeof rows extends Map<string, infer V> ? V[] : never }[] = [];
      for (const row of rows.values()) {
        const point = instance.project([row.site.lon, row.site.lat]);
        if (point.x < 0 || point.y < 0 || point.x > box.width || point.y > box.height) continue;
        const group = groups.find((g) => Math.hypot(g.x - point.x, g.y - point.y) < 90);
        if (group) group.items.push(row); else groups.push({ x: point.x, y: point.y, items: [row] });
      }
      for (const group of groups) {
        const lead = group.items[0].site;
        const el = document.createElement("div");
        el.className = "site-callout";
        el.innerHTML = group.items.slice(0, 4).map((row) => `<span class="site-callout__row site-callout__row--${row.tone}"><b>${escapeHtml(row.site.name)}</b><span>${row.tone === "replay" ? '<span class="pc-chip pc-chip--replay">REPLAY</span>' : ""}${row.text}</span></span>`).join("")
          + (group.items.length > 4 ? `<span class="site-callout__more">+${group.items.length - 4} more</span>` : "");
        let fitted = false;
        for (const placement of PLACEMENTS) {
          el.dataset.side = placement.side;
          const label = new MarkerClass({ element: el, anchor: placement.anchor, offset: [...placement.offset] as [number, number] }).setLngLat([lead.lon, lead.lat]).addTo(instance);
          const rect = el.getBoundingClientRect();
          const inside = rect.left >= box.left + 4 && rect.right <= box.right - 4 && rect.top >= box.top + 4 && rect.bottom <= box.bottom - 4;
          const hits = (other: DOMRect) => rect.left < other.right + 4 && rect.right > other.left - 4 && rect.top < other.bottom + 4 && rect.bottom > other.top - 4;
          if (inside && !avoid.some(hits) && !placed.some(hits)) { labels.current.push(label); placed.push(rect); fitted = true; break; }
          label.remove();
        }
        if (!fitted) el.remove();
      }
    };
    void import("maplibre-gl").then(({ Marker }) => { MarkerClass = Marker; layout(); });
    instance.on("moveend", layout);
    instance.on("resize", layout);
    // The layers panel opens and closes: its size changes what a label may cover.
    const observer = new ResizeObserver(() => layout());
    document.querySelectorAll("[data-map-avoid]").forEach((el) => observer.observe(el));
    return () => { disposed = true; instance.off("moveend", layout); instance.off("resize", layout); observer.disconnect(); clear(); };
  }, [ready, callouts, sites, alerts, layers.sites]);

  useEffect(() => {
    if (!ready || !selectedId) return;
    const site = sites.find((s) => s.id === selectedId);
    // Center in the part of the map the floating panels leave open.
    const wide = (container.current?.clientWidth ?? 0) > 700;
    if (site) map.current?.easeTo({ center: [site.lon, site.lat], padding: wide ? { top: 40, bottom: 120, left: 270, right: 440 } : { top: 0, bottom: 0, left: 0, right: 0 }, duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 500 });
  }, [ready, selectedId, sites, focusKey]);

  // Crew reports: small ink pins with a white ring, above the flashes, under the site markers.
  useEffect(() => {
    const instance = map.current;
    if (!styleLoaded || !instance) return;
    const data: GeoJSON.FeatureCollection<GeoJSON.Point> = {
      type: "FeatureCollection",
      features: reports.filter((report) => Number.isFinite(report.lat) && Number.isFinite(report.lon))
        .map((report) => ({ type: "Feature", geometry: { type: "Point", coordinates: [report.lon, report.lat] }, properties: { category: report.category } })),
    };
    const source = instance.getSource<GeoJSONSource>(REPORTS_SOURCE);
    if (source) { void source.setData(data); return; }
    instance.addSource(REPORTS_SOURCE, { type: "geojson", data });
    instance.addLayer({
      id: REPORTS_SOURCE, type: "circle", source: REPORTS_SOURCE,
      paint: { "circle-color": resolveColor("--pc-ink"), "circle-radius": 5, "circle-stroke-color": resolveColor("--pc-surface"), "circle-stroke-width": 2 },
    });
  }, [styleLoaded, reports]);

  return <><div ref={container} className="h-full w-full" />
    <ul className="sr-only" aria-label="Storm cell motion">
      {cells.map((cell) => <li key={cell.id}>
        {demo && "Demo data · "}Storm cell at {cell.lat.toFixed(2)}, {cell.lon.toFixed(2)}, radius {cell.radius_mi.toFixed(1)} mi. {cell.tracked ? cell.heading_deg !== null && cell.speed_mph !== null && cell.speed_mph >= 2 ? `Moving toward ${cell.moving_toward ?? `${cell.heading_deg} degrees`} at ${Math.round(cell.speed_mph)} mph.` : "Stationary." : "Motion unconfirmed."}
        {(cellsUnconfirmed || (!demo && cellUnconfirmed(cell, nowMs))) && " Last known · Not confirmed."}
      </li>)}
    </ul>
    {error && <p role="status" className="absolute inset-bs-3 inset-s-3 max-w-64 rounded-card border-2 border-rule bg-surface p-3 text-sm text-muted">Map tiles unavailable. Site details remain available in the ranked list.</p>}</>;
}
