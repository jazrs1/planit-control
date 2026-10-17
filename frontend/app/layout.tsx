import type { Metadata } from "next";
import { AlertsProvider } from "@/components/AlertsProvider";
import TopNavigation from "@/components/TopNavigation";
import { getAlerts } from "@/lib/api";
import "./globals.css";

// The navigation count is live safety data on every route.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "PlanIT Control",
  description: "Real-time job-site safety for utility field crews",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const alerts = await getAlerts();

  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <AlertsProvider initialAlerts={alerts}>
          <TopNavigation />
          {children}
        </AlertsProvider>
      </body>
    </html>
  );
}
