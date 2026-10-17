import type { PushSubscribeRequest, PushSubscriptionInfo, WebPushSubscription } from "@shared/types";
import { ApiRequestError, getPushPublicKey, subscribePush, testPush, unsubscribePush } from "@/lib/api";

export type PushPreferences = Required<Pick<PushSubscribeRequest, "site_ids" | "role">>;
export type DevicePushState = {
  phase: "checking" | "off" | "registered" | "unconfirmed" | "blocked" | "unsupported" | "demo";
  busy: boolean;
  preferences: PushPreferences;
  restored: boolean;
  info: PushSubscriptionInfo | null;
  canUnsubscribe: boolean;
  iphoneHint: boolean;
  message: string;
};
export const INITIAL_PUSH_STATE: DevicePushState = { phase: "checking", busy: true, preferences: { site_ids: null, role: "crew" }, restored: false, info: null, canUnsubscribe: false, iphoneHint: false, message: "Checking device alerts…" };
const STORAGE_KEY = "planit-control.push-preferences";

export function decodePushKey(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const decoded = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(decoded, character => character.charCodeAt(0));
}

export function iphoneInstallNeeded(): boolean {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const safari = /Safari/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(navigator.userAgent);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return ios && safari && !standalone;
}

function readPreferences(): { preferences: PushPreferences; disabled: boolean } | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!value || !["crew", "supervisor"].includes(value.role) || !(value.site_ids === null || (Array.isArray(value.site_ids) && value.site_ids.length > 0 && value.site_ids.every((id: unknown) => typeof id === "string" && id.length > 0)))) return null;
    return { preferences: { role: value.role, site_ids: value.site_ids }, disabled: value.disabled === true };
  } catch { return null; }
}

/** Browser state is separate from server confirmation. Endpoints and keys are never logged or stored here. */
export class DevicePush {
  state = INITIAL_PUSH_STATE;
  private subscription: PushSubscription | null = null;
  private pendingRemoval: string | null = null;
  private registration: ServiceWorkerRegistration | null = null;
  private disposed = false;
  constructor(private readonly changed: (state: DevicePushState) => void) {}
  dispose() { this.disposed = true; }
  private check() { if (this.disposed) throw new Error("Device settings changed. Please try again."); }
  private update(patch: Partial<DevicePushState>) { if (!this.disposed) { this.state = { ...this.state, ...patch }; this.changed(this.state); } }
  private remember(preferences: PushPreferences, disabled: boolean) {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...preferences, disabled })); }
    catch { /* This page still retains the choices when browser storage is blocked. */ }
  }
  private async worker() {
    if (this.registration) return this.registration;
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    this.check();
    this.registration = await navigator.serviceWorker.ready;
    this.check();
    return this.registration;
  }
  private serialize(subscription: PushSubscription): WebPushSubscription {
    const json = subscription.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) throw new Error("The browser returned an incomplete subscription.");
    return json as WebPushSubscription;
  }
  private async save(preferences: PushPreferences, renew = false) {
    this.check();
    if (Notification.permission !== "granted") throw new Error("Allow notifications in your browser settings, then try again.");
    if (this.pendingRemoval) {
      await unsubscribePush({ endpoint: this.pendingRemoval });
      this.check();
      this.pendingRemoval = null;
    }
    const registration = await this.worker();
    this.check();
    if (renew && this.subscription) {
      const removed = await this.subscription.unsubscribe();
      if (!removed && await registration.pushManager.getSubscription()) throw new Error("Could not renew this browser subscription. Try unsubscribing first.");
      this.subscription = null;
      this.update({ canUnsubscribe: false, info: null });
    }
    if (!this.subscription) {
      const { public_key } = await getPushPublicKey();
      this.check();
      this.subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodePushKey(public_key) });
    }
    this.check();
    this.update({ canUnsubscribe: true, preferences, restored: true });
    this.remember(preferences, false);
    const info = await subscribePush({ subscription: this.serialize(this.subscription), ...preferences });
    this.check();
    this.update({ phase: "registered", info, preferences: { site_ids: info.site_ids, role: info.role }, restored: true, message: "This device is registered for your chosen alerts." });
  }
  async initialize() {
    const iphoneHint = iphoneInstallNeeded();
    const saved = readPreferences();
    if (saved) this.update({ preferences: saved.preferences, restored: true });
    this.update({ iphoneHint });
    if (!window.isSecureContext || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window) || iphoneHint) {
      this.update({ phase: "unsupported", busy: false, message: iphoneHint ? "Install this app on your Home Screen to enable device alerts." : !window.isSecureContext ? "Device alerts require HTTPS or localhost." : "Device alerts are not supported in this browser." });
      return;
    }
    try {
      const registration = await this.worker();
      this.subscription = await registration.pushManager.getSubscription();
      this.check();
      this.update({ canUnsubscribe: this.subscription !== null });
      if (Notification.permission === "denied") this.update({ phase: "blocked", message: "Notifications are blocked. Allow them in browser or device settings to try again." });
      else if (this.subscription && !saved?.disabled) {
        // Quietly refresh the server's copy. Never request permission or create a subscription on load.
        const info = await subscribePush({ subscription: this.serialize(this.subscription), ...this.state.preferences });
        this.check();
        this.update({ phase: "registered", info, preferences: { site_ids: info.site_ids, role: info.role }, restored: true, message: "This device's alert registration was refreshed." });
      } else this.update(this.subscription && saved?.disabled ? { phase: "unconfirmed", message: "Unsubscribe was not completed. Retry Unsubscribe to stop device alerts." } : { phase: "off", message: "Device alerts are off." });
    } catch { this.update({ phase: "unconfirmed", message: "Device registration is not confirmed. Use Get alerts on this device to retry." }); }
    finally { this.update({ busy: false }); }
  }
  async enable(preferences: PushPreferences) {
    if (this.state.busy || this.disposed) return;
    if (preferences.site_ids !== null && preferences.site_ids.length === 0) { this.update({ message: "Choose at least one site, or select All sites." }); return; }
    this.update({ busy: true, message: "Setting up device alerts…" });
    try {
      // Called synchronously from the click, before any other await (required by iPhone Safari).
      const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
      this.check();
      if (permission !== "granted") { this.update({ phase: permission === "denied" ? "blocked" : "off", message: permission === "denied" ? "Notifications are blocked. Allow them in browser or device settings." : "Permission was not granted. Device alerts remain off." }); return; }
      await this.save(preferences);
    } catch { this.update({ phase: "unconfirmed", message: "Could not confirm device registration. Your changes may not be saved. Try again." }); }
    finally { this.update({ busy: false }); }
  }
  async sendTest() {
    if (this.state.busy || this.disposed || !this.subscription) return;
    this.update({ busy: true, message: "Sending a test notification…" });
    try {
      const result = await testPush({ endpoint: this.subscription.endpoint });
      this.check();
      if (result.removed) {
        this.update({ phase: "unconfirmed" });
        await this.save(this.state.preferences, true);
        this.update({ message: "Expired registration renewed. Send another test to check delivery." });
      } else this.update({ message: result.sent ? "Test accepted by the push service. Delivery may be delayed." : "The test could not be sent. Delivery is not confirmed; try again." });
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) {
        try { await this.save(this.state.preferences); this.update({ message: "Registration restored. Send another test to check delivery." }); }
        catch { this.update({ phase: "unconfirmed", message: "Registration could not be restored. Please try enabling alerts again." }); }
      } else this.update({ message: error instanceof ApiRequestError && error.status === 429 ? "Wait at least 10 seconds between test notifications, then try again." : "The test failed. Delivery is not confirmed; try again." });
    } finally { this.update({ busy: false }); }
  }
  async unsubscribe() {
    if (this.state.busy || this.disposed) return;
    const endpoint = this.pendingRemoval ?? this.subscription?.endpoint;
    if (!endpoint) return;
    this.pendingRemoval = endpoint;
    this.remember(this.state.preferences, true); // Never silently re-enable after a partially failed unsubscribe.
    this.update({ busy: true, message: "Stopping device alerts…" });
    const [server, browser] = await Promise.allSettled([
      unsubscribePush({ endpoint }),
      (async () => {
        if (this.subscription) {
          const removed = await this.subscription.unsubscribe();
          if (!removed && await this.registration?.pushManager.getSubscription()) throw new Error("Browser unsubscribe failed");
          this.subscription = null;
        }
      })(),
    ]);
    if (server.status === "fulfilled" && browser.status === "fulfilled") {
      this.pendingRemoval = null;
      this.update({ phase: "off", busy: false, canUnsubscribe: false, info: null, message: "Device alerts are off." });
    } else this.update({ phase: "unconfirmed", busy: false, canUnsubscribe: true, message: browser.status === "fulfilled" ? "Browser alerts stopped; server removal is not confirmed. Retry Unsubscribe." : "Unsubscribe is not confirmed. Retry Unsubscribe." });
  }
}
