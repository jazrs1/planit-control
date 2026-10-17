import AlertsList from "@/components/AlertsList";
import { getSites, orNull } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function AlertsPage() {
  // Only used for site names; alerts fall back to their site id if this fails.
  const sites = (await orNull(getSites())) ?? [];

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-brand">Active alerts</h1>
        <p className="mt-1 text-sm text-muted">
          Lightning stop-work countdowns and flood-risk notices.
        </p>
      </header>
      <AlertsList sites={sites} />
    </main>
  );
}
