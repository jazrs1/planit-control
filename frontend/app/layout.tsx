import type { Metadata } from "next";
import { AlertsProvider } from "@/components/AlertsProvider";
import TopNavigation from "@/components/TopNavigation";
import { getAlerts, orNull } from "@/lib/api";
import "./globals.css";

// The navigation count is live safety data on every route.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "PlanIT Control",
  description: "Real-time job-site safety for utility field crews",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // null if the backend is unreachable: the badge shows "—" until real alerts load.
  const alerts = await orNull(getAlerts());

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
