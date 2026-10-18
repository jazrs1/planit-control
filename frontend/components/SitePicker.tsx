"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Site } from "@shared/types";
import { rememberSite } from "@/lib/crew";
import { nearestSite, siteMatches } from "@/lib/siteFinder";

// Pick a site by typing part of its name or county, or by "Use my location", which finds the nearest
// plant on this device. The position never leaves the phone: no request carries it.
// One picker for every site choice: the crew view (CrewSitePicker), the report form, and the sites to
// follow in notification settings (multiple: each pick adds or removes a site).

const MAX_OPTIONS = 8;
/** The "no site" option's value in the list. */
const NONE = "";

type Located = { tone: "ok" | "error" | "busy"; text: string };

type Common = {
  sites: Site[] | null;
  label: string;
  /** Visible label (default) or screen-reader only, when the surrounding form already says it. */
  labelHidden?: boolean;
  disabled?: boolean;
  /** The crew view's big input, or a form field's size. */
  size?: "large" | "field";
  /** Show "Use my location" (on by default). */
  locate?: boolean;
  /** Remember the chosen site on this device as the crew site (lib/crew.ts). */
  remember?: boolean;
  /** A short line under the input, beside "Use my location" (the crew view's county and time zone). */
  hint?: string | null;
};

type Single = Common & {
  multiple?: false;
  selectedId: string | null;
  onSelect: (siteId: string | null) => void;
  /** A first option meaning "no site" ("Away from a site / unknown"), chosen with null. */
  noneLabel?: string;
};

type Multiple = Common & {
  multiple: true;
  /** Sites already chosen: picking one again removes it. */
  chosen: string[];
  onToggle: (siteId: string) => void;
};

export type SitePickerProps = Single | Multiple;

export default function SitePicker(props: SitePickerProps) {
  const { sites, label, labelHidden = false, disabled = false, size = "field", locate: showLocate = true, remember = false, hint = null } = props;
  const id = useId();
  const listId = `${id}-list`;
  const sorted = useMemo(() => [...(sites ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [sites]);
  const selected = props.multiple ? null : sorted.find((site) => site.id === props.selectedId) ?? null;
  const noneLabel = props.multiple ? undefined : props.noneLabel;
  const [query, setQuery] = useState<string | null>(null); // null: not typing, the input shows the choice
  const [active, setActive] = useState(0);
  const [located, setLocated] = useState<Located | null>(null);
  const request = useRef(0);
  useEffect(() => () => { request.current++; }, []);

  const typing = query !== null;
  // The "no site" option leads the list while typing, like the first entry of a dropdown.
  const options: (Site | null)[] = typing
    ? [...(noneLabel !== undefined ? [null] : []), ...sorted.filter((site) => siteMatches(site, query)).slice(0, MAX_OPTIONS)]
    : [];
  const open = typing && (query.trim() !== "" || noneLabel !== undefined);
  const matchCount = options.filter(Boolean).length;
  const isChosen = (site: Site) => props.multiple && props.chosen.includes(site.id);

  function choose(site: Site | null) {
    if (props.multiple) {
      if (site) props.onToggle(site.id);
      setQuery("");
    } else {
      if (site && remember) rememberSite(site.id);
      props.onSelect(site?.id ?? null);
      setQuery(null);
    }
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
      // Multiple: add the nearest site, never remove it.
      if (props.multiple) { if (!props.chosen.includes(nearest.site.id)) props.onToggle(nearest.site.id); }
      else choose(nearest.site);
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

  const shown = typing ? query : props.multiple ? "" : selected?.name ?? (noneLabel !== undefined && props.selectedId === null && sites !== null ? noneLabel : "");
  const input = size === "large"
    ? "min-h-14 rounded-card border-2 border-border-strong px-3 text-xl font-semibold"
    : "min-h-12 rounded-card border border-border-strong px-3.5 py-2 text-base";
  const optionId = (site: Site | null) => `${id}-opt-${site?.id ?? NONE}`;

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={`${id}-input`} className={labelHidden ? "sr-only" : "text-xs text-muted"}>{label}</label>
      <div className="relative">
        <input
          id={`${id}-input`}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && options[active] !== undefined ? optionId(options[active]) : undefined}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled || sorted.length === 0}
          placeholder={sites === null ? "Sites unavailable" : props.multiple ? "Add a site: type a plant or county" : "Type a plant or county"}
          value={shown}
          // With a "no site" option the list opens like a dropdown: on focus, and on a tap once focused.
          onFocus={(event) => { if (noneLabel !== undefined) { setQuery(""); setActive(0); } else event.currentTarget.select(); }}
          onClick={() => { if (!typing && noneLabel !== undefined) { setQuery(""); setActive(0); } }}
          // Typing highlights the first matching site, not "no site", so Enter picks what was typed.
          onChange={(event) => { setQuery(event.target.value); setActive(noneLabel !== undefined && event.target.value.trim() !== "" ? 1 : 0); }}
          onBlur={() => setQuery(null)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" && !typing) { event.preventDefault(); setQuery(""); setActive(0); }
            else if (event.key === "ArrowDown" && open) { event.preventDefault(); setActive((i) => Math.min(options.length - 1, i + 1)); }
            else if (event.key === "ArrowUp" && open) { event.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
            else if (event.key === "Enter" && open && options[active] !== undefined) { event.preventDefault(); choose(options[active]); }
            else if (event.key === "Escape" && typing) { event.preventDefault(); setQuery(null); }
          }}
          className={`w-full min-w-0 bg-surface text-text placeholder:font-normal placeholder:text-muted focus-visible:outline-2 focus-visible:outline-notice disabled:opacity-60 ${input}`}
        />
        {open && (
          <ul id={listId} role="listbox" aria-label="Matching sites" aria-multiselectable={props.multiple || undefined} className="absolute inset-x-0 top-full z-20 mbs-1 max-h-80 overflow-y-auto rounded-card bg-surface p-1 shadow-float">
            {options.map((site, index) => (
              <li
                key={site?.id ?? NONE} id={optionId(site)} role="option" aria-selected={index === active}
                aria-checked={props.multiple && site ? isChosen(site) : undefined}
                // mousedown, not click: the input's blur would close the list first.
                onMouseDown={(event) => { event.preventDefault(); choose(site); }}
                onMouseMove={() => setActive(index)}
                className={`flex min-h-12 cursor-pointer items-center justify-between gap-3 rounded-[6px] px-3 py-1.5 ${index === active ? "bg-surface-2" : ""}`}
              >
                {site ? (
                  <span className="flex min-w-0 flex-col">
                    <span className="font-semibold">{site.name}</span>
                    <span className="text-xs text-muted">{site.county} County</span>
                  </span>
                ) : <span className="text-muted">{noneLabel}</span>}
                {site && isChosen(site) && <span className="shrink-0 text-xs font-semibold text-muted">Following · tap to remove</span>}
              </li>
            ))}
            {query?.trim() && matchCount === 0 && <li role="option" aria-selected={false} aria-disabled="true" className="px-3 py-3 text-muted">No sites match</li>}
          </ul>
        )}
      </div>
      {(showLocate || hint) && (
        <div className="flex flex-wrap items-center justify-between gap-x-4">
          {hint ? <p className="text-xs text-muted">{hint}</p> : <span />}
          {showLocate && 
          <button type="button" onClick={locate} disabled={disabled || sorted.length === 0 || located?.tone === "busy"} className="pc-link text-xs disabled:opacity-50">
            <svg viewBox="0 0 20 20" aria-hidden="true" className="size-4"><circle cx="10" cy="10" r="3" fill="currentColor" /><circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M10 1.5v3M10 15.5v3M1.5 10h3M15.5 10h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
            {props.multiple ? "Add my nearest site" : "Use my location"}
          </button>}
        </div>
      )}
      <p role="status" className={located ? `text-xs ${located.tone === "error" ? "font-semibold text-text" : "text-muted"}` : "sr-only"}>{located?.text ?? ""}</p>
    </div>
  );
}
