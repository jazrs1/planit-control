import { PageSkeleton } from "@/components/Skeletons";

export default function Loading() {
  return <PageSkeleton label="Loading site…" cards={6} columns="sm:grid-cols-2 lg:grid-cols-3" />;
}
