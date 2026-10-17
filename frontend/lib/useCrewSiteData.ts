"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Briefing, Site, SiteDetail } from "@shared/types";
import { useAlertsState } from "@/components/AlertsProvider";
import { DEMO_DATA, getBriefing, getSiteDetail } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";

/** Mount with a site/mode key so switching sites never shows the previous site's readings. */
export function useCrewSiteData(site_id: Site["id"]) {
  const { status, replay } = useAlertsState();
  const demo = status === "demo";
  const [detail, setDetail] = useState<SiteDetail | null>(() => demo ? DEMO_DATA.siteDetails[site_id] ?? null : null);
  const [briefing, setBriefing] = useState<Briefing | null>(() => demo ? DEMO_DATA.briefings[site_id] ?? null : null);
  const [detailFailed, setDetailFailed] = useState(false);
  const [briefingFailed, setBriefingFailed] = useState(false);
  const [loading, setLoading] = useState(!demo);
  const active = useRef(true);
  const pending = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  const refresh = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    const [nextDetail, nextBriefing] = await Promise.allSettled([getSiteDetail(site_id), getBriefing(site_id)]);
    pending.current = false;
    if (!active.current) return;
    if (nextDetail.status === "fulfilled") { setDetail(nextDetail.value); setDetailFailed(false); }
    else setDetailFailed(true);
    if (nextBriefing.status === "fulfilled") { setBriefing(nextBriefing.value); setBriefingFailed(false); }
    else setBriefingFailed(true);
    setLoading(false);
  }, [site_id]);
  usePolling(refresh, demo ? null : replay?.running ? 3_000 : detail === null ? 5_000 : 30_000);
  return { detail, briefing, detailFailed, briefingFailed, loading, refresh };
}
