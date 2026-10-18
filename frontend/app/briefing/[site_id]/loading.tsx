import { PageSkeleton } from "@/components/Skeletons";

export default function Loading() {
  return <PageSkeleton label="Loading briefing…" cards={1} columns="" cardHeight="h-96" width="max-w-3xl" />;
}
