"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { CreateReportRequest, HazardReport, ReporterRole, Site, UploadResponse } from "@shared/types";
import { createReport, uploadPhoto, validatePhoto } from "@/lib/api";
import { REPORT_OPTIONS, ROLE_LABEL } from "@/lib/reports";
import ReportMap from "@/components/ReportMap";
import ReportPhoto from "@/components/ReportPhoto";

const NO_REPORTS: HazardReport[] = [];
const fieldClass = "mt-1 min-h-12 w-full rounded-card border border-border bg-surface px-3 py-2 text-base text-text focus-visible:outline-2 focus-visible:outline-brand";

export default function ReportForm({ sites }: { sites: Site[] | null }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [photoError, setPhotoError] = useState("");
  const [category, setCategory] = useState("");
  const [note, setNote] = useState("");
  const [role, setRole] = useState<ReporterRole>("crew_member");
  const [siteId, setSiteId] = useState("");
  const [pin, setPin] = useState<Pick<CreateReportRequest, "lat" | "lon"> | null>(null);
  const [coordinates, setCoordinates] = useState({ lat: "", lon: "" });
  const [locationMessage, setLocationMessage] = useState("");
  const [locating, setLocating] = useState(false);
  const [phase, setPhase] = useState<"idle" | "uploading" | "saving">("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState<HazardReport | null>(null);
  const locationChosen = useRef(false);
  const locationRequest = useRef(0);
  const request = useRef<AbortController | null>(null);
  const uploaded = useRef<{ file: File; photo_url: UploadResponse["photo_url"] } | null>(null);
  const confirmation = useRef<HTMLHeadingElement>(null);
  const busy = phase !== "idle";

  const choosePin = useCallback((location: Pick<CreateReportRequest, "lat" | "lon">) => {
    locationChosen.current = true;
    setPin(location);
    setCoordinates({ lat: location.lat.toFixed(6), lon: location.lon.toFixed(6) });
    setLocationMessage("Pin set. Tap the map to adjust the hazard location.");
  }, []);

  const locate = useCallback((onlyIfEmpty = false) => {
    if (!navigator.geolocation) {
      setLocationMessage("Location is unavailable. Tap the map or enter coordinates to place your pin.");
      return;
    }
    const sequence = ++locationRequest.current;
    setLocating(true);
    setLocationMessage("Finding your location…");
    navigator.geolocation.getCurrentPosition((position) => {
      if (sequence !== locationRequest.current) return;
      setLocating(false);
      // A delayed location permission response must not move a manually placed pin.
      if (onlyIfEmpty && locationChosen.current) return;
      choosePin({ lat: position.coords.latitude, lon: position.coords.longitude });
    }, () => {
      if (sequence !== locationRequest.current) return;
      setLocating(false);
      setLocationMessage("Could not access your location. Tap the map or enter coordinates to place your pin.");
    }, { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 });
  }, [choosePin]);

  useEffect(() => {
    locate(true);
    return () => { locationRequest.current++; request.current?.abort(); };
  }, [locate]);

  useEffect(() => {
    if (!file) { setPreview(""); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => { if (submitted) confirmation.current?.focus(); }, [submitted]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request.current) return;
    setError("");
    const selected = REPORT_OPTIONS.find((option) => option.label === category);
    if (!file || !selected || !pin) {
      setError("Add a photo, choose a hazard category, and place a location pin before submitting.");
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    // Ignore an outstanding geolocation result once this submission starts.
    locationRequest.current++;
    setLocating(false);
    try {
      let photo = uploaded.current;
      if (!photo || photo.file !== file) {
        setPhase("uploading");
        const result = await uploadPhoto(file, setProgress, controller.signal);
        photo = { file, photo_url: result.photo_url };
        uploaded.current = photo;
      }
      setPhase("saving");
      const body: CreateReportRequest = {
        site_id: sites === null ? null : siteId || null,
        photo_url: photo.photo_url,
        category: selected.category,
        note: selected.category === "wildlife" ? `${selected.label}${note.trim() ? `: ${note.trim()}` : ""}` : note.trim(),
        lat: pin.lat,
        lon: pin.lon,
        reporter_role: role,
      };
      const report = await createReport(body, controller.signal);
      if (!controller.signal.aborted) setSubmitted(report);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not submit the report. Please try again.");
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setPhase("idle");
    }
  }

  if (submitted) return (
    <section className="space-y-4">
      <div role="status" className="rounded-card border border-border bg-risk-green-bg p-4 text-risk-green">
        <h2 ref={confirmation} tabIndex={-1} className="text-xl font-bold">Report submitted</h2>
        <p>Your hazard report has been saved. Its location is pinned below.</p>
      </div>
      <ReportMap reports={[submitted]} selectedId={submitted.id} />
      <ReportPhoto key={submitted.photo_url} src={submitted.photo_url} alt="Submitted hazard" className="h-48 w-full" />
      {submitted.note && <p className="break-words whitespace-pre-wrap">{submitted.note}</p>}
      <div className="flex flex-wrap gap-3">
        <Link href="/reports" className="flex min-h-12 items-center rounded-card bg-brand px-4 font-semibold text-surface">View reports</Link>
        <button type="button" onClick={() => {
          setSubmitted(null); setFile(null); setCategory(""); setNote(""); uploaded.current = null; setProgress(0);
        }} className="min-h-12 rounded-card border border-border bg-surface px-4 font-semibold text-brand">Report another hazard</button>
      </div>
    </section>
  );

  return (
    <form onSubmit={submit} className="space-y-5" aria-busy={busy}>
      <fieldset disabled={busy} className="min-w-0 space-y-5 disabled:opacity-70">
        <legend className="sr-only">Hazard details</legend>
        <div className="rounded-card border border-border bg-surface p-4 shadow-card">
          <label htmlFor="photo" className="block font-semibold">1. Take or choose a photo</label>
          <p id="photo-help" className="mt-1 text-sm text-muted">JPEG, PNG, WebP, or HEIC. Up to 10 MB.</p>
          <input id="photo" type="file" accept="image/*" capture="environment" required aria-describedby="photo-help photo-error" aria-invalid={!!photoError} className="mt-3 block min-h-12 w-full min-w-0 text-sm file:mr-3 file:min-h-12 file:rounded-card file:border-0 file:bg-brand file:px-3 file:font-semibold file:text-surface" onChange={(event) => {
            const next = event.target.files?.[0] ?? null;
            const invalid = next ? validatePhoto(next) : "";
            setPhotoError(invalid || ""); setFile(invalid ? null : next); uploaded.current = null; setError("");
            if (invalid) event.currentTarget.value = "";
          }} />
          <p id="photo-error" role="alert" className="mt-2 text-sm font-medium text-risk-red">{photoError}</p>
          {preview && <ReportPhoto key={preview} src={preview} alt="Selected hazard photo" className="mt-3 h-48 w-full" />}
        </div>

        <div className="space-y-4 rounded-card border border-border bg-surface p-4 shadow-card">
          <label className="block font-semibold" htmlFor="category">2. What did you see?
            <select id="category" required value={category} onChange={(event) => setCategory(event.target.value)} className={fieldClass}>
              <option value="">Choose a hazard</option>
              {REPORT_OPTIONS.map((option) => <option key={option.label} value={option.label}>{option.label}</option>)}
            </select>
          </label>
          <label htmlFor="note" className="block text-sm font-medium">Note (optional)
            <textarea id="note" rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="What should the next crew know?" className={fieldClass} />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label htmlFor="role" className="block text-sm font-medium">Your role
              <select id="role" value={role} onChange={(event) => setRole(event.target.value as ReporterRole)} className={fieldClass}>
                {Object.entries(ROLE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label htmlFor="site" className="block text-sm font-medium">Site (optional)
              <select id="site" disabled={sites === null} value={sites === null ? "" : siteId} onChange={(event) => setSiteId(event.target.value)} className={fieldClass}>
                <option value="">Away from a site / unknown</option>
                {/* Alphabetical: 55 plants in capacity order are hard to find on a phone. */}
                {sites && [...sites].sort((a, b) => a.name.localeCompare(b.name)).map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
              </select>
              {sites === null && <span role="status" className="mt-2 block text-sm text-muted">Site data unavailable. Retrying automatically. You can submit with a map pin and no associated site.</span>}
            </label>
          </div>
        </div>

        <section aria-labelledby="location-heading" className="space-y-3 rounded-card border border-border bg-surface p-4 shadow-card">
          <h2 id="location-heading" className="font-semibold">3. Pin the hazard location</h2>
          <p className="text-sm text-muted">Tap the map where you saw the hazard. Adjust the pin if it is away from your current location.</p>
          <button type="button" disabled={locating} onClick={() => locate()} className="min-h-12 rounded-card border border-border px-4 font-semibold text-brand disabled:opacity-50">{locating ? "Finding location…" : "Use my location"}</button>
          <p role="status" className="text-sm text-muted">{locationMessage}</p>
          <ReportMap reports={NO_REPORTS} pin={pin} onPin={busy ? undefined : choosePin} />
          <p className="text-sm text-muted">{pin ? `Pin: ${pin.lat.toFixed(6)}, ${pin.lon.toFixed(6)}` : "No pin selected yet."}</p>
          <details>
            <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium text-brand">Enter coordinates manually</summary>
            <div className="grid grid-cols-2 gap-3">
              <label htmlFor="latitude" className="text-sm">Latitude<input id="latitude" inputMode="decimal" value={coordinates.lat} onChange={(event) => setCoordinates({ ...coordinates, lat: event.target.value })} className={fieldClass} /></label>
              <label htmlFor="longitude" className="text-sm">Longitude<input id="longitude" inputMode="decimal" value={coordinates.lon} onChange={(event) => setCoordinates({ ...coordinates, lon: event.target.value })} className={fieldClass} /></label>
            </div>
            <button type="button" className="mt-2 min-h-11 rounded-card border border-border px-4 font-semibold text-brand" onClick={() => {
              const lat = Number(coordinates.lat), lon = Number(coordinates.lon);
              if (!coordinates.lat.trim() || !coordinates.lon.trim() || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
                setLocationMessage("Enter latitude from -90 to 90 and longitude from -180 to 180."); return;
              }
              choosePin({ lat, lon });
            }}>Set coordinates</button>
          </details>
        </section>
      </fieldset>
      {busy && <div role="status" className="rounded-card border border-border bg-surface p-4">
        <p className="font-medium">{phase === "uploading" ? `Uploading photo… ${progress}%` : "Photo uploaded. Saving report…"}</p>
        <progress max={100} value={phase === "saving" ? 100 : progress} aria-label="Photo upload progress" className="mt-2 h-3 w-full accent-brand" />
      </div>}
      {error && <div role="alert" className="rounded-card bg-risk-red-bg p-4 text-risk-red"><p>{error}</p><Link href="/reports" className="mt-2 inline-flex min-h-11 items-center font-semibold underline">Check reports</Link></div>}
      <button type="submit" disabled={busy} className="min-h-14 w-full rounded-card bg-brand px-4 text-lg font-semibold text-surface disabled:opacity-60">{busy ? "Submitting…" : "Submit hazard report"}</button>
    </form>
  );
}
