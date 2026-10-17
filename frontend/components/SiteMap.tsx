"use client";

import { useEffect, useRef, useState } from "react";
import type { Alert, LightningCell, LightningFlash, Site } from "@shared/types";
import type { GeoJSONSource, Map as LibreMap, Marker } from "maplibre-gl";
import { riskLevel } from "@/lib/risk";
import { cellUnconfirmed, stormCellsGeoJson } from "@/lib/lightning";
import { resolveColor } from "@/lib/themeColor";

const LIGHTNING_SOURCE = "recent-lightning";
const CELLS_SOURCE = "storm-cells";
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
export type MapLayers = { lightning: boolean; cells: boolean; sites: boolean };
const ALL_LAYERS: MapLayers = { lightning: true, cells: true, sites: true };

/** Recolor the Carto basemap from the --pc-map-* tokens (light or dark). */
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
};

export default function SiteMap({ sites, alerts, flashes, cells, cellsUnconfirmed, demo, nowMs, flashNowMs, selectedId, onSelect, layers = ALL_LAYERS }: SiteMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<LibreMap | null>(null);
  const markers = useRef(new Map<string, Marker>());
  const [ready, setReady] = useState(false);
  const [styleLoaded, setStyleLoaded] = useState(false);
  const [error, setError] = useState(false);
  // Bumped when the OS switches light/dark, so canvas-drawn layers repaint from the tokens.
  const [theme, setTheme] = useState(0);

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
      scheme.addEventListener("change", onScheme);
      setReady(true);
    }).catch(() => { if (!disposed) setError(true); });
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => { if (map.current?.isStyleLoaded()) paintBasemap(map.current); setTheme((value) => value + 1); };
    return () => { disposed = true; observer?.disconnect(); scheme.removeEventListener("change", onScheme); markers.current.forEach((m) => m.remove()); markers.current.clear(); map.current?.remove(); map.current = null; };
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
    const ink = resolveColor("--pc-rule");
    const muted = resolveColor("--pc-text-muted");
    const fill = resolveColor("--pc-risk-amber-solid");
    const source = instance.getSource<GeoJSONSource>(CELLS_SOURCE);
    if (source) {
      void source.setData(data);
      instance.setPaintProperty(`${CELLS_SOURCE}-fill`, "fill-color", ["case", ["get", "uncertain"], muted, fill]);
      instance.setPaintProperty(`${CELLS_SOURCE}-outline`, "line-color", ["case", ["get", "uncertain"], muted, ink]);
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
        "fill-opacity": ["case", ["get", "uncertain"], 0.12, 0.22],
      },
    }, before);
    instance.addLayer({
      id: `${CELLS_SOURCE}-outline`, type: "line", source: CELLS_SOURCE,
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "line-color": ["case", ["get", "uncertain"], muted, ink], "line-width": 1.5, "line-dasharray": [3, 2] },
    }, before);
    instance.addLayer({
      id: `${CELLS_SOURCE}-arrows`, type: "line", source: CELLS_SOURCE,
      filter: ["==", ["geometry-type"], "LineString"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["case", ["get", "uncertain"], muted, ink], "line-width": 2.5 },
    }, before);
  }, [styleLoaded, cells, cellsUnconfirmed, demo, nowMs, theme]);

  // Recent lightning: a GeoJSON circle layer under the site markers (markers are DOM, always on top).
  useEffect(() => {
    const instance = map.current;
    if (!styleLoaded || !instance) return;
    const data = lightningGeoJson(flashes, flashNowMs);
    const flash = resolveColor("--pc-lightning"), ring = resolveColor("--pc-lightning-ring");
    const source = instance.getSource<GeoJSONSource>(LIGHTNING_SOURCE);
    if (source) {
      void source.setData(data);
      instance.setPaintProperty(LIGHTNING_SOURCE, "circle-color", flash);
      instance.setPaintProperty(LIGHTNING_SOURCE, "circle-stroke-color", ring);
      return;
    }
    instance.addSource(LIGHTNING_SOURCE, { type: "geojson", data });
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
  }, [styleLoaded, flashes, flashNowMs, theme]);

  // The layers panel hides whole layers; the data keeps updating underneath.
  useEffect(() => {
    const instance = map.current;
    if (!styleLoaded || !instance) return;
    const show = (id: string, visible: boolean) => { if (instance.getLayer(id)) instance.setLayoutProperty(id, "visibility", visible ? "visible" : "none"); };
    show(LIGHTNING_SOURCE, layers.lightning);
    for (const part of ["fill", "outline", "arrows"]) show(`${CELLS_SOURCE}-${part}`, layers.cells);
  }, [styleLoaded, layers.lightning, layers.cells, flashes, cells]);

  useEffect(() => {
    if (!ready || !selectedId) return;
    const site = sites.find((s) => s.id === selectedId);
    if (site) map.current?.easeTo({ center: [site.lon, site.lat], duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 500 });
  }, [ready, selectedId, sites]);

  return <><div ref={container} className="h-full w-full" />
    <ul className="sr-only" aria-label="Storm cell motion">
      {cells.map((cell) => <li key={cell.id}>
        {demo && "Demo data · "}Storm cell at {cell.lat.toFixed(2)}, {cell.lon.toFixed(2)}, radius {cell.radius_mi.toFixed(1)} mi. {cell.tracked ? cell.heading_deg !== null && cell.speed_mph !== null && cell.speed_mph >= 2 ? `Moving toward ${cell.moving_toward ?? `${cell.heading_deg} degrees`} at ${Math.round(cell.speed_mph)} mph.` : "Stationary." : "Motion unconfirmed."}
        {(cellsUnconfirmed || (!demo && cellUnconfirmed(cell, nowMs))) && " Last known · Not confirmed."}
      </li>)}
    </ul>
    {error && <p role="status" className="absolute inset-bs-3 inset-s-3 max-w-64 rounded-card border-2 border-rule bg-surface p-3 text-sm text-muted">Map tiles unavailable. Site details remain available in the ranked list.</p>}</>;
}
