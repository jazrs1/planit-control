import FullBriefing from "@/components/FullBriefing";

export default async function BriefingPage({ params }: { params: Promise<{ site_id: string }> }) {
  const { site_id } = await params;
  return <FullBriefing site_id={site_id} />;
}
