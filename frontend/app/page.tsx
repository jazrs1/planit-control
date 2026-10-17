import SupervisorDashboard from "@/components/SupervisorDashboard";
import { getAlerts, getSites } from "@/lib/api";

// Live safety data: always render per request, never prerender.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [sites, alerts] = await Promise.all([getSites(), getAlerts()]);
  return <SupervisorDashboard initialSites={sites} initialAlerts={alerts} />;
}
