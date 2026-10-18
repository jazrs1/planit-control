import { PageSkeleton } from "@/components/Skeletons";

export default function Loading() {
  return <PageSkeleton label="Loading alerts…" cards={3} columns="" cardHeight="h-24" />;
}
