import SupervisorDashboard from "@/components/SupervisorDashboard";
import { getSites, orNull } from "@/lib/api";

// Live safety data: always render per request, never prerender.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  // Alerts come from AlertsProvider in the root layout.
  // null if the backend is unreachable: the dashboard says so instead of showing mock sites.
  const sites = await orNull(getSites());
  return <SupervisorDashboard initialSites={sites} />;
}
