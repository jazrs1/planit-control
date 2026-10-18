import { PageSkeleton } from "@/components/Skeletons";

export default function Loading() {
  return <PageSkeleton label="Loading briefings…" cards={6} columns="lg:grid-cols-2" cardHeight="h-64" />;
}
