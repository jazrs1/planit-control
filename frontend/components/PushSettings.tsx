"use client";

import { useEffect, useId, useState } from "react";
import type { PushRole, Site } from "@shared/types";
import { useAlertsState } from "@/components/AlertsProvider";
import { useDevicePush } from "@/components/PushProvider";
import SitePicker from "@/components/SitePicker";

export default function PushSettings({ sites, defaultSiteId, defaultRole = "supervisor", compact = false, sitesUnconfirmed = false }: { sites: Site[] | null; defaultSiteId?: Site["id"]; defaultRole?: PushRole; compact?: boolean; sitesUnconfirmed?: boolean }) {
  const push = useDevicePush();
  const { connection } = useAlertsState();
  const id = useId();
  const [role, setRole] = useState<PushRole>(defaultRole);
  const [all, setAll] = useState(!defaultSiteId);
  const [chosen, setChosen] = useState<string[]>(defaultSiteId ? [defaultSiteId] : []);
  useEffect(() => {
    setRole(push.restored ? push.preferences.role : defaultRole);
    setAll(push.restored ? push.preferences.site_ids === null : !defaultSiteId);
    setChosen(push.restored ? push.preferences.site_ids ?? [] : defaultSiteId ? [defaultSiteId] : []);
  }, [push.preferences, push.restored, defaultRole, defaultSiteId]);
  const demo = push.phase === "demo";
  const disabled = push.busy || demo || push.phase === "unsupported";
  const valid = all || chosen.length > 0;
  const choices = [...(sites ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const missing = chosen.filter(site_id => !sites?.some(site => site.id === site_id));
  const control = "min-h-12 rounded-card border border-border px-3 font-semibold text-brand focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50";

  return <section aria-labelledby={`${id}-title`} className={`space-y-3 rounded-card bg-surface p-4 ${"border border-border"}`}>
    <h2 id={`${id}-title`} className="text-lg font-bold text-brand">Get alerts on this device</h2>
    <p className="text-sm text-muted">Stop-work, approaching lightning, flood alerts and evening briefings for your sites. The role is saved for your device; both roles currently receive the same events.</p>
    {push.iphoneHint && <p className={`rounded-card bg-bg p-3 text-sm font-semibold ${"border border-border"}`}>On iPhone Safari, use Share → Add to Home Screen, then open the installed app. Alerts require iOS 16.4 or later.</p>}
    <details open={!compact} className={`rounded-card bg-bg p-3 ${"border border-border"}`}>
      <summary className="cursor-pointer font-semibold text-brand">Sites and role: {all ? "All sites" : `${chosen.length} selected`}, {role === "crew" ? "crew" : "supervisor"}</summary>
      <fieldset disabled={disabled} className="mbs-3 space-y-3">
        <legend className="sr-only">Alert preferences</legend>
        <label htmlFor={`${id}-role`} className="block text-sm font-semibold">Your role
          <select id={`${id}-role`} value={role} onChange={event => setRole(event.target.value as PushRole)} className={`mbs-1 min-h-12 w-full rounded-card bg-surface px-3 text-text ${compact ? "border-2 border-rule" : "border border-border-strong"}`}>
            <option value="crew">Crew</option><option value="supervisor">Supervisor</option>
          </select>
        </label>
        <fieldset>
          <legend className="text-sm font-semibold">Sites to follow</legend>
          <label className="flex min-h-11 items-center gap-2"><input type="radio" name={`${id}-scope`} checked={all} onChange={() => setAll(true)} />All sites</label>
          <label className="flex min-h-11 items-center gap-2"><input type="radio" name={`${id}-scope`} checked={!all} onChange={() => setAll(false)} />Choose sites</label>
          {/* Choose sites with the shared search picker; the chosen ones are listed below it, each a checkbox to remove. */}
          {!all && <div className="mbs-2 flex flex-col gap-2">
            {sites !== null && sites.length > 0 && <SitePicker multiple sites={sites} chosen={chosen} label="Add a site to follow" labelHidden
              onToggle={site_id => setChosen(previous => previous.includes(site_id) ? previous.filter(value => value !== site_id) : [...previous, site_id])} />}
          </div>}
          {!all && (chosen.length > 0 || sites === null || sites?.length === 0) && <div className={`max-h-52 overflow-y-auto rounded-card bg-surface p-2 ${"border border-border"}`}>
            {choices.filter(site => chosen.includes(site.id)).map(site => <label key={site.id} className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={chosen.includes(site.id)} onChange={event => setChosen(previous => event.target.checked ? [...new Set([...previous, site.id])] : previous.filter(site_id => site_id !== site.id))} />{site.name}</label>)}
            {missing.map(site_id => <label key={site_id} className="flex min-h-11 items-center gap-2 text-sm text-muted"><input type="checkbox" checked onChange={() => setChosen(previous => previous.filter(value => value !== site_id))} />{site_id} · site name unavailable</label>)}
            {sites === null && <p className="p-2 text-sm text-muted">Site list unavailable. Retry loading sites or choose All sites.</p>}
            {sites?.length === 0 && <p className="p-2 text-sm text-muted">No sites available.</p>}
          </div>}
        </fieldset>
        {!valid && <p className="text-sm text-muted">Choose at least one site or select All sites.</p>}
        {sitesUnconfirmed && <p className="text-sm text-muted">Site list not confirmed. Showing last loaded names.</p>}
      </fieldset>
    </details>
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
      <button type="button" disabled={disabled || !valid} onClick={() => void push.enable({ site_ids: all ? null : chosen, role })} className={`${control} bg-brand text-on-brand`}>{push.busy ? "Please wait…" : push.phase === "registered" ? "Save alert preferences" : "Get alerts on this device"}</button>
      <button type="button" disabled={disabled || push.phase !== "registered"} onClick={() => void push.sendTest()} className="pc-link disabled:cursor-not-allowed disabled:opacity-50 disabled:no-underline">Send test notification</button>
      {push.canUnsubscribe && <button type="button" disabled={push.busy || demo} onClick={() => void push.unsubscribe()} className="pc-link disabled:cursor-not-allowed disabled:opacity-50">Unsubscribe</button>}
    </div>
    <p role="status" className="text-sm font-medium text-muted">{push.message}</p>
    {!demo && connection.level !== "online" && push.phase === "registered" && <p role="status" className="text-sm font-semibold text-muted">? Last confirmed registration. Server connection lost.</p>}
    <p className="text-sm text-muted"><strong className="font-semibold text-text">Notifications can be delayed, arrive out of order, or never arrive.</strong> No notification does not mean all clear. Check the app&apos;s current alerts and follow your site&apos;s safety procedures.</p>
  </section>;
}
