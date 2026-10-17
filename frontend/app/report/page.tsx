import { pageMetadata } from "@/lib/metadata";
import ReportEntry from "@/components/ReportEntry";
import { getSites, orNull } from "@/lib/api";

export const metadata = pageMetadata("Report hazard", "Share a crew hazard report with a photo, category, and map location.");

export default async function ReportPage({ searchParams }: { searchParams: Promise<{ site?: string | string[] }> }) {
  const query = await searchParams;
  const sites = await orNull(getSites());
  return (
    <main className="mx-auto max-w-2xl px-4 py-6">
      <header className="mbe-5">
        <h1 className="pc-title">Report a hazard</h1>
        <p className="mbs-1 text-sm text-muted">Add a photo and location so the next crew knows what to expect.</p>
      </header>
      <ReportEntry initialSites={sites} initialSiteId={typeof query.site === "string" ? query.site : ""} />
    </main>
  );
}
