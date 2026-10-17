import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { APP_COLORS } from "@/lib/branding";
import { APP_DESCRIPTION, APP_NAME, pageMetadata } from "@/lib/metadata";
import { AlertsProvider } from "@/components/AlertsProvider";
import OutageShell from "@/components/OutageShell";
import TopNavigation from "@/components/TopNavigation";
import { getAlerts, orNull } from "@/lib/api";
import "./globals.css";

// The navigation count is live safety data on every route.
export const dynamic = "force-dynamic";

export const viewport: Viewport = {
  width: "device-width", initialScale: 1, viewportFit: "cover",
  themeColor: APP_COLORS.theme, colorScheme: "light",
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
    <html lang="en">
      <body className="min-h-screen pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[calc(env(safe-area-inset-bottom)+5rem)] pl-[env(safe-area-inset-left)] antialiased sm:pb-0">
        <AlertsProvider initialAlerts={alerts}>
          <TopNavigation />
          <OutageShell>{children}</OutageShell>
        </AlertsProvider>
      </body>
    </html>
  );
}
