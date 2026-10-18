"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { CreateReportRequest, HazardReport, ReporterRole, Site, UploadResponse } from "@shared/types";
import { createReport, uploadPhoto, validatePhoto } from "@/lib/api";
import { REPORT_OPTIONS, ROLE_LABEL } from "@/lib/reports";
import ReportMap from "@/components/ReportMap";
import ReportPhoto from "@/components/ReportPhoto";
import SitePicker from "@/components/SitePicker";

const NO_REPORTS: HazardReport[] = [];
const fieldClass = "mbs-1.5 block min-h-12 w-full rounded-card border border-border-strong bg-surface px-3.5 py-2 text-base text-text focus-visible:outline-2 focus-visible:outline-notice";
/** Field labels: small and grey; the value is what's large. */
const labelClass = "block text-xs text-muted";
const stepClass = "pc-panel flex flex-col gap-4 p-6 max-sm:p-5";

export default function ReportForm({ sites, initialSiteId = "" }: { sites: Site[] | null; initialSiteId?: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [photoError, setPhotoError] = useState("");
  const [category, setCategory] = useState("");
  const [note, setNote] = useState("");
  const [role, setRole] = useState<ReporterRole>("crew_member");
  const [siteId, setSiteId] = useState(initialSiteId);
  const validSiteId = sites?.some((site) => site.id === siteId) ? siteId : "";
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
      setLocationMessage("This browser can't share your location. Tap the map or enter coordinates to place your pin.");
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
      setLocationMessage("Couldn't get your location. Tap the map or enter coordinates to place your pin.");
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
        site_id: validSiteId || null,
        photo_url: photo.photo_url,
        category: selected.category,
        note: note.trim(),
        species: "species" in selected ? selected.species : null,
        lat: pin.lat,
        lon: pin.lon,
        reporter_role: role,
      };
      const report = await createReport(body, controller.signal);
      if (!controller.signal.aborted) setSubmitted(report);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Couldn't submit the report. Try again.");
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setPhase("idle");
    }
  }

  if (submitted) return (
    <section className="flex flex-col gap-6">
      <div role="status" className="pc-panel flex items-start gap-3 p-6 max-sm:p-5">
        <span aria-hidden="true" className="pc-shape pc-shape--green mbs-2" />
        <div><h2 ref={confirmation} tabIndex={-1} className="text-xl font-semibold">Report submitted</h2>
        <p className="text-muted">Your hazard report has been saved. Its location is pinned below.</p></div>
      </div>
      <ReportMap reports={[submitted]} selectedId={submitted.id} />
      <ReportPhoto key={submitted.photo_url} src={submitted.photo_url} alt="Submitted hazard" className="h-48 w-full" />
      {submitted.note && <p className="max-w-[68ch] break-words whitespace-pre-wrap">{submitted.note}</p>}
      <div className="flex flex-wrap items-center gap-6">
        <Link href="/reports" className="pc-btn pc-btn--primary">View reports</Link>
        <button type="button" onClick={() => {
          setSubmitted(null); setFile(null); setCategory(""); setNote(""); uploaded.current = null; setProgress(0);
        }} className="pc-link">Report another hazard</button>
      </div>
    </section>
  );

  return (
    <form onSubmit={submit} className="flex flex-col gap-6" aria-busy={busy}>
      <fieldset disabled={busy} className="flex min-w-0 flex-col gap-6 disabled:opacity-70">
        <legend className="sr-only">Hazard details</legend>
        <div className={stepClass}>
          <label htmlFor="photo"><span className="block text-xs text-muted">Step 1 of 3</span><span className="block text-xl font-semibold">Take or choose a photo</span></label>
          <div className="flex flex-col gap-2 rounded-card border-[1.5px] border-dashed border-border-strong p-6 max-sm:p-4">
          <input id="photo" type="file" accept="image/*" required aria-describedby="photo-help photo-error" aria-invalid={!!photoError} className="block min-h-11 w-full min-w-0 text-sm text-muted file:me-3 file:min-h-11 file:cursor-pointer file:rounded-card file:border file:border-border-strong file:bg-surface file:px-4 file:font-semibold file:text-text" onChange={(event) => {
            const next = event.target.files?.[0] ?? null;
            const invalid = next ? validatePhoto(next) : "";
            setPhotoError(invalid || ""); setFile(invalid ? null : next); uploaded.current = null; setError("");
            if (invalid) event.currentTarget.value = "";
          }} />
          <p id="photo-help" className="text-xs text-muted">JPEG, PNG, WebP, or HEIC. Up to 10 MB.</p>
          <p id="photo-error" role="alert" className="font-semibold text-risk-red">{photoError}</p>
          </div>
          {preview && <ReportPhoto key={preview} src={preview} alt="Selected hazard photo" className="h-48 w-full" />}
        </div>

        <div className={stepClass}>
          <p><span className="block text-xs text-muted">Step 2 of 3</span><span className="block text-xl font-semibold">What did you see?</span></p>
          <label className={labelClass} htmlFor="category">Hazard
            <select id="category" required value={category} onChange={(event) => setCategory(event.target.value)} className={fieldClass}>
              <option value="">Choose a hazard</option>
              {REPORT_OPTIONS.map((option) => <option key={option.label} value={option.label}>{option.label}</option>)}
            </select>
          </label>
          <label htmlFor="note" className={labelClass}>Note (optional)
            <textarea id="note" rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="What should the next crew know?" className={fieldClass} />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label htmlFor="role" className={labelClass}>Your role
              <select id="role" value={role} onChange={(event) => setRole(event.target.value as ReporterRole)} className={fieldClass}>
                {Object.entries(ROLE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            {/* The shared site picker: type a plant or county, or use the nearest one. "No site" stays first. */}
            <div>
              <SitePicker sites={sites} selectedId={validSiteId || null} onSelect={(id) => setSiteId(id ?? "")} disabled={sites === null}
                label="Site (optional)" noneLabel="Away from a site / unknown" />
              {sites === null && <span role="status" className="mbs-2 block text-sm text-muted">Couldn&apos;t load sites; retrying. You can still submit with a map pin and no site.</span>}
            </div>
          </div>
        </div>

        <section aria-labelledby="location-heading" className={stepClass}>
          <h2 id="location-heading"><span className="block text-xs text-muted">Step 3 of 3</span><span className="block text-xl font-semibold">Pin the hazard location</span></h2>
          <p className="max-w-[68ch] text-muted">Tap the map where you saw the hazard. Adjust the pin if it is away from your current location.</p>
          <div className="flex flex-wrap items-center gap-x-4">
            <button type="button" disabled={locating} onClick={() => locate()} className="pc-link disabled:opacity-50">{locating ? "Finding location…" : "Use my location"}</button>
            <p role="status" className="text-xs text-muted">{locationMessage}</p>
          </div>
          <ReportMap reports={NO_REPORTS} pin={pin} onPin={busy ? undefined : choosePin} />
          <p className="text-xs text-muted">{pin ? `Pin: ${pin.lat.toFixed(6)}, ${pin.lon.toFixed(6)}` : "No pin selected yet."}</p>
          <details className="group">
            <summary className="pc-link list-none">Enter coordinates manually</summary>
            <div className="grid grid-cols-2 gap-4 pbs-2">
              <label htmlFor="latitude" className={labelClass}>Latitude<input id="latitude" inputMode="decimal" value={coordinates.lat} onChange={(event) => setCoordinates({ ...coordinates, lat: event.target.value })} className={fieldClass} /></label>
              <label htmlFor="longitude" className={labelClass}>Longitude<input id="longitude" inputMode="decimal" value={coordinates.lon} onChange={(event) => setCoordinates({ ...coordinates, lon: event.target.value })} className={fieldClass} /></label>
            </div>
            <button type="button" className="pc-btn pc-btn--quiet mbs-4" onClick={() => {
              const lat = Number(coordinates.lat), lon = Number(coordinates.lon);
              if (!coordinates.lat.trim() || !coordinates.lon.trim() || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
                setLocationMessage("Enter latitude from -90 to 90 and longitude from -180 to 180."); return;
              }
              choosePin({ lat, lon });
            }}>Set coordinates</button>
          </details>
        </section>
      </fieldset>
      {busy && <div role="status" className="pc-panel p-6 max-sm:p-5">
        <p className="font-semibold">{phase === "uploading" ? `Uploading photo… ${progress}%` : "Photo uploaded. Saving report…"}</p>
        <progress max={100} value={phase === "saving" ? 100 : progress} aria-label="Photo upload progress" className="mbs-2 h-3 w-full accent-brand" />
      </div>}
      {error && <div role="alert" className="rounded-card bg-risk-red-bg px-6 py-4 text-risk-red"><p>{error}</p><Link href="/reports" className="pc-link text-risk-red">Check reports</Link></div>}
      <button type="submit" disabled={busy} className="pc-btn pc-btn--primary min-h-14 w-full text-sm">{busy ? "Submitting…" : "Submit hazard report"}</button>
    </form>
  );
}
