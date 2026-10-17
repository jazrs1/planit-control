import SiteCard from "@/components/SiteCard";
import { getAlerts, getSites } from "@/lib/api";

// Live safety data: always render per request, never prerender.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [sites, alerts] = await Promise.all([getSites(), getAlerts()]);
  const sorted = [...sites].sort((a, b) => b.hazard_index - a.hazard_index);

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-brand">PlanIT Control</h1>
        <p className="text-sm text-muted">{sites.length} sites, highest risk first</p>
      </header>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {sorted.map((site) => (
          <li key={site.id}>
            <SiteCard
              site={site}
              lightningAlert={alerts.find((a) => a.site_id === site.id && a.type === "lightning")}
            />
          </li>
        ))}
      </ul>
    </main>
  );
}
