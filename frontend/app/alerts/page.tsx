import AlertsList from "@/components/AlertsList";
import { getSites } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function AlertsPage() {
  const sites = await getSites();

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-brand">Active alerts</h1>
        <p className="mt-1 text-sm text-muted">
          Stop-work notices and live lightning all-clear countdowns.
        </p>
      </header>
      <AlertsList sites={sites} />
    </main>
  );
}
