import Link from "next/link";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata("Page not found", "This page is unavailable. Return to the PlanIT Control crew view or dashboard.");

export default function NotFound() {
  return <main className="mx-auto grid min-h-[calc(100svh-var(--pc-nav-height)-8rem)] max-w-xl place-content-center gap-6 px-4 py-12 text-center">
    <img src="/icon.svg" width={64} height={64} alt="" className="mx-auto" />
    <div className="space-y-2">
      <p className="pc-caption">404</p>
      <h1 className="pc-title">This page isn&apos;t here</h1>
      <p className="text-muted">The link may have changed or the site was renamed. Live safety status is one tap away.</p>
    </div>
    <div className="flex flex-wrap justify-center gap-x-6 gap-y-2">
      <Link href="/crew" className="pc-btn pc-btn--quiet">Open crew view</Link>
      <Link href="/" className="pc-link">Go to the dashboard →</Link>
    </div>
  </main>;
}
