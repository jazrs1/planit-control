import Link from "next/link";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata("Page not found", "This page is unavailable. Return to the PlanIT Control crew view or dashboard.");

export default function NotFound() {
  return <main className="mx-auto max-w-2xl space-y-4 px-4 py-8">
    <h1 className="pc-title">Page not found</h1>
    <p>This link may have changed.</p>
    <Link href="/crew" className="pc-btn pc-btn--primary">Open crew view</Link>
  </main>;
}
