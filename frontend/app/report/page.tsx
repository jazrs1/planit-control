import ReportEntry from "@/components/ReportEntry";
import { getSites, orNull } from "@/lib/api";

export default async function ReportPage() {
  const sites = await orNull(getSites());
  return (
    <main className="mx-auto max-w-2xl px-4 py-6">
      <header className="mb-5">
        <h1 className="text-2xl font-bold text-brand">Report a hazard</h1>
        <p className="mt-1 text-sm text-muted">Add a photo and location so the next crew knows what to expect.</p>
      </header>
      <ReportEntry initialSites={sites} />
    </main>
  );
}
