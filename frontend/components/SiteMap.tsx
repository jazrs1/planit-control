"use client";

import { useEffect, useRef, useState } from "react";
import type { Alert, FireDetection, HazardReport, LightningCell, LightningFlash, Site, WildlifeSightingPoint } from "@shared/types";
import type { ExpressionSpecification, GeoJSONSource, Map as LibreMap, Marker } from "maplibre-gl";
import { liveHazardIndex, riskLevel } from "@/lib/risk";
import { cellUnconfirmed, stormCellsGeoJson } from "@/lib/lightning";
import { formatStrikeDistance } from "@/lib/alerts";
import { paintBasemap } from "@/lib/mapStyle";
import { formatAgo } from "@/lib/time";
import { resolveColor } from "@/lib/themeColor";

const LIGHTNING_SOURCE = "recent-lightning";
const CELLS_SOURCE = "storm-cells";
const REPORTS_SOURCE = "crew-reports";
const FIRES_SOURCE = "fires";
const WILDLIFE_SOURCE = "wildlife";
/** Flashes older than this are gone; matches the /lightning/recent window the dashboard asks for. */
export const LIGHTNING_WINDOW_MIN = 15;
/** A tile that loads this long after the last error means the tile server has recovered. */
const TILE_RECOVERY_MS = 3_000;

/** Newest flash: opacity 1 and largest; a flash at the end of the window: faint (0.3) and small, but still findable. */
/** Replay flashes age on the replay clock (`nowMs`); real ones on real time (`realNowMs`), since the
 *  server clock is set back to the storm's date during a replay. */
function lightningGeoJson(flashes: LightningFlash[], nowMs: number, realNowMs: number, isReplay: (flash: LightningFlash) => boolean): GeoJSON.FeatureCollection<GeoJSON.Point> {
  const windowMs = LIGHTNING_WINDOW_MIN * 60_000;
  const features = flashes.map((flash) => {
    const replay = isReplay(flash);
    const age = Math.min(1, Math.max(0, ((replay ? nowMs : realNowMs) - Date.parse(flash.ts)) / windowMs));
    return {
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [flash.lon, flash.lat] },
      properties: { opacity: 1 - 0.7 * age, radius: 4.5 - 1.5 * age, age, replay },
    };
  });
  // Oldest first, so the newest flashes draw on top.
  features.sort((a, b) => b.properties.age - a.properties.age);
  return { type: "FeatureCollection", features };
}

/** Map layers the dashboard's layers panel can hide. */
export type MapLayers = { lightning: boolean; cells: boolean; sites: boolean; reports: boolean; fires: boolean; wildlife: boolean };
const ALL_LAYERS: MapLayers = { lightning: true, cells: true, sites: true, reports: true, fires: true, wildlife: false };

const NO_REPLAY = () => false;
/** A 20px (10 CSS px) triangle with a thin light rim, drawn once for the fire layer. */
function fireIcon(color: string): ImageData {
  const size = 20, canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d")!;
  g.beginPath(); g.moveTo(size / 2, 2); g.lineTo(size - 2, size - 3); g.lineTo(2, size - 3); g.closePath();
  g.fillStyle = color; g.fill();
  g.lineWidth = 2; g.strokeStyle = "rgba(255, 255, 255, 0.85)"; g.stroke();
  return g.getImageData(0, 0, size, size);
}

/** A value that recedes at statewide zoom (scaled by `low` at zoom 5) and is full size from zoom 9.
 *  MapLibre only allows zoom at the top of an expression, so the data value goes inside each stop. */
function byZoom(value: ExpressionSpecification | number, low: number): ExpressionSpecification {
  return ["interpolate", ["linear"], ["zoom"], 5, ["*", low, value], 9, value];
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
  /** Real time for real flashes' fade (frozen like flashNowMs when lightning data is stale). */
  realFlashNowMs?: number;
  /** Which flashes belong to a storm replay (drawn blue, never as real lightning). */
  isReplayFlash?: (flash: LightningFlash) => boolean;
  /** Satellite fire detections, last 24 h. */
  fires?: FireDetection[];
  /** Alligator and venomous-snake sightings and crew wildlife reports, last 30 days. */
  wildlife?: WildlifeSightingPoint[];
  /** The last fires / wildlife refresh failed or the connection is lost: draw those points greyed, as last known. */
  firesStale?: boolean;
  wildlifeStale?: boolean;
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

export default function SiteMap({ sites, alerts, flashes, cells, cellsUnconfirmed, demo, nowMs, flashNowMs, selectedId, onSelect, layers = ALL_LAYERS, callouts = false, reports = [], fires = [], wildlife = [], firesStale = false, wildlifeStale = false, focusKey = 0, isReplayFlash = NO_REPLAY, realFlashNowMs }: SiteMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<LibreMap | null>(null);
  const markers = useRef(new Map<string, Marker>());
  const labels = useRef<Marker[]>([]);
  const fitted = useRef(false);
  const [ready, setReady] = useState(false);
  const [styleLoaded, setStyleLoaded] = useState(false);
  const [error, setError] = useState(false);
  // The basemap's first tiles have drawn: until then the map shows "Loading map…" on the land color.
  const [painted, setPainted] = useState(false);

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
      instance.on("load", () => { setError(false); setPainted(true); });
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
      // One stop-work per site, the real one when a site has both (a real stop-work never looks like a replay).
      const lightning = new Map<string, Alert>();
      for (const a of alerts) if (a.type === "lightning" && (!lightning.has(a.site_id) || !a.replay)) lightning.set(a.site_id, a);
      for (const site of sites) {
        const stop = lightning.get(site.id);
        const button = document.createElement("button");
        button.type = "button";
        // Shape carries the band without color: circle, triangle, diamond; octagon for a stop-work.
        // A replay stop-work gets a dashed blue ring, never the real red halo.
        button.className = `site-marker${stop ? stop.replay ? " site-marker--replay" : " site-marker--lightning" : ""}`;
        const shape = document.createElement("span");
        shape.className = `pc-shape pc-shape--${stop ? "stop" : riskLevel(liveHazardIndex(site))}`;
        button.append(shape);
        button.title = `${site.name}: ${liveHazardIndex(site).toFixed(1)} / 10${stop ? stop.replay ? " · REPLAY lightning stop work" : " · Lightning stop work" : ""}`;
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
    const ink: ExpressionSpecification = ["case", ["get", "replay"], resolveColor("--pc-notice"), resolveColor("--pc-risk-amber")];
    const muted = resolveColor("--pc-text-muted");
    const amberFill = resolveColor("--pc-risk-amber-solid");
    const fill: ExpressionSpecification = ["case", ["get", "replay"], resolveColor("--pc-notice"), amberFill];
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
        "fill-opacity": ["case", ["get", "uncertain"], 0.06, 0.1],
      },
    }, before);
    instance.addLayer({
      id: `${CELLS_SOURCE}-outline`, type: "line", source: CELLS_SOURCE,
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "line-color": ["case", ["get", "uncertain"], muted, fill], "line-width": 1, "line-opacity": 0.5 },
    }, before);
    instance.addLayer({
      id: `${CELLS_SOURCE}-arrows`, type: "line", source: CELLS_SOURCE,
      filter: ["==", ["geometry-type"], "LineString"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["case", ["get", "uncertain"], muted, ink], "line-width": 1.5, "line-opacity": 0.7 },
    }, before);
  }, [styleLoaded, cells, cellsUnconfirmed, demo, nowMs]);

  // Recent lightning: a GeoJSON circle layer under the site markers (markers are DOM, always on top).
  useEffect(() => {
    const instance = map.current;
    if (!styleLoaded || !instance) return;
    const data = lightningGeoJson(flashes, flashNowMs, realFlashNowMs ?? flashNowMs, isReplayFlash);
    // Replay flashes are blue like every replay mark; real ones keep the lightning yellow.
    const flash: ExpressionSpecification = ["case", ["get", "replay"], resolveColor("--pc-lightning-replay"), resolveColor("--pc-lightning")];
    const ring = resolveColor("--pc-lightning-ring");
    const source = instance.getSource<GeoJSONSource>(LIGHTNING_SOURCE);
    if (source) { void source.setData(data); return; }
    instance.addSource(LIGHTNING_SOURCE, { type: "geojson", data });
    // A soft glow under each flash that fades with age, like the dot itself.
    instance.addLayer({
      id: `${LIGHTNING_SOURCE}-glow`,
      type: "circle",
      source: LIGHTNING_SOURCE,
      paint: {
        "circle-color": flash,
        "circle-radius": byZoom(["*", 3.2, ["get", "radius"]], 0.45),
        "circle-blur": 1,
        "circle-opacity": byZoom(["*", 0.4, ["get", "opacity"]], 0.45),
      },
    });
    instance.addLayer({
      id: LIGHTNING_SOURCE,
      type: "circle",
      source: LIGHTNING_SOURCE,
      paint: {
        "circle-color": flash,
        "circle-stroke-color": ring,
        "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 5, 0.4, 9, 1],
        // Smaller and fainter statewide so site markers lead; full size zoomed in.
        "circle-radius": byZoom(["get", "radius"], 0.5),
        "circle-opacity": byZoom(["get", "opacity"], 0.55),
        // A faint ring keeps dots visible on the light basemap without muddying dense clusters.
        "circle-stroke-opacity": ["*", 0.7, ["get", "opacity"]],
      },
    });
  }, [styleLoaded, flashes, flashNowMs, realFlashNowMs, isReplayFlash]);

  // The layers panel hides whole layers; the data keeps updating underneath.
  useEffect(() => {
    const instance = map.current;
    if (!styleLoaded || !instance) return;
    const show = (id: string, visible: boolean) => { if (instance.getLayer(id)) instance.setLayoutProperty(id, "visibility", visible ? "visible" : "none"); };
    show(LIGHTNING_SOURCE, layers.lightning);
    show(`${LIGHTNING_SOURCE}-glow`, layers.lightning);
    show(REPORTS_SOURCE, layers.reports);
    show(`${REPORTS_SOURCE}-age`, layers.reports);
    show(FIRES_SOURCE, layers.fires);
    show(WILDLIFE_SOURCE, layers.wildlife);
    for (const part of ["fill", "outline", "arrows"]) show(`${CELLS_SOURCE}-${part}`, layers.cells);
  }, [styleLoaded, layers.lightning, layers.cells, layers.reports, layers.fires, layers.wildlife, flashes, cells, reports, fires, wildlife]);

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
          : { site, text: formatStrikeDistance(distance) ? `Stop work · ${formatStrikeDistance(distance)}` : "Stop work", tone: "stop" });
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
        el.innerHTML = group.items.slice(0, 3).map((row) => `<span class="site-callout__row site-callout__row--${row.tone}"><b>${escapeHtml(row.site.name)}</b><span>${row.tone === "replay" ? '<span class="pc-chip pc-chip--replay">REPLAY</span>' : ""}${row.text}</span></span>`).join("")
          + (group.items.length > 3 ? `<span class="site-callout__more">+${group.items.length - 3} more</span>` : "");
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
      // Reports are real, never replayed, so their age is on real time (the backend clock is simulated
      // during a replay). Ages refresh with each 60-second reports poll.
      features: reports.filter((report) => Number.isFinite(report.lat) && Number.isFinite(report.lon))
        .map((report) => ({ type: "Feature", geometry: { type: "Point", coordinates: [report.lon, report.lat] },
          properties: { category: report.category, age: Number.isFinite(Date.parse(report.created_at)) ? formatAgo(Math.max(0, Date.now() - Date.parse(report.created_at))) : "" } })),
    };
    const source = instance.getSource<GeoJSONSource>(REPORTS_SOURCE);
    if (source) { void source.setData(data); return; }
    instance.addSource(REPORTS_SOURCE, { type: "geojson", data });
    instance.addLayer({
      id: REPORTS_SOURCE, type: "circle", source: REPORTS_SOURCE,
      paint: { "circle-color": resolveColor("--pc-ink"), "circle-radius": 5, "circle-stroke-color": resolveColor("--pc-surface"), "circle-stroke-width": 2 },
    });
    // Each pin's age ("2 h ago") under it.
    instance.addLayer({
      id: `${REPORTS_SOURCE}-age`, type: "symbol", source: REPORTS_SOURCE,
      layout: { "text-field": ["get", "age"], "text-font": ["Montserrat Medium"], "text-size": 11, "text-offset": [0, 1.1], "text-anchor": "top", "text-optional": true },
      paint: { "text-color": resolveColor("--pc-text"), "text-halo-color": resolveColor("--pc-surface"), "text-halo-width": 1.5 },
    });
  }, [styleLoaded, reports]);

  // Fires: red dots; seen on 2+ passes or high confidence (what the wildfire card calls confirmed) is
  // larger and solid, a single pass is smaller and faint (it can be a flare or a hot roof).
  useEffect(() => {
    const instance = map.current;
    if (!styleLoaded || !instance) return;
    const data: GeoJSON.FeatureCollection<GeoJSON.Point> = {
      type: "FeatureCollection",
      features: fires.filter((fire) => Number.isFinite(fire.lat) && Number.isFinite(fire.lon)).map((fire) => ({
        type: "Feature", geometry: { type: "Point", coordinates: [fire.lon, fire.lat] },
        properties: { confirmed: fire.passes_24h >= 2 || fire.confidence === "high" },
      })),
    };
    const source = instance.getSource<GeoJSONSource>(FIRES_SOURCE);
    if (source) { void source.setData(data); return; }
    if (!instance.hasImage("pc-fire")) instance.addImage("pc-fire", fireIcon(resolveColor("--pc-fire")), { pixelRatio: 2 });
    instance.addSource(FIRES_SOURCE, { type: "geojson", data });
    // Under the site markers and quieter than them: a small dark-orange triangle, never a stop-work red.
    instance.addLayer({
      id: FIRES_SOURCE, type: "symbol", source: FIRES_SOURCE,
      layout: { "icon-image": "pc-fire", "icon-size": byZoom(["case", ["get", "confirmed"], 1, 0.75], 0.7), "icon-allow-overlap": true },
      paint: { "icon-opacity": ["case", ["get", "confirmed"], 0.9, 0.5] },
    });
  }, [styleLoaded, fires]);

  // Wildlife: hollow rings, so they never read as a risk color.
  useEffect(() => {
    const instance = map.current;
    if (!styleLoaded || !instance) return;
    const data: GeoJSON.FeatureCollection<GeoJSON.Point> = {
      type: "FeatureCollection",
      features: wildlife.filter((w) => Number.isFinite(w.lat) && Number.isFinite(w.lon))
        .map((w) => ({ type: "Feature", geometry: { type: "Point", coordinates: [w.lon, w.lat] }, properties: { species: w.species ?? "Unnamed" } })),
    };
    const source = instance.getSource<GeoJSONSource>(WILDLIFE_SOURCE);
    if (source) { void source.setData(data); return; }
    instance.addSource(WILDLIFE_SOURCE, { type: "geojson", data });
    instance.addLayer({
      id: WILDLIFE_SOURCE, type: "circle", source: WILDLIFE_SOURCE,
      paint: { "circle-color": resolveColor("--pc-surface"), "circle-radius": 4, "circle-stroke-color": resolveColor("--pc-text"), "circle-stroke-width": 2 },
    });
  }, [styleLoaded, wildlife]);

  // Unknown must look unknown: after a failed refresh (or a lost connection) the last known fires and
  // sightings stay on the map, greyed, instead of looking current.
  useEffect(() => {
    const instance = map.current;
    if (!styleLoaded || !instance) return;
    if (instance.getLayer(FIRES_SOURCE)) {
      if (!instance.hasImage("pc-fire-stale")) instance.addImage("pc-fire-stale", fireIcon(resolveColor("--pc-text-muted")), { pixelRatio: 2 });
      instance.setLayoutProperty(FIRES_SOURCE, "icon-image", firesStale ? "pc-fire-stale" : "pc-fire");
      instance.setPaintProperty(FIRES_SOURCE, "icon-opacity", firesStale ? 0.8 : ["case", ["get", "confirmed"], 0.9, 0.5]);
    }
    if (instance.getLayer(WILDLIFE_SOURCE)) {
      instance.setPaintProperty(WILDLIFE_SOURCE, "circle-stroke-color", resolveColor(wildlifeStale ? "--pc-text-muted" : "--pc-text"));
      instance.setPaintProperty(WILDLIFE_SOURCE, "circle-opacity", wildlifeStale ? 0.8 : 1);
      instance.setPaintProperty(WILDLIFE_SOURCE, "circle-stroke-opacity", wildlifeStale ? 0.8 : 1);
    }
  }, [styleLoaded, firesStale, wildlifeStale, fires, wildlife]);

  return <><div ref={container} className="h-full w-full bg-(--pc-map-land)" />
    <ul className="sr-only" aria-label="Storm cell motion">
      {cells.map((cell) => <li key={cell.id}>
        {demo && "Demo data · "}Storm cell at {cell.lat.toFixed(2)}, {cell.lon.toFixed(2)}, radius {cell.radius_mi.toFixed(1)} mi. {cell.tracked ? cell.heading_deg !== null && cell.speed_mph !== null && cell.speed_mph >= 2 ? `Moving toward ${cell.moving_toward ?? `${cell.heading_deg} degrees`} at ${Math.round(cell.speed_mph)} mph.` : "Stationary." : "Motion unconfirmed."}
        {(cellsUnconfirmed || (!demo && cellUnconfirmed(cell, nowMs))) && " Last known · Not confirmed."}
      </li>)}
    </ul>
    {!painted && !error && <p role="status" className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-muted">Loading map…</p>}
    {error && <p role="status" className="absolute inset-bs-3 inset-s-3 max-w-64 rounded-card border-2 border-rule bg-surface p-3 text-sm text-muted">Map tiles unavailable. Site details remain available in the ranked list.</p>}</>;
}
