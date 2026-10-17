import type { Metadata } from "next";

export const APP_NAME = "PlanIT Control";
export const APP_DESCRIPTION = "Job-site safety for utility field crews: lightning stop-work alerts, site conditions, hazard reports, and next-day briefings.";

export function pageMetadata(title: string, description: string): Metadata {
  const fullTitle = title === APP_NAME ? APP_NAME : `${title} · ${APP_NAME}`;
  return {
    title: { absolute: fullTitle }, description,
    openGraph: {
      type: "website", locale: "en_US", siteName: APP_NAME, title: fullTitle, description,
      images: [{ url: "/social-preview.png", width: 1200, height: 630, alt: "PlanIT Control — job-site safety for field crews" }],
    },
    twitter: { card: "summary_large_image", title: fullTitle, description, images: ["/social-preview.png"] },
  };
}
