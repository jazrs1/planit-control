import { notFound } from "next/navigation";
import type { SiteDetail } from "@shared/types";
import SiteDetailView from "@/components/SiteDetailView";
import { ApiRequestError, getSiteDetail } from "@/lib/api";

// Live safety data: always render per request, never prerender.
export const dynamic = "force-dynamic";

export default async function SitePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let detail: SiteDetail | null = null;
  try {
    detail = await getSiteDetail(id);
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) notFound();
    // Unreachable or failing backend: render the unknown state, never mock data.
    console.warn(`[api] /sites/${id}: ${(err as Error).message}`);
  }
  return <SiteDetailView siteId={id} initialDetail={detail} />;
}
