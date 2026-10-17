import { pageMetadata } from "@/lib/metadata";
import ReportsView from "@/components/ReportsView";
import { getReports, getSites, orNull } from "@/lib/api";

export const metadata = pageMetadata("Reports", "Explore crew hazard reports, photos, and locations on the map, newest first.");

export default async function ReportsPage() {
  const [reports, sites] = await Promise.all([orNull(getReports()), orNull(getSites())]);
  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <header className="mbe-5">
        <h1 id="reports-heading" className="pc-title">Crew hazard reports</h1>
        <p className="mbs-1 text-sm text-muted">Select a pin or report to explore hazards reported by crews.</p>
      </header>
      <ReportsView initialReports={reports} sites={sites} />
    </main>
  );
}
