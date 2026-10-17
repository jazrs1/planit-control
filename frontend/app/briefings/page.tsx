import { pageMetadata } from "@/lib/metadata";
import BriefingsView from "@/components/BriefingsView";
import { getSites, orNull } from "@/lib/api";
import { loadBriefings } from "@/lib/loadBriefings";

// Live safety data: always render per request, never prerender.
export const dynamic = "force-dynamic";

export const metadata = pageMetadata("Briefings", "Read next-day safety briefings for every utility site, generated at 6 PM site-local time.");

export default async function BriefingsPage() {
  const sites = await orNull(getSites());
  // null when the backend is unreachable: the view shows the unknown state, never mock briefings.
  const initial = sites && { sites, results: await loadBriefings(sites.map((s) => s.id)) };
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 px-4 pbs-8 pbe-12 sm:px-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-[2rem] font-semibold leading-tight tracking-[-0.015em]">Tomorrow&apos;s briefings</h1>
        <p className="max-w-[68ch] text-muted">Next-day safety briefing for every site, generated at 6 PM site time.</p>
      </header>
      <BriefingsView initial={initial} />
    </main>
  );
}
