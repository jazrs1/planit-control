import { PageSkeleton } from "@/components/Skeletons";

export default function Loading() {
  return <PageSkeleton label="Loading settings…" cards={2} columns="" width="max-w-2xl" />;
}
