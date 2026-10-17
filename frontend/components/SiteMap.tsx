"use client";

import { useEffect, useRef, useState } from "react";
import type { Alert, Site } from "@shared/types";
import type { Map as LibreMap, Marker } from "maplibre-gl";
import { riskLevel } from "@/lib/risk";

export default function SiteMap({ sites, alerts, selectedId, onSelect }: { sites: Site[]; alerts: Alert[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<LibreMap | null>(null);
  const markers = useRef(new Map<string, Marker>());
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | undefined;
    void import("maplibre-gl").then((lib) => {
      if (disposed || !container.current) return;
      const instance = new lib.Map({ container: container.current, style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json", center: [-83.5, 28.2], zoom: 5.5, attributionControl: { compact: false } });
      map.current = instance;
      instance.addControl(new lib.NavigationControl(), "top-right");
      instance.on("error", () => setError(true));
      instance.on("load", () => setError(false));
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
      // RECENT-LIGHTNING LAYER INTEGRATION POINT:
      // When shared/types.ts exports LightningFlash and GET /lightning/recent is
      // available, add its typed helper in lib/api.ts. Pass flashes here and draw
      // small yellow circles using a tokens.css color, with opacity fading by age.
    });
    return () => { disposed = true; };
  }, [ready, sites, alerts, onSelect, selectedId]);

  useEffect(() => {
    if (!ready || !selectedId) return;
    const site = sites.find((s) => s.id === selectedId);
    if (site) map.current?.easeTo({ center: [site.lon, site.lat], duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 500 });
  }, [ready, selectedId, sites]);

  return <><div ref={container} className="h-full w-full" />{error && <p role="status" className="absolute top-3 left-3 max-w-64 rounded-card border border-border bg-surface p-3 text-sm text-muted">Map tiles unavailable. Site details remain available in the ranked list.</p>}</>;
}
