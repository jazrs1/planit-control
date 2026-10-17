"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FloodConditions } from "@shared/types";
import { useAlertsState } from "@/components/AlertsProvider";
import { getSiteDetail } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";

/** The alert payload has no reason; obtain the site's current flood reading instead.
 * Failed/unconfirmed reads remain unknown, never substitute a guessed flood cause. */
export function useFloodConditions() {
  const { alerts, status, replay } = useAlertsState();
  const ids = useMemo(() => [...new Set((alerts ?? []).filter((alert) => alert.type === "flood").map((alert) => alert.site_id))].sort().join(","), [alerts]);
  const [conditions, setConditions] = useState<Record<string, FloodConditions>>({});
  const generation = useRef(0);
  const live = status === "live";

  useEffect(() => {
    setConditions({});
    return () => { generation.current++; };
  }, [ids, live]);

  const refresh = useCallback(async () => {
    const current = generation.current;
    const results = await Promise.allSettled(ids.split(",").filter(Boolean).map(async (id) => {
      const site = await getSiteDetail(id);
      return [id, site.conditions.flood] as const;
    }));
    if (current !== generation.current) return;
    setConditions(Object.fromEntries(results.flatMap((result) => result.status === "fulfilled" ? [result.value] : [])));
  }, [ids]);
  usePolling(refresh, !live || !ids ? null : replay?.running ? 3_000 : 30_000);
  return live ? conditions : {};
}
