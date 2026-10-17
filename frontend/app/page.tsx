import SupervisorDashboard from "@/components/SupervisorDashboard";
import { getSites } from "@/lib/api";

// Live safety data: always render per request, never prerender.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  // Alerts come from AlertsProvider in the root layout.
  const sites = await getSites();
  return <SupervisorDashboard initialSites={sites} />;
}
