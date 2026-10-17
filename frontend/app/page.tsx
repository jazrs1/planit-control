import { pageMetadata } from "@/lib/metadata";
import SupervisorDashboard from "@/components/SupervisorDashboard";
import { getSites, orNull } from "@/lib/api";

// Live safety data: always render per request, never prerender.
export const dynamic = "force-dynamic";

export const metadata = pageMetadata("Dashboard", "Monitor utility site conditions, lightning stop-work alerts, and flood risk across Florida.");

export default async function HomePage() {
  // Alerts come from AlertsProvider in the root layout.
  // null if the backend is unreachable: the dashboard says so instead of showing mock sites.
  const sites = await orNull(getSites());
  return <SupervisorDashboard initialSites={sites} />;
}
