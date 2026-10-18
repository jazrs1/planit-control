import { PageSkeleton } from "@/components/Skeletons";

export default function Loading() {
  return <PageSkeleton label="Loading reports…" cards={4} cardHeight="h-48" />;
}
