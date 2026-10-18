import { pageMetadata } from "@/lib/metadata";
import AlertsList from "@/components/AlertsList";
import { getSites, orNull } from "@/lib/api";

export const dynamic = "force-dynamic";

export const metadata = pageMetadata("Alerts", "Active lightning stop-work countdowns and flood-risk notices for utility field crews.");

export default async function AlertsPage() {
  // Only used for site names; alerts fall back to their site id if this fails.
  const sites = (await orNull(getSites())) ?? [];

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 px-4 pbs-8 pbe-12 sm:px-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-[2rem] font-semibold leading-tight tracking-[-0.015em]">Active alerts</h1>
      </header>
      <AlertsList sites={sites} />
    </main>
  );
}
