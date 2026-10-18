import { PageSkeleton } from "@/components/Skeletons";

export default function Loading() {
  return <PageSkeleton label="Loading…" cards={3} columns="" width="max-w-4xl" />;
}
