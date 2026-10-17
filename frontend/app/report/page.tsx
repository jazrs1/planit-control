import { pageMetadata } from "@/lib/metadata";
import ReportEntry from "@/components/ReportEntry";
import { getSites, orNull } from "@/lib/api";

export const metadata = pageMetadata("Report hazard", "Share a crew hazard report with a photo, category, and map location.");

export default async function ReportPage({ searchParams }: { searchParams: Promise<{ site?: string | string[] }> }) {
  const query = await searchParams;
  const sites = await orNull(getSites());
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 pbs-8 pbe-12 sm:px-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-[2rem] font-semibold leading-tight tracking-[-0.015em]">Report a hazard</h1>
        <p className="text-muted">Add a photo and location so the next crew knows what to expect.</p>
      </header>
      <ReportEntry initialSites={sites} initialSiteId={typeof query.site === "string" ? query.site : ""} />
    </main>
  );
}
