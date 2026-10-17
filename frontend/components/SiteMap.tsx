"use client";

import { useEffect, useRef, useState } from "react";
import type { Alert, LightningCell, LightningFlash, Site } from "@shared/types";
import type { GeoJSONSource, Map as LibreMap, Marker } from "maplibre-gl";
import { riskLevel } from "@/lib/risk";
import { cellUnconfirmed, stormCellsGeoJson } from "@/lib/lightning";

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
};

export default function SiteMap({ sites, alerts, flashes, cells, cellsUnconfirmed, demo, nowMs, flashNowMs, selectedId, onSelect }: SiteMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<LibreMap | null>(null);
  const markers = useRef(new Map<string, Marker>());
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
      instance.on("style.load", () => setStyleLoaded(true));
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
      const lightning = new Set(alerts.filter((a) => a.type === "lightning").map((a) => a.site_id));
      for (const site of sites) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `site-marker site-marker--${riskLevel(site.hazard_index)}${lightning.has(site.id) ? " site-marker--lightning" : ""}`;
        button.title = `${site.name}: ${site.hazard_index.toFixed(1)} / 10${lightning.has(site.id) ? " · Lightning stop work" : ""}`;
        button.setAttribute("aria-label", button.title);
        button.setAttribute("aria-pressed", String(site.id === selectedId));
        button.addEventListener("click", () => onSelect(site.id));
        markers.current.set(site.id, new Marker({ element: button }).setLngLat([site.lon, site.lat]).addTo(map.current));
      }
    });
    return () => { disposed = true; };
  }, [ready, sites, alerts, onSelect, selectedId]);

  useEffect(() => {
    const instance = map.current;
    if (!styleLoaded || !instance) return;
    const data = stormCellsGeoJson(cells, nowMs, cellsUnconfirmed, demo);
    const source = instance.getSource<GeoJSONSource>(CELLS_SOURCE);
    if (source) { void source.setData(data); return; }
    const tokens = getComputedStyle(document.documentElement);
    const amber = tokens.getPropertyValue("--pc-risk-amber").trim();
    const muted = tokens.getPropertyValue("--pc-text-muted").trim();
    instance.addSource(CELLS_SOURCE, { type: "geojson", data });
    const before = instance.getLayer(LIGHTNING_SOURCE) ? LIGHTNING_SOURCE : undefined;
    instance.addLayer({
      id: `${CELLS_SOURCE}-fill`, type: "fill", source: CELLS_SOURCE,
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: {
        "fill-color": ["case", ["get", "uncertain"], tokens.getPropertyValue("--pc-border").trim(), tokens.getPropertyValue("--pc-risk-amber-bg").trim()],
        "fill-opacity": 0.35,
      },
    }, before);
    instance.addLayer({
      id: `${CELLS_SOURCE}-outline`, type: "line", source: CELLS_SOURCE,
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "line-color": ["case", ["get", "uncertain"], muted, amber], "line-width": 2, "line-dasharray": [3, 2] },
    }, before);
    instance.addLayer({
      id: `${CELLS_SOURCE}-arrows`, type: "line", source: CELLS_SOURCE,
      filter: ["==", ["geometry-type"], "LineString"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["case", ["get", "uncertain"], muted, amber], "line-width": 3 },
    }, before);
  }, [styleLoaded, cells, cellsUnconfirmed, demo, nowMs]);

  // Recent lightning: a GeoJSON circle layer under the site markers (markers are DOM, always on top).
  useEffect(() => {
    const instance = map.current;
    if (!styleLoaded || !instance) return;
    const data = lightningGeoJson(flashes, flashNowMs);
    const source = instance.getSource<GeoJSONSource>(LIGHTNING_SOURCE);
    if (source) {
      void source.setData(data);
      return;
    }
    // Paint needs real colors, so read them from the tokens.css variables.
    const tokens = getComputedStyle(document.documentElement);
    instance.addSource(LIGHTNING_SOURCE, { type: "geojson", data });
    instance.addLayer({
      id: LIGHTNING_SOURCE,
      type: "circle",
      source: LIGHTNING_SOURCE,
      paint: {
        "circle-color": tokens.getPropertyValue("--pc-lightning").trim(),
        "circle-stroke-color": tokens.getPropertyValue("--pc-lightning-ring").trim(),
        "circle-stroke-width": 0.5,
        "circle-radius": ["get", "radius"],
        "circle-opacity": ["get", "opacity"],
        // A faint ring keeps dots visible on the light basemap without muddying dense clusters.
        "circle-stroke-opacity": ["*", 0.5, ["get", "opacity"]],
      },
    });
  }, [styleLoaded, flashes, flashNowMs]);

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
    {error && <p role="status" className="absolute top-3 left-3 max-w-64 rounded-card border border-border bg-surface p-3 text-sm text-muted">Map tiles unavailable. Site details remain available in the ranked list.</p>}</>;
}
