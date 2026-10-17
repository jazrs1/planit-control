"use client";

import { useEffect, useRef, useState } from "react";
import type { CreateReportRequest, HazardReport } from "@shared/types";
import type { Map as LibreMap, Marker } from "maplibre-gl";
import { REPORT_LABEL } from "@/lib/reports";
import { paintBasemap } from "@/lib/mapStyle";

type ReportMapProps = {
  /** Shown over the map when there's nothing to pin (e.g. "No reports yet"). */
  emptyText?: string;
  reports: HazardReport[];
  pin?: Pick<CreateReportRequest, "lat" | "lon"> | null;
  onPin?: (pin: Pick<CreateReportRequest, "lat" | "lon">) => void;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
};

export default function ReportMap({ reports, pin, onPin, selectedId, onSelect, emptyText }: ReportMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<LibreMap | null>(null);
  const markers = useRef<Marker[]>([]);
  const callbacks = useRef({ onPin, onSelect });
  const fitted = useRef(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => { callbacks.current = { onPin, onSelect }; }, [onPin, onSelect]);

  useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | undefined;
    void import("maplibre-gl").then((lib) => {
      if (disposed || !container.current) return;
      // Same worker URL and basemap as the dashboard.
      lib.setWorkerUrl(new URL("maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url).href);
      const instance = new lib.Map({ container: container.current, style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json", center: [-83.5, 28.2], zoom: 5.5, attributionControl: { compact: false } });
      instance.on("style.load", () => paintBasemap(instance));
      map.current = instance;
      instance.addControl(new lib.NavigationControl(), "top-right");
      instance.on("click", (event) => callbacks.current.onPin?.({ lat: event.lngLat.lat, lon: event.lngLat.wrap().lng }));
      instance.on("error", () => { if (!disposed) setError(true); });
      instance.on("load", () => { if (!disposed) setLoaded(true); });
      instance.on("load", () => { if (!disposed) setError(false); });
      observer = new ResizeObserver(() => instance.resize());
      observer.observe(container.current);
      setReady(true);
    }).catch(() => { if (!disposed) setError(true); });
    return () => {
      disposed = true;
      observer?.disconnect();
      markers.current.forEach((marker) => marker.remove());
      markers.current = [];
      map.current?.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    let disposed = false;
    void import("maplibre-gl").then(({ Marker, LngLatBounds }) => {
      if (disposed || !map.current) return;
      markers.current.forEach((marker) => marker.remove());
      markers.current = [];
      const bounds = new LngLatBounds();
      for (const report of reports) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "report-marker";
        button.textContent = "!";
        button.setAttribute("aria-label", `${REPORT_LABEL[report.category]}: ${report.note || "Crew hazard report"}`);
        button.setAttribute("aria-pressed", String(report.id === selectedId));
        button.addEventListener("click", (event) => { event.stopPropagation(); callbacks.current.onSelect?.(report.id); });
        markers.current.push(new Marker({ element: button }).setLngLat([report.lon, report.lat]).addTo(map.current));
        bounds.extend([report.lon, report.lat]);
      }
      if (pin) {
        const element = document.createElement("div");
        element.className = "report-marker report-marker--draft";
        element.textContent = "+";
        element.setAttribute("role", "img");
        element.setAttribute("aria-label", "Your hazard location");
        markers.current.push(new Marker({ element }).setLngLat([pin.lon, pin.lat]).addTo(map.current));
      }
      if (!fitted.current && reports.length) {
        map.current.fitBounds(bounds, { padding: 60, maxZoom: 14, duration: 0 });
        fitted.current = true;
      }
    });
    return () => { disposed = true; };
  }, [ready, reports, pin, selectedId]);

  useEffect(() => {
    const location = pin ?? reports.find((report) => report.id === selectedId);
    if (ready && location) map.current?.easeTo({ center: [location.lon, location.lat], zoom: Math.max(map.current.getZoom(), 14), duration: 0 });
  }, [ready, pin, selectedId, reports]);

  return (
    <div className="relative">
      <div ref={container} role="region" aria-label={onPin ? "Tap the map to choose the hazard location" : "Crew hazard reports map"} className="h-80 w-full overflow-hidden rounded-card shadow-card sm:h-96" />
      {!loaded && !error && <p role="status" className="pointer-events-none absolute inset-x-0 inset-bs-0 grid h-80 place-items-center text-sm text-muted sm:h-96">Loading map…</p>}
      {loaded && emptyText && <p className="pointer-events-none absolute inset-x-0 inset-bs-0 grid h-80 place-items-center sm:h-96"><span className="pc-float px-3 py-2 text-sm font-semibold text-muted">{emptyText}</span></p>}
      {error && <p role="status" className="absolute inset-bs-3 inset-s-3 max-w-64 rounded-card bg-surface px-4 py-3 text-xs text-muted shadow-card">Map tiles unavailable. {onPin ? "Use your location or enter coordinates below." : "Report details are still available in the list."}</p>}
      {onPin && <button type="button" disabled={!ready} onClick={() => {
        const center = map.current?.getCenter().wrap();
        if (center) onPin({ lat: center.lat, lon: center.lng });
      }} className="pc-link mbs-2 text-xs disabled:opacity-50">Use map center as pin</button>}
    </div>
  );
}
