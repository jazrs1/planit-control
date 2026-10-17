import Link from "next/link";
import type { ReactNode } from "react";
import type { HazardIndex, HazardType } from "@shared/types";
import { pageMetadata } from "@/lib/metadata";
import { HAZARD_LABEL, riskLevel } from "@/lib/risk";

// "How it works" for judges and supervisors. Every fact here was checked against the backend
// (hazards/scheduler.py, hazards/sources/*, hazards/scoring.py, lightning/*) and docs/alert-engine.md.
// When docs/ml-model.md lands, fill in the "Machine learning model" section below.

export const metadata = pageMetadata("How it works", "Data sources, the lightning stop-work rule, the hazard index, honest limits and replay mode.");

const SECTIONS = [
  { id: "problem", label: "The problem" },
  { id: "sources", label: "Data sources" },
  { id: "stop-work", label: "Stop-work rule" },
  { id: "index", label: "Hazard index" },
  { id: "limits", label: "Honest limits" },
  { id: "replay", label: "Replay mode" },
];

type Source = { name: string; from: string; gives: string; every: string };

const SOURCES: Source[] = [
  { name: "GOES-19 GLM", from: "NOAA satellite lightning", gives: "Every lightning flash over Florida (plus 30 mi), with its exact time and place. Drives stop-work alerts.", every: "Every 20 s" },
  { name: "Open-Meteo", from: "Weather model forecasts", gives: "Heat index, temperature, humidity, rain (past 72 h and next 24 h) and soil moisture for each site.", every: "Hourly" },
  { name: "NWS alerts", from: "National Weather Service", gives: "Active watches, warnings and advisories (flood, heat, storms, red flag) that cover each site.", every: "Every 5 min" },
  { name: "FEMA flood zones", from: "National Flood Hazard Layer", gives: "Whether a site sits in the 1%-a-year (high-risk) floodplain.", every: "Once per site" },
  { name: "USGS rivers", from: "National Hydrography Dataset", gives: "Whether a named river is within 1 mile.", every: "Once per site" },
  { name: "NASA FIRMS", from: "VIIRS fire satellites", gives: "Fire detections in the last 24 h, nearest distance and count within 25 mi. Needs an API key.", every: "Every 30 min" },
  { name: "iNaturalist", from: "Wildlife sightings", gives: "Alligators and venomous snakes seen within 5 km (about 3 mi) in the last 30 days.", every: "Every 6 h" },
  { name: "Crew reports", from: "Field crews in this app", gives: "Photo, pin and category from the field. A report within 2 mi in the last 48 h raises the matching hazard (flooding, heat, ground, fire, wildlife) to at least Watch; downed lines get their own crew-hazards card.", every: "Live" },
  { name: "EIA-860M", from: "U.S. Energy Information Administration", gives: "The 55 real Florida power plants we track: largest first, with regional minimums.", every: "Loaded once" },
];

/** Sub-score rules, condensed from backend/hazards/scoring.py. */
const SUB_SCORES: { hazard: HazardType; rules: string }[] = [
  { hazard: "lightning", rules: "Active stop-work 9 · Severe Thunderstorm Watch 4 · Severe Thunderstorm or Tornado Warning 7" },
  { hazard: "heat", rules: "OSHA heat index band: lower 0–2, moderate 5, high 7.5, very high 9.5 · NWS Heat Advisory 6, Heat Warning 8" },
  { hazard: "flood", rules: "High-risk FEMA zone 1 · rain in past 24 h: 1 in → 3, 2 in → 6 (+1 in a flood zone or near a river) · next 24 h: 1 in → 3, 2 in → 5 · NWS advisory 4, watch 5, warning 8 · flood-risk alert 7" },
  { hazard: "soil_saturation", rules: "Dry 0 · moist 2 · saturated 5 (+2 after 2 in of rain in 24 h)" },
  { hazard: "wildfire", rules: "Fire within 5 mi 8, 10 mi 6, 25 mi 4 · Fire Weather Watch 3 · Red Flag Warning 5" },
  { hazard: "wildlife", rules: "Crew report nearby 5 · venomous snake 4 · alligator 2 · +1 with 5 or more sightings (max 6)" },
];

const BAND_STYLE = {
  green: { cls: "bg-risk-green-bg text-risk-green", label: "Low", range: "0 to < 4" },
  amber: { cls: "bg-risk-amber-bg text-risk-amber", label: "Elevated", range: "4 to < 7" },
  red: { cls: "bg-risk-red-bg text-risk-red", label: "High", range: "7 to 10" },
} as const;

/** One band per example score, via riskLevel(): the same thresholds the whole app uses. */
const BAND_EXAMPLES: HazardIndex[] = [2, 5, 8];

function Section({ id, title, takeaway, children }: { id: string; title: string; takeaway: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-4 rounded-card border border-border bg-surface p-4 shadow-card sm:p-6">
      <h2 id={`${id}-title`} className="text-xl font-bold text-brand">{title}</h2>
      <p className="mt-1 font-semibold text-text">{takeaway}</p>
      <div className="mt-4 space-y-4 text-sm leading-relaxed text-text sm:text-base">{children}</div>
    </section>
  );
}

/** A box in a flow diagram. */
function Box({ title, children, tone = "plain" }: { title: string; children?: ReactNode; tone?: "plain" | "brand" | "muted" }) {
  const toneCls = tone === "brand" ? "border-brand bg-brand text-surface" : tone === "muted" ? "border-dashed border-border bg-bg text-muted" : "border-border bg-bg text-text";
  return (
    <div className={`flex-1 rounded-card border p-3 text-sm ${toneCls}`}>
      <p className="font-semibold">{title}</p>
      {children && <div className="mt-1 text-xs leading-snug">{children}</div>}
    </div>
  );
}

/** → on wide screens, ↓ when the diagram stacks on a phone. */
function Arrow() {
  return (
    <div aria-hidden="true" className="flex shrink-0 items-center justify-center text-xl font-bold text-muted">
      <span className="sm:hidden">↓</span><span className="hidden sm:inline">→</span>
    </div>
  );
}

// Stop-work timeline: minutes after 6:00 PM on a 0-50 minute axis.
const AXIS_MIN = 50;
const TIMELINE = [
  { at: 0, label: "6:00 strike, 6.6 mi", note: "Alert starts · all clear 6:30", kind: "start" },
  { at: 12, label: "6:12 strike, 3.2 mi", note: "Countdown restarts · all clear 6:42", kind: "reset" },
  { at: 5, label: "6:05 strike, file arrives late", note: "Would end at 6:35: ignored, the countdown never gets shorter", kind: "late" },
] as const;
const pct = (min: number) => `${(min / AXIS_MIN) * 100}%`;

export default function HowItWorksPage() {
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-5 px-4 py-6">
      <header>
        <p className="text-sm font-semibold uppercase tracking-wide text-muted">How it works</p>
        <h1 className="mt-1 text-2xl font-bold text-brand sm:text-3xl">One honest picture of every job site&apos;s hazards</h1>
        <p className="mt-2 text-muted">PlanIT Control pulls live hazard data for 55 real Florida power plants, stops work when lightning gets close, and tells supervisors each evening whether tomorrow is go, caution or no-go.</p>
      </header>

      <aside aria-labelledby="sixty-title" className="rounded-card border-2 border-brand bg-surface p-4 shadow-card">
        <h2 id="sixty-title" className="font-bold text-brand">In 60 seconds</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm sm:text-base">
          <li><strong>9 data sources</strong>, from satellite lightning every 20 seconds to FEMA flood maps, joined per site.</li>
          <li><strong>Lightning within 10 miles stops work</strong> for 30 minutes, and every new strike restarts the clock. It runs on strike time, so late data can&apos;t end it early.</li>
          <li><strong>A 0–10 hazard index</strong> for today and tomorrow: green, amber, red. Today it&apos;s a transparent rule-based score; a machine learning model will replace it.</li>
          <li><strong>Unknown looks unknown.</strong> If the server goes quiet, the app says &quot;Status unknown&quot;, never &quot;All clear&quot;.</li>
          <li><strong>Replay mode</strong> plays a real 2025 storm through the real pipeline, so you can watch it work.</li>
        </ul>
      </aside>

      <nav aria-label="On this page" className="flex flex-wrap gap-2">
        {SECTIONS.map((s) => (
          <a key={s.id} href={`#${s.id}`} className="flex min-h-11 items-center rounded-pill border border-border bg-surface px-3 text-sm font-semibold text-brand hover:bg-bg focus-visible:outline-2 focus-visible:outline-brand">
            {s.label}
          </a>
        ))}
      </nav>

      <Section id="problem" title="The problem" takeaway="Hazard data is scattered across agencies, so go/no-go calls get made on instinct.">
        <p>A utility foreman deciding whether a crew should set up a bucket truck tomorrow would need to check a weather app, NWS alerts, a lightning map, FEMA flood maps, fire satellites and whatever the last crew said. Nobody has time for that at 6 AM, so the call is often a gut feeling.</p>
        <div role="img" aria-label="Before: six separate sources lead to a gut call. With PlanIT: the same sources feed one score per site and a go, caution or no-go briefing." className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Box title="Before" tone="muted">Weather app · NWS · lightning map · FEMA · fire satellites · crew texts</Box>
            <Arrow />
            <Box title="Gut call" tone="muted">Different every foreman, every day</Box>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Box title="With PlanIT">The same sources, checked automatically for every site</Box>
            <Arrow />
            <Box title="One score + rules">0–10 hazard index · lightning stop-work</Box>
            <Arrow />
            <Box title="Go / Caution / No-go" tone="brand">Per site, every evening at 6 PM</Box>
          </div>
        </div>
      </Section>

      <Section id="sources" title="Data sources" takeaway="Nine sources, each checked as often as it actually changes.">
        <div className="overflow-hidden rounded-card border border-border">
          <div className="hidden grid-cols-[10rem_1fr_7rem] gap-3 border-b border-border bg-bg px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted sm:grid">
            <span>Source</span><span>What it gives us</span><span className="text-right">How often</span>
          </div>
          <ul className="divide-y divide-border">
            {SOURCES.map((s) => (
              <li key={s.name} className="grid gap-1 px-3 py-3 sm:grid-cols-[10rem_1fr_7rem] sm:gap-3">
                <div>
                  <p className="font-semibold">{s.name}</p>
                  <p className="text-xs text-muted">{s.from}</p>
                </div>
                <p className="text-sm">{s.gives}</p>
                <p className="text-sm font-semibold text-brand sm:text-right">{s.every}</p>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-muted">If a source fails, the last good reading keeps being shown with its &quot;as of&quot; time, and the card is flagged when the reading gets old. A source with nothing yet shows &quot;No data&quot;, never a made-up zero.</p>
      </Section>

      <Section id="stop-work" title="Stop-work rule" takeaway="Lightning within 10 miles stops work. The 30-minute countdown restarts with every new strike.">
        <ul className="list-disc space-y-1 pl-5">
          <li>Any flash within <strong>10 miles</strong> of a site starts a stop-work alert.</li>
          <li><strong>All clear = the latest strike + 30 minutes.</strong> Each new strike pushes it later.</li>
          <li>The countdown uses <strong>when the lightning struck</strong>, not when our server read the file, so late or out-of-order satellite data can never shorten it.</li>
          <li>The check runs every 20 seconds <strong>even with no lightning</strong>, because the all-clear is triggered by silence.</li>
        </ul>

        <figure className="rounded-card border border-border bg-bg p-3">
          <figcaption className="mb-3 text-sm font-semibold">Example: three strikes near one site</figcaption>
          <div className="space-y-3">
            {TIMELINE.map((row) => (
              <div key={row.label} className="grid gap-1 sm:grid-cols-[11rem_1fr] sm:items-center sm:gap-3">
                <p className="text-xs font-semibold">{row.label}</p>
                <div>
                  <div className="relative h-6 rounded-pill bg-surface" aria-hidden="true">
                    <div
                      className={`absolute top-0 h-6 rounded-pill ${row.kind === "late" ? "border-2 border-dashed border-muted bg-bg" : "bg-risk-red"}`}
                      style={{ left: pct(row.at), width: pct(30) }}
                    />
                    <span className="absolute top-0 -ml-2 flex h-6 items-center text-sm" style={{ left: pct(row.at) }}>⚡</span>
                  </div>
                  <p className={`mt-1 text-xs ${row.kind === "late" ? "text-muted" : "text-risk-red"}`}>{row.note}</p>
                </div>
              </div>
            ))}
            <div className="grid gap-1 sm:grid-cols-[11rem_1fr] sm:items-center sm:gap-3">
              <p className="text-xs font-semibold">Result</p>
              <div>
                <div className="relative h-6 rounded-pill bg-surface" aria-hidden="true">
                  <div className="absolute top-0 h-6 rounded-pill bg-risk-red" style={{ left: 0, width: pct(42) }} />
                  <div className="absolute top-0 h-6 rounded-pill bg-risk-green-bg" style={{ left: pct(42), width: pct(AXIS_MIN - 42) }} />
                </div>
                <p className="mt-1 text-xs font-semibold text-risk-green">One continuous stop-work, 6:00 to 6:42. All clear at 6:42.</p>
              </div>
            </div>
            <div className="grid sm:grid-cols-[11rem_1fr] sm:gap-3" aria-hidden="true">
              <span />
              <div className="flex justify-between text-xs text-muted">
                {[0, 10, 20, 30, 40, 50].map((m) => <span key={m}>6:{String(m).padStart(2, "0")}</span>)}
              </div>
            </div>
          </div>
        </figure>

        <p>In a real replay of the August 4, 2025 storm, 21 of 55 sites got stop-work alerts. The busiest, Okeechobee Clean Energy Center, reset 177 times and cleared exactly 30 minutes after its final strike. Every reset is logged, so a safety manager can audit why a crew was stopped and when it was cleared.</p>
      </Section>

      <Section id="index" title="The hazard index (0–10)" takeaway="One number per site for today and tomorrow, in three fixed bands.">
        <div className="grid gap-2 sm:grid-cols-3" role="list" aria-label="Risk bands">
          {BAND_EXAMPLES.map((score) => {
            const band = BAND_STYLE[riskLevel(score)];
            return (
              <div key={score} role="listitem" className={`rounded-card px-3 py-2 ${band.cls}`}>
                <p className="font-bold">{band.label}</p>
                <p className="font-mono text-sm">{band.range}</p>
              </div>
            );
          })}
        </div>

        <h3 className="text-base font-bold">Today: a rule-based score you can check by hand</h3>
        <ol className="list-decimal space-y-1 pl-5">
          <li>Each hazard gets its own 0–10 sub-score from fixed rules (below).</li>
          <li><strong>Index = the highest sub-score, + 0.5 for each other hazard at 4 or above</strong>, capped at 10.</li>
          <li>A crew report within 2 mi in the last 48 h raises its hazard&apos;s sub-score to at least 4 (Watch) today.</li>
          <li>While a site has an active lightning stop-work, today&apos;s index is at least 9.0.</li>
          <li>Tomorrow uses the same rules on tomorrow&apos;s forecast, without the lightning override (lightning can&apos;t be forecast to the mile).</li>
        </ol>
        <details className="rounded-card border border-border bg-bg p-3">
          <summary className="cursor-pointer font-semibold text-brand">Sub-score rules for each hazard</summary>
          <dl className="mt-3 space-y-2 text-sm">
            {SUB_SCORES.map((r) => (
              <div key={r.hazard}>
                <dt className="font-semibold">{HAZARD_LABEL[r.hazard]}</dt>
                <dd className="text-muted">{r.rules}</dd>
              </div>
            ))}
          </dl>
        </details>

        <section aria-labelledby="ml-title" className="rounded-card border-2 border-dashed border-brand p-4">
          <p className="text-xs font-bold uppercase tracking-wide text-brand">Coming soon · placeholder</p>
          <h3 id="ml-title" className="text-base font-bold">Machine learning model</h3>
          <p className="mt-1 text-muted">A trained model will replace the rule-based score behind the same interface, so every screen keeps working. This section will be filled in from docs/ml-model.md.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {[
              { title: "Training data", body: "Which years, sites and labels the model learned from." },
              { title: "Test-year results", body: "How it scored on a year it never saw." },
              { title: "Baselines", body: "Compared with the rule-based score and simple forecasts." },
            ].map((p) => (
              <div key={p.title} className="rounded-card border border-dashed border-border bg-bg p-3">
                <p className="font-semibold">{p.title}</p>
                <p className="text-xs text-muted">{p.body}</p>
                <p className="mt-2 text-xs font-semibold text-muted">To be added</p>
              </div>
            ))}
            <div className="rounded-card border border-dashed border-border bg-bg p-3">
              <p className="font-semibold">Calibration chart</p>
              <div className="mt-2 flex h-24 items-center justify-center rounded-card border border-dashed border-border text-xs text-muted" role="img" aria-label="Calibration chart placeholder">
                Chart to be added
              </div>
            </div>
          </div>
        </section>
      </Section>

      <Section id="limits" title="Honest limits" takeaway="What this system can't tell you, so nobody over-trusts it.">
        <ul className="space-y-3">
          {[
            { t: "Rainfall is a model estimate.", d: "Open-Meteo rain totals come from weather models, not a rain gauge at the site. Real totals can be higher or lower." },
            { t: "Wildfire depends on satellite passes.", d: "VIIRS satellites see a given spot only a few times a day, so a new fire can burn for hours before it shows up. Hot spots within 1 km of a plant are treated as plant heat and ignored, so a real fire inside that ring would be missed. Without a FIRMS key, wildfire data is off and the card says so." },
            { t: "It predicts hazardous weather days, not injuries.", d: "A high index means conditions are dangerous, not that someone will get hurt, and a low index doesn't mean a site is safe. It supports a supervisor's judgment; it doesn't replace it." },
            { t: "Lightning positions are approximate.", d: "Satellite pixels are about 8–14 km across, so a strike reported at 9.8 mi could be a little closer or farther. A strike reaches us 20–40 seconds after it happens." },
            { t: "Today's index is a placeholder.", d: "Until the machine learning model lands, the index is the rule-based score above." },
          ].map((l) => (
            <li key={l.t} className="rounded-card border-l-4 border-risk-amber bg-bg p-3">
              <p className="font-semibold">{l.t}</p>
              <p className="text-sm text-muted">{l.d}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="replay" title="Replay mode" takeaway="A real recorded storm, played through the real pipeline, at 30× speed.">
        <p>Lightning doesn&apos;t strike on cue for a demo. Replay takes an hour of real GOES-19 satellite files from a past Florida storm and feeds them, one by one, through the <strong>same code</strong> the live system uses. A simulated clock starts at the storm&apos;s first file and runs 30× faster, so an hour of lightning plays in about two minutes.</p>
        <div role="img" aria-label="Live satellite files every 20 seconds, or recorded storm files in replay, go through the same ingestion, the same stop-work engine and the same API to the dashboard." className="flex flex-col gap-2 sm:flex-row">
          <div className="flex flex-1 flex-col gap-2">
            <Box title="Live">GOES-19 file every 20 s</Box>
            <Box title="Replay" tone="muted">Recorded storm files, simulated clock</Box>
          </div>
          <Arrow />
          <Box title="Same pipeline" tone="brand">Ingest flashes → stop-work engine → API</Box>
          <Arrow />
          <Box title="Dashboard">Map, alerts, countdowns</Box>
        </div>
        <ul className="list-disc space-y-1 pl-5">
          <li><strong>Why the real pipeline:</strong> it proves the code that protects crews actually works, and it gives exactly the alerts crews would have seen that evening. The alert engine has no clock of its own; it runs on whatever time it&apos;s given.</li>
          <li>Replay alerts are stored separately and <strong>never mix with live ones</strong>. Real lightning keeps being tracked during a replay: real alerts stay on screen next to the replay&apos;s, which are tagged REPLAY.</li>
          <li>After the last file, replay runs 31 quiet simulated minutes so every countdown can finish.</li>
          <li>Heat, rain, fire and wildlife stay live during a replay; only lightning is replayed.</li>
        </ul>
        <p>
          <Link href="/" className="font-semibold text-brand underline focus-visible:outline-2 focus-visible:outline-brand">Try it: open the dashboard and press ⚡ Replay storm</Link>
        </p>
      </Section>
    </main>
  );
}
