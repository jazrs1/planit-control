import Link from "next/link";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata("About", "About Fieldcast and adding the field safety app to your phone’s home screen.");

export default function AboutPage() {
  return <main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 pbs-8 pbe-12 sm:px-6">
    <header className="flex flex-col gap-2">
      <h1 className="text-[2rem] font-semibold leading-tight tracking-[-0.015em]">About Fieldcast</h1>
      <p className="text-muted">Built for the Sperry Tech challenge at SwampHacks XII.</p>
    </header>
    <section className="pc-panel flex flex-col items-start gap-4 p-6 max-sm:p-5">
      <h2 className="text-xl font-semibold">What it does</h2>
      <p className="max-w-[68ch]">Lightning stop-work alerts, flood risk, live site readings, crew hazard reports and next-day briefings for 55 Florida power plant sites.</p>
      <Link href="/crew" className="pc-btn pc-btn--primary">Open crew view</Link>
    </section>
    <section className="pc-panel flex flex-col gap-4 p-6 max-sm:p-5">
      <h2 className="text-xl font-semibold">Add to your home screen</h2>
      <dl className="flex flex-col gap-4">
        <div className="grid gap-x-6 sm:grid-cols-[6rem_minmax(0,1fr)]">
          <dt className="font-semibold">iPhone</dt>
          <dd className="max-w-[68ch]">Open this site in Safari, tap Share, then Add to Home Screen. Choose Open as Web App if it is shown.</dd>
        </div>
        <div className="grid gap-x-6 sm:grid-cols-[6rem_minmax(0,1fr)]">
          <dt className="font-semibold">Android</dt>
          <dd className="max-w-[68ch]">Open this site in Chrome, open the browser menu, then choose Add to Home screen or Install app.</dd>
        </div>
      </dl>
      <p className="max-w-[68ch] text-xs text-muted">The home-screen app opens Crew view. Live conditions and reporting need a server connection; unavailable safety data stays marked unknown.</p>
    </section>
  </main>;
}
