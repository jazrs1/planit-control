import type { MetadataRoute } from "next";
import { APP_COLORS } from "@/lib/branding";
import { APP_DESCRIPTION, APP_NAME } from "@/lib/metadata";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/", name: APP_NAME, short_name: "PlanIT", description: APP_DESCRIPTION,
    lang: "en-US", start_url: "/crew", scope: "/", display: "standalone",
    background_color: APP_COLORS.background, theme_color: APP_COLORS.theme,
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Report hazard", url: "/report" },
      { name: "Alerts", url: "/alerts" },
    ],
  };
}
