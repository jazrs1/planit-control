import type { Metadata, Viewport } from "next";
import { Overpass, Overpass_Mono } from "next/font/google";
import { headers } from "next/headers";
import { APP_COLORS } from "@/lib/branding";
import { APP_DESCRIPTION, APP_NAME, pageMetadata } from "@/lib/metadata";
import { AlertsProvider } from "@/components/AlertsProvider";
import { PushProvider } from "@/components/PushProvider";
import OutageShell from "@/components/OutageShell";
import TopNavigation from "@/components/TopNavigation";
import { getAlerts, orNull } from "@/lib/api";
import "./globals.css";

// Overpass descends from Highway Gothic, the US road-sign face: built to be read fast, outdoors.
const overpass = Overpass({ subsets: ["latin"], variable: "--font-overpass", display: "swap" });
const overpassMono = Overpass_Mono({ subsets: ["latin"], variable: "--font-overpass-mono", display: "swap" });

// The navigation count is live safety data on every route.
export const dynamic = "force-dynamic";

export const viewport: Viewport = {
  width: "device-width", initialScale: 1, viewportFit: "cover",
  themeColor: APP_COLORS.theme, colorScheme: "light dark",
};

export async function generateMetadata(): Promise<Metadata> {
  // Resolve social image URLs against the deployed host, including reverse proxies.
  const requestHeaders = await headers();
  const host = (requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000").split(",")[0].trim();
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto")?.split(",")[0].trim();
  const protocol = forwardedProtocol === "http" || forwardedProtocol === "https" ? forwardedProtocol : host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https";
  return {
    ...pageMetadata(APP_NAME, APP_DESCRIPTION),
    metadataBase: new URL(`${protocol}://${host}`),
    title: { default: APP_NAME, template: `%s · ${APP_NAME}` },
    applicationName: APP_NAME,
    manifest: "/manifest.webmanifest",
    appleWebApp: { capable: true, title: APP_NAME, statusBarStyle: "default" },
    // Next emits the standard mobile-web-app-capable tag; retain the iOS fallback too.
    other: { "apple-mobile-web-app-capable": "yes" },
    icons: { apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }] },
    formatDetection: { telephone: false },
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // null if the backend is unreachable: the badge shows "—" until real alerts load.
  const alerts = await orNull(getAlerts());

  return (
    <html lang="en" className={`${overpass.variable} ${overpassMono.variable}`}>
      <body className="min-h-svh pbs-[env(safe-area-inset-top,0px)] pe-[env(safe-area-inset-right,0px)] pbe-[calc(env(safe-area-inset-bottom,0px)+5rem)] ps-[env(safe-area-inset-left,0px)] antialiased sm:pbe-0">
        <AlertsProvider initialAlerts={alerts}>
          <PushProvider>
            <TopNavigation />
            <OutageShell>{children}</OutageShell>
          </PushProvider>
        </AlertsProvider>
      </body>
    </html>
  );
}
