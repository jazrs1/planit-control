import FullBriefing from "@/components/FullBriefing";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata("Full briefing", "A site's full safety briefing: go / caution / no-go, top risks, and actions.");

export default async function BriefingPage({ params }: { params: Promise<{ site_id: string }> }) {
  const { site_id } = await params;
  return <FullBriefing site_id={site_id} />;
}
