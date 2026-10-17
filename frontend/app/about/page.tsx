import Link from "next/link";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata("About", "About PlanIT Control and adding the field safety app to your phone’s home screen.");

export default function AboutPage() {
  return <main className="mx-auto max-w-2xl space-y-6 px-4 py-6">
    <header><h1 className="text-2xl font-bold text-brand">About PlanIT Control</h1><p className="mt-2 text-lg">Job-site safety for utility field crews.</p></header>
    <section className="space-y-3 rounded-card border border-border bg-surface p-5 shadow-card">
      <h2 className="text-xl font-bold">Your site, at a glance</h2>
      <p>Check lightning stop-work alerts, flood risk, site readings, crew hazard reports, and next-day briefings. Built for the Sperry Tech challenge at SwampHacks XII.</p>
      <Link href="/crew" className="inline-flex min-h-12 items-center rounded-card bg-brand px-4 font-semibold text-surface">Open crew view</Link>
    </section>
    <section className="space-y-3 rounded-card border border-border bg-surface p-5 shadow-card">
      <h2 className="text-xl font-bold">Add to your home screen</h2>
      <p><strong>iPhone:</strong> Open this site in Safari, tap Share, then Add to Home Screen. Choose Open as Web App if it is shown.</p>
      <p><strong>Android:</strong> Open this site in Chrome, open the browser menu, then choose Add to Home screen or Install app.</p>
      <p className="text-muted">The home-screen app opens Crew view. Live conditions and reporting need a server connection; unavailable safety data stays marked unknown.</p>
    </section>
  </main>;
}
