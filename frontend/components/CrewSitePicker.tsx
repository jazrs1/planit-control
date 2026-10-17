"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Site } from "@shared/types";
import { rememberSite } from "@/lib/crew";
import { nearestSite, siteMatches } from "@/lib/siteFinder";
import { timeZoneName } from "@/lib/time";

// Crew view: pick your site by typing part of its name or county, or by "Use my location", which finds
// the nearest plant on this device. The position never leaves the phone: no request carries it.
// The choice is remembered on the device (lib/crew.ts).

type CrewSitePickerProps = {
  sites: Site[] | null;
  selectedId: string | null;
  onSelect: (siteId: string) => void;
  disabled?: boolean;
};

const MAX_OPTIONS = 8;

type Located = { tone: "ok" | "error" | "busy"; text: string };

export default function CrewSitePicker({ sites, selectedId, onSelect, disabled = false }: CrewSitePickerProps) {
  const id = useId();
  const listId = `${id}-list`;
  const input = useRef<HTMLInputElement>(null);
  const sorted = useMemo(() => [...(sites ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [sites]);
  const selected = sorted.find((site) => site.id === selectedId) ?? null;
  const [query, setQuery] = useState<string | null>(null); // null: not typing, the input shows the site
  const [active, setActive] = useState(0);
  const [located, setLocated] = useState<Located | null>(null);
  const request = useRef(0);
  useEffect(() => () => { request.current++; }, []);

  const typing = query !== null;
  const matches = typing ? sorted.filter((site) => siteMatches(site, query)).slice(0, MAX_OPTIONS) : [];
  const open = typing && query.trim() !== "";

  function choose(site: Site) {
    rememberSite(site.id);
    onSelect(site.id);
    setQuery(null);
    setActive(0);
  }

  function locate() {
    if (!("geolocation" in navigator)) {
      setLocated({ tone: "error", text: "This browser can't share your location. Type your site's name instead." });
      return;
    }
    const sequence = ++request.current;
    setLocated({ tone: "busy", text: "Finding your location…" });
    navigator.geolocation.getCurrentPosition((position) => {
      if (sequence !== request.current) return;
      // Computed here, on the device: the position is never sent anywhere.
      const nearest = nearestSite(sorted, position.coords.latitude, position.coords.longitude);
      if (!nearest) {
        setLocated({ tone: "error", text: "No sites are loaded yet. Try again in a moment." });
        return;
      }
      choose(nearest.site);
      const mi = nearest.distanceMi < 10 ? nearest.distanceMi.toFixed(1) : String(Math.round(nearest.distanceMi));
      setLocated({ tone: "ok", text: `Nearest site: ${nearest.site.name}, ${mi} mi away.` });
    }, (error) => {
      if (sequence !== request.current) return;
      setLocated({
        tone: "error",
        text: error.code === error.PERMISSION_DENIED
          ? "Location access is off for this app. Type your site's name instead, or turn location on in your browser settings."
          : error.code === error.TIMEOUT
            ? "Finding your location took too long. Try again outdoors, or type your site's name."
            : "Your location isn't available right now. Type your site's name instead.",
      });
    }, { enableHighAccuracy: false, timeout: 15_000, maximumAge: 5 * 60_000 });
  }

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={`${id}-input`} className="text-xs text-muted">Your site</label>
      <div className="relative">
        <input
          ref={input}
          id={`${id}-input`}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && matches[active] ? `${id}-opt-${matches[active].id}` : undefined}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled || sorted.length === 0}
          placeholder={sites === null ? "Sites unavailable" : "Type a plant or county"}
          value={typing ? query : selected?.name ?? ""}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => { setQuery(event.target.value); setActive(0); }}
          onBlur={() => setQuery(null)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" && open) { event.preventDefault(); setActive((i) => Math.min(matches.length - 1, i + 1)); }
            else if (event.key === "ArrowUp" && open) { event.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
            else if (event.key === "Enter" && open && matches[active]) { event.preventDefault(); choose(matches[active]); }
            else if (event.key === "Escape" && typing) { event.preventDefault(); setQuery(null); }
          }}
          className="min-h-14 w-full min-w-0 rounded-card border-2 border-border-strong bg-surface px-3 text-xl font-semibold text-text placeholder:font-normal placeholder:text-muted focus-visible:outline-2 focus-visible:outline-notice disabled:opacity-60"
        />
        {open && (
          <ul id={listId} role="listbox" aria-label="Matching sites" className="absolute inset-x-0 top-full z-20 mbs-1 max-h-80 overflow-y-auto rounded-card bg-surface p-1 shadow-float">
            {matches.length === 0
              ? <li role="option" aria-selected={false} aria-disabled="true" className="px-3 py-3 text-muted">No sites match</li>
              : matches.map((site, index) => (
                <li
                  key={site.id} id={`${id}-opt-${site.id}`} role="option" aria-selected={index === active}
                  // mousedown, not click: the input's blur would close the list first.
                  onMouseDown={(event) => { event.preventDefault(); choose(site); }}
                  onMouseMove={() => setActive(index)}
                  className={`flex min-h-12 cursor-pointer flex-col justify-center rounded-[6px] px-3 py-1.5 ${index === active ? "bg-surface-2" : ""}`}
                >
                  <span className="font-semibold">{site.name}</span>
                  <span className="text-xs text-muted">{site.county} County</span>
                </li>
              ))}
          </ul>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4">
        {selected ? <p className="text-xs text-muted">{selected.county} County · {timeZoneName(selected.timezone)}</p> : <span />}
        <button type="button" onClick={locate} disabled={disabled || sorted.length === 0 || located?.tone === "busy"} className="pc-link text-xs disabled:opacity-50">
          <svg viewBox="0 0 20 20" aria-hidden="true" className="size-4"><circle cx="10" cy="10" r="3" fill="currentColor" /><circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M10 1.5v3M10 15.5v3M1.5 10h3M15.5 10h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          Use my location
        </button>
      </div>
      <p role="status" className={located ? `text-xs ${located.tone === "error" ? "font-semibold text-text" : "text-muted"}` : "sr-only"}>{located?.text ?? ""}</p>
    </div>
  );
}
