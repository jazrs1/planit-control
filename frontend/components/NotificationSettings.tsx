"use client";

import { useCallback, useState } from "react";
import type { Site } from "@shared/types";
import { useAlertsState } from "@/components/AlertsProvider";
import PushSettings from "@/components/PushSettings";
import { DEMO_DATA, getSites } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";

export default function NotificationSettings({ initialSites }: { initialSites: Site[] | null }) {
  const { status, replay } = useAlertsState();
  const demo = status === "demo";
  const [sites, setSites] = useState(initialSites);
  const [failed, setFailed] = useState(initialSites === null);
  const refresh = useCallback(async () => {
    try { setSites(await getSites()); setFailed(false); }
    catch { setFailed(true); }
  }, []);
  usePolling(refresh, demo ? null : replay?.running ? 3_000 : failed ? 5_000 : 30_000);
  return <main className="mx-auto max-w-2xl space-y-4 px-4 py-6">
    <h1 className="pc-title">Notification settings</h1>
    <p className="text-sm text-muted">These settings apply to this browser on this device.</p>
    <PushSettings sites={demo ? DEMO_DATA.sites : sites} sitesUnconfirmed={!demo && failed} />
    {failed && !demo && <button type="button" onClick={() => void refresh()} className="min-h-12 rounded-card border-2 border-rule px-4 font-semibold text-brand">Retry loading sites</button>}
  </main>;
}
