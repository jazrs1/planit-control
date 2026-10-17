import type { Metadata } from "next";

export const APP_NAME = "PlanIT Control";
/** The one line on the social card and the homepage's link preview. */
export const APP_TAGLINE = "Live job-site safety for Florida utility crews";
export const APP_DESCRIPTION = "Job-site safety for utility field crews: lightning stop-work alerts, site conditions, hazard reports, and next-day briefings.";

/** Page title "<Page> · PlanIT Control" and its link preview. `social` overrides what a shared link's
 *  card says (the homepage card reads "PlanIT Control" and the tagline, not "Dashboard"). */
export function pageMetadata(title: string, description: string, social?: { title: string; description: string }): Metadata {
  const fullTitle = title === APP_NAME ? APP_NAME : `${title} · ${APP_NAME}`;
  const card = social ?? { title: fullTitle, description };
  return {
    title: { absolute: fullTitle }, description,
    openGraph: {
      type: "website", locale: "en_US", siteName: APP_NAME, title: card.title, description: card.description,
      images: [{ url: "/social-preview.png", width: 1200, height: 630, alt: `${APP_NAME}: ${APP_TAGLINE.toLowerCase()}. A map of Florida job sites.` }],
    },
    twitter: { card: "summary_large_image", title: card.title, description: card.description, images: ["/social-preview.png"] },
  };
}
