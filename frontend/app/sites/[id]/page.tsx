import { notFound } from "next/navigation";
import { cache } from "react";
import { pageMetadata } from "@/lib/metadata";
import type { SiteDetail } from "@shared/types";
import SiteDetailView from "@/components/SiteDetailView";
import { ApiRequestError, getSiteDetail } from "@/lib/api";

// Live safety data: always render per request, never prerender.
export const dynamic = "force-dynamic";

const readSite = cache(getSiteDetail);

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await readSite(id).catch(() => null);
  return pageMetadata(detail?.name ?? "Site details", detail
    ? `Safety conditions, active alerts, crew reports, and the next-day briefing for ${detail.name}.`
    : "Site safety conditions, active alerts, key readings, and the next-day briefing.");
}

export default async function SitePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let detail: SiteDetail | null = null;
  try {
    detail = await readSite(id);
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) notFound();
    // Unreachable or failing backend: render the unknown state, never mock data.
    console.warn(`[api] /sites/${id}: ${(err as Error).message}`);
  }
  return <SiteDetailView siteId={id} initialDetail={detail} />;
}
