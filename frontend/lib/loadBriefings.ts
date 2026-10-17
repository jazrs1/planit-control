import type { Briefing } from "@shared/types";
import { ApiRequestError, getBriefing, getBriefings } from "@/lib/api";

/** One site's briefing: the briefing, null when the backend has none yet, or "error" when it
 *  couldn't be loaded (unknown). */
export type BriefingResult = Briefing | null | "error";

export async function loadBriefing(siteId: string): Promise<BriefingResult> {
  try {
    return await getBriefing(siteId);
  } catch (err) {
    return err instanceof ApiRequestError && err.status === 404 ? null : "error";
  }
}

/** Every site's latest briefing in one request (GET /briefings). A site missing from the response has
 *  no briefing yet; if the request fails, every site is unknown. */
export async function loadBriefings(siteIds: string[]): Promise<Record<string, BriefingResult>> {
  try {
    const byId = new Map((await getBriefings()).map((b) => [b.site_id, b]));
    return Object.fromEntries(siteIds.map((id) => [id, byId.get(id) ?? null]));
  } catch {
    return Object.fromEntries(siteIds.map((id) => [id, "error" as const]));
  }
}
