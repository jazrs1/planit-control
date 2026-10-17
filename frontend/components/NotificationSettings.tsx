"use client";

import { useCallback, useState } from "react";
import type { Site } from "@shared/types";
import { useAlertsState } from "@/components/AlertsProvider";
import PushSettings from "@/components/PushSettings";
import { DEMO_DATA, getSites } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";

// PushSettings is shared with the crew view, so this page restyles it from the outside only: one flat
// card (no nested box), a 20px title, and secondary buttons as text links.
const CALM_PUSH_SETTINGS = [
  "[&>section]:border-0 [&>section]:p-6 [&>section]:shadow-card max-sm:[&>section]:p-5 [&>section]:space-y-5",
  "[&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-text",
  "[&_details]:border-0 [&_details]:bg-transparent [&_details]:p-0 [&_summary]:text-text",
  "[&_.flex>button+button]:border-transparent [&_.flex>button+button]:px-0 [&_.flex>button+button]:text-text [&_.flex>button+button]:underline [&_.flex>button+button]:decoration-border-strong [&_.flex>button+button]:underline-offset-4",
].join(" ");

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
  return <main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 pbs-8 pbe-12 sm:px-6">
    <header className="flex flex-col gap-2">
      <h1 className="text-[2rem] font-semibold leading-tight tracking-[-0.015em]">Notification settings</h1>
      <p className="text-muted">These settings apply to this browser on this device.</p>
    </header>
    <div className={CALM_PUSH_SETTINGS}>
      <PushSettings sites={demo ? DEMO_DATA.sites : sites} sitesUnconfirmed={!demo && failed} />
    </div>
    {failed && !demo && <button type="button" onClick={() => void refresh()} className="pc-link self-start">Retry loading sites</button>}
  </main>;
}
