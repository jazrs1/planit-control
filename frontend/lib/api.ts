import type { Alert, ApiError, LightningRecentCounts, Briefing, BriefingsResponse, CreateReportRequest, FireDetection, HazardReport, ReplayEvent, ReplaySeries, WildlifeSightingPoint, LightningCellsResponse, LightningFlash, ModelInfo, PushEndpointRequest, PushPublicKey, PushSubscribeRequest, PushSubscriptionInfo, PushTestResponse, PushUnsubscribeResponse, ReplayStatus, ScoreHistory, SendBriefingRequest, SendBriefingResponse, Site, SiteDetail, StartReplayRequest, UploadResponse } from "@shared/types";
import mockAlerts from "@shared/mocks/alerts.json";
import mockBriefings from "@shared/mocks/briefings.json";
import mockLightning from "@shared/mocks/lightning_recent.json";
import mockLightningCells from "@shared/mocks/lightning_cells.json";
import mockSiteDetails from "@shared/mocks/site_details.json";
import mockSites from "@shared/mocks/sites.json";
import mockScoreHistory from "@shared/mocks/score_history.json";
import mockPushSubscription from "@shared/mocks/push_subscription.json";

import mockReports from "@shared/mocks/reports.json";
import mockFires from "@shared/mocks/fires_recent.json";
import mockWildlife from "@shared/mocks/wildlife_recent.json";
import { markFailure, markSuccess } from "@/lib/connection";
import { demoCodeHeaders } from "@/lib/demoCode";

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000").replace(/\/+$/, "");

/** The backend answered with an error status (as opposed to being unreachable). */
export class ApiRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** The backend is up but this data isn't ready yet (503 with Retry-After): retry later, quietly. It says
 *  nothing about the connection, so it never marks the app offline. */
export class NotReadyError extends Error {
  constructor(readonly retryAfterMs: number) {
    super("Not ready yet");
  }
}

/** Request the backend and throw if it's unreachable or returns an error. Never falls back to mocks:
 *  safety data the UI can't verify must show as unknown, not as sample values. */
async function request<T>(path: string, init?: RequestInit, { quietNotReady = false } = {}): Promise<T> {
  // Reads report failures to the shared connection state; a failed write (e.g. a 503 from a POST)
  // is the action's error, not proof the backend is down.
  const read = (init?.method ?? "GET") === "GET";
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { cache: "no-store", ...init });
  } catch (err) {
    if (read) markFailure();
    throw err;
  }
  if (quietNotReady && res.status === 503) {
    // Answered, so the server is reachable; the data is still being prepared.
    markSuccess();
    const seconds = Number(res.headers.get("retry-after"));
    throw new NotReadyError(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 5_000);
  }
  if (res.status < 500) markSuccess();
  else if (read) markFailure();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiError | null;
    throw new ApiRequestError(body?.detail ?? `${res.status} ${res.statusText}`, res.status);
  }
  return (await res.json()) as T;
}

/** For server components: null when the backend can't be reached, so the page renders an unknown state. */
export async function orNull<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch (err) {
    console.warn(`[api] ${(err as Error).message}`);
    return null;
  }
}

export const getReports = () => request<HazardReport[]>("/reports");
export const getSites = () => request<Site[]>("/sites");
export const getSiteDetail = (id: string) => request<SiteDetail>(`/sites/${encodeURIComponent(id)}`);
export const getScoreHistory = (id: Site["id"]) => request<ScoreHistory>(`/sites/${encodeURIComponent(id)}/score-history`, { signal: AbortSignal.timeout(15_000) });
export const getAlerts = () => request<Alert[]>("/alerts");
export const getLightningRecent = (minutes = 15) => request<LightningFlash[]>(`/lightning/recent?minutes=${minutes}`);
/** Uncapped real and replay flash counts for the same windows as /lightning/recent. A server without the
 *  endpoint answers 404, and the dashboard counts the flashes it has instead. */
export const getLightningCounts = (minutes = 15) => request<LightningRecentCounts>(`/lightning/recent/counts?minutes=${minutes}`);
export const getLightningCells = () => request<LightningCellsResponse>("/lightning/cells");
export const getPushPublicKey = () => request<PushPublicKey>("/push/public-key", { signal: AbortSignal.timeout(15_000) });
export const subscribePush = (body: PushSubscribeRequest) => request<PushSubscriptionInfo>("/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
export const unsubscribePush = (body: PushEndpointRequest) => request<PushUnsubscribeResponse>("/push/unsubscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
export const testPush = (body: PushEndpointRequest) => request<PushTestResponse>("/push/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
/** Evaluation artifacts, never demo data. Bound the wait so the explanation remains available offline. */
export const getModelInfo = () => request<ModelInfo>("/model/info", { signal: AbortSignal.timeout(10_000) });
/** The plot path comes from /model/info and belongs to the API host, not the frontend host. */
export const modelCalibrationUrl = (path: ModelInfo["calibration"]["plot_url"]) => `${API_URL}/${path.replace(/^\/+/, "")}`;
/** Latest briefing for every site in one request (cached on the server). */
export const getBriefings = () => request<BriefingsResponse>("/briefings");
/** 404 means the site has no briefing yet (see ApiRequestError.status). */
export const getBriefing = (siteId: string) => request<Briefing>(`/briefing/${encodeURIComponent(siteId)}`);
/** One site: generated right away. All sites (no site_id): queued in the background. Both need the
 *  demo code (a 401 without it). Protected requests send the demo code when one has been entered. */
export const sendBriefingNow = (body: SendBriefingRequest = {}) =>
  request<SendBriefingResponse>("/briefing/send-now", { method: "POST", headers: { "content-type": "application/json", ...demoCodeHeaders() }, body: JSON.stringify(body) });
export const getReplayStatus = () => request<ReplayStatus>("/replay/status");
/** The current or most recent replay's events, oldest first. 503 (NotReadyError) for ~30 s while the
 *  server prepares a window's timeline. Stop-work starts and all clears cover the whole storm: show
 *  only those at or before simulated now. */
export const getReplayEvents = () => request<ReplayEvent[]>("/replay/events", undefined, { quietNotReady: true });
/** 5-minute bins through simulated now. Same 503 as events. */
export const getReplaySeries = () => request<ReplaySeries>("/replay/series", undefined, { quietNotReady: true });
/** Map layers. */
export const getFires = () => request<FireDetection[]>("/fires/recent");
export const getWildlife = () => request<WildlifeSightingPoint[]>("/wildlife/recent");
/** Starting or stopping a replay needs the demo code (a 401 without it). */
export const startReplay = (body: StartReplayRequest = {}) =>
  request<ReplayStatus>("/replay/start", { method: "POST", headers: { "content-type": "application/json", ...demoCodeHeaders() }, body: JSON.stringify(body) });
export const stopReplay = () => request<ReplayStatus>("/replay/stop", { method: "POST", headers: demoCodeHeaders() });

/** shared/mocks, for the explicit "Demo data" mode only. Anything showing these must say so. */
export const DEMO_DATA = {
  reports: mockReports as HazardReport[],
  fires: mockFires as FireDetection[],
  wildlife: mockWildlife as WildlifeSightingPoint[],
  sites: mockSites as Site[],
  alerts: mockAlerts as Alert[],
  lightning: mockLightning as LightningFlash[],
  lightningCells: mockLightningCells as LightningCellsResponse,
  /** The sample belongs only to its site_id; never reuse it for another site. */
  scoreHistory: mockScoreHistory as ScoreHistory,
  pushSubscription: mockPushSubscription as PushSubscriptionInfo,
  /** Keyed by site id; only the 6 mock sites have one. */
  siteDetails: mockSiteDetails as Record<string, SiteDetail>,
  /** Keyed by site id; only the 6 mock sites have one. */
  briefings: mockBriefings as Record<string, Briefing>,
};

export function validatePhoto(file: File): string | null {
  if (!file.type.startsWith("image/")) return "Choose an image file, not a document or video.";
  if (!["image/jpeg", "image/png", "image/webp", "image/heic"].includes(file.type)) {
    return "Use a JPEG, PNG, WebP, or HEIC photo.";
  }
  if (file.size === 0) return "This photo is empty. Take or choose another photo.";
  if (file.size > 10 * 1024 * 1024) return "Photo is too large. Choose a photo of 10 MB or less.";
  return null;
}

function writeError(status: number, body: string): Error {
  if (status === 413) return new Error("Photo is too large. Choose a photo of 10 MB or less.");
  if (status === 415) return new Error("Unsupported photo. Use JPEG, PNG, WebP, or HEIC.");
  if (status >= 500) return new Error("The reporting service is unavailable. Your report has not been confirmed. Check Reports before trying again.");
  try {
    const error: ApiError = JSON.parse(body);
    if (typeof error.detail === "string") return new Error(error.detail);
  } catch { /* Use a readable fallback for non-JSON errors. */ }
  return new Error(`The request was rejected (${status}). Check the photo and report details.`);
}

/** Raw image upload; XHR exposes real upload progress. Writes never fall back to mocks. */
export function uploadPhoto(file: File, onProgress?: (percent: number) => void, signal?: AbortSignal): Promise<UploadResponse> {
  const invalid = validatePhoto(file);
  if (invalid) return Promise.reject(new Error(invalid));
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const cleanup = () => signal?.removeEventListener("abort", abort);
    xhr.open("POST", `${API_URL}/uploads`);
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.timeout = 120_000;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(Math.round(event.loaded / event.total * 100));
    };
    xhr.onload = () => {
      cleanup();
      if (xhr.status < 200 || xhr.status >= 300) return reject(writeError(xhr.status, xhr.responseText));
      try {
        const result: UploadResponse = JSON.parse(xhr.responseText);
        if (typeof result.photo_url !== "string" || !result.photo_url) throw new Error();
        onProgress?.(100);
        resolve(result);
      } catch { reject(new Error("The upload returned no photo URL. Please try again.")); }
    };
    xhr.onerror = () => { cleanup(); reject(new Error("Network error while uploading. Check your connection and try again.")); };
    xhr.ontimeout = () => { cleanup(); reject(new Error("Photo upload timed out. Check your connection and try again.")); };
    xhr.onabort = () => { cleanup(); reject(new DOMException("Upload cancelled", "AbortError")); };
    if (signal?.aborted) return reject(new DOMException("Upload cancelled", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    onProgress?.(0);
    xhr.send(file);
  });
}

export async function createReport(body: CreateReportRequest, signal?: AbortSignal): Promise<HazardReport> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}/reports`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error("Network error: the report could not be confirmed. Check Reports before retrying to avoid a duplicate.");
  }
  if (!response.ok) throw writeError(response.status, await response.text());
  try {
    const report: HazardReport = await response.json();
    if (!report.id || !report.photo_url || !Number.isFinite(report.lat) || !Number.isFinite(report.lon)) throw new Error();
    return report;
  } catch {
    throw new Error("The service returned an invalid confirmation. Check Reports before retrying to avoid a duplicate.");
  }
}
