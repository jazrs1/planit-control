import type { Briefing } from "@shared/types";
import { ApiRequestError, getBriefing } from "@/lib/api";
import { mapLimit } from "@/lib/briefings";

/** One site's briefing: the briefing, null when the backend has none yet (404), or "error" when it
 *  couldn't be loaded (unknown). There is no list endpoint, so this is one GET per site. */
export type BriefingResult = Briefing | null | "error";

export async function loadBriefing(siteId: string): Promise<BriefingResult> {
  try {
    return await getBriefing(siteId);
  } catch (err) {
    return err instanceof ApiRequestError && err.status === 404 ? null : "error";
  }
}

export async function loadBriefings(siteIds: string[]): Promise<Record<string, BriefingResult>> {
  const results = await mapLimit(siteIds, 8, loadBriefing);
  return Object.fromEntries(siteIds.map((id, i) => [id, results[i]]));
}
