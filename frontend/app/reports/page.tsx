import { pageMetadata } from "@/lib/metadata";
import ReportsView from "@/components/ReportsView";
import { getReports, getSites, orNull } from "@/lib/api";

export const metadata = pageMetadata("Reports", "Explore crew hazard reports, photos, and locations on the map, newest first.");

export default async function ReportsPage() {
  const [reports, sites] = await Promise.all([orNull(getReports()), orNull(getSites())]);
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 px-4 pbs-8 pbe-12 sm:px-6">
      <header className="flex scroll-mt-4 flex-col gap-2" id="reports-heading">
        <h1 className="text-[2rem] font-semibold leading-tight tracking-[-0.015em]">Crew hazard reports</h1>
        <p className="text-muted">Select a pin to jump to its report.</p>
      </header>
      <ReportsView initialReports={reports} sites={sites} />
    </main>
  );
}
