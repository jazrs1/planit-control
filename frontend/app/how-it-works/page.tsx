import Link from "next/link";
import type { ReactNode } from "react";
import type { HazardIndex } from "@shared/types";
import ModelExplanation from "@/components/ModelExplanation";
import { getModelInfo, orNull } from "@/lib/api";
import { APP_CREDIT, pageMetadata } from "@/lib/metadata";
import { riskLevel } from "@/lib/risk";

// "How it works" for judges and supervisors. Every fact here was checked against the backend
// (hazards/scheduler.py, hazards/sources/*, hazards/risk.py, lightning/*), docs/alert-engine.md
// and docs/ml-model.md. Model evaluation numbers come from /model/info on each page request.

export const metadata = pageMetadata("How it works", "Data sources, the lightning stop-work rule, the hazard index, its limits and replay mode.");

const SECTIONS = [
  { id: "problem", label: "The problem" },
  { id: "sources", label: "Data sources" },
  { id: "stop-work", label: "Stop-work rule" },
  { id: "index", label: "Hazard index" },
  { id: "model", label: "Machine learning model" },
  { id: "briefing", label: "Next-day briefing" },
  { id: "limits", label: "Limits" },
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

const BAND_STYLE = {
  green: { text: "text-risk-green", shape: "pc-shape--green", label: "Low", range: "0 to < 4" },
  amber: { text: "text-risk-amber", shape: "pc-shape--amber", label: "Elevated", range: "4 to < 7" },
  red: { text: "text-risk-red", shape: "pc-shape--red", label: "High", range: "7 to 10" },
} as const;

/** One band per example score, via riskLevel(): the same thresholds the whole app uses. */
const BAND_EXAMPLES: HazardIndex[] = [2, 5, 8];

/** `takeaway` is the section's one-line point; leave it out when it would only restate the title. */
function Section({ id, title, takeaway, children }: { id: string; title: string; takeaway?: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="pc-panel scroll-mt-4 p-6 sm:p-8">
      <h2 id={`${id}-title`} className="text-xl font-semibold">{title}</h2>
      {takeaway && <p className="mbs-1 max-w-[68ch] text-muted">{takeaway}</p>}
      <div className="mbs-6 flex flex-col gap-6">{children}</div>
    </section>
  );
}

/** A box in a flow diagram. */
function Box({ title, children, tone = "plain" }: { title: string; children?: ReactNode; tone?: "plain" | "brand" | "muted" }) {
  const toneCls = tone === "brand" ? "bg-brand text-on-brand" : tone === "muted" ? "border border-dashed border-border-strong text-muted" : "bg-surface-2 text-text";
  return (
    <div className={`flex-1 rounded-card px-4 py-3 ${toneCls}`}>
      <p className="font-semibold">{title}</p>
      {children && <div className="mbs-1 text-xs">{children}</div>}
    </div>
  );
}

/** → on wide screens, ↓ when the diagram stacks on a phone. */
function Arrow() {
  return (
    <div aria-hidden="true" className="flex shrink-0 items-center justify-center text-muted">
      <span className="sm:hidden">↓</span><span className="hidden sm:inline">→</span>
    </div>
  );
}

// Stop-work timeline: minutes after 6:00 PM on a 0-50 minute axis.
const AXIS_MIN = 50;
const TIMELINE = [
  { at: 0, label: "6:00 strike, 6.6 mi", note: "Alert starts; all clear at 6:30", kind: "start" },
  { at: 12, label: "6:12 strike, 3.2 mi", note: "Countdown restarts; all clear at 6:42", kind: "reset" },
  { at: 5, label: "6:05 strike, file arrives late", note: "Would end at 6:35: ignored, the countdown never gets shorter", kind: "late" },
] as const;
const pct = (min: number) => `${(min / AXIS_MIN) * 100}%`;

export default async function HowItWorksPage() {
  const modelInfo = await orNull(getModelInfo());
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 px-4 pbs-8 pbe-12 sm:px-6 [&_strong]:font-semibold">
      <header className="flex flex-col gap-2">
        <h1 className="text-[2rem] font-semibold leading-tight tracking-[-0.015em] text-balance">How 9 data sources become one safety call per site</h1>
        <p className="max-w-[68ch] text-muted">Fieldcast pulls live hazard data for 55 real Florida power plants, stops work when lightning gets close, and tells supervisors each evening whether tomorrow is go, caution or no-go.</p>
        <p className="text-xs text-muted">{APP_CREDIT}</p>
      </header>

      <aside aria-labelledby="sixty-title" className="pc-panel flex flex-col gap-4 p-6 sm:p-8">
        <h2 id="sixty-title" className="text-xs text-muted">Summary</h2>
        <ul className="flex max-w-[68ch] list-disc flex-col gap-2 ps-5">
          <li><strong>9 data sources</strong>, from satellite lightning every 20 seconds to FEMA flood maps, joined per site.</li>
          <li><strong>Lightning within 10 miles stops work</strong> for 30 minutes, and every new strike restarts the clock. It runs on strike time, so late data can&apos;t end it early.</li>
          <li><strong>A hybrid 0–10 hazard index</strong> for today and tomorrow: a trained weather model plus safety rules for heat, fire and crew reports. Official warnings and lightning stop-work can only raise it.</li>
          <li><strong>Unknown looks unknown.</strong> If the server goes quiet, the app says &quot;Status unknown&quot;, never &quot;All clear&quot;.</li>
          <li><strong>Replay mode</strong> plays a real 2025 storm through the real pipeline, so you can watch it work.</li>
        </ul>
      </aside>

      <nav aria-label="On this page" className="flex flex-wrap gap-x-6">
        {SECTIONS.map((s) => (
          <a key={s.id} href={`#${s.id}`} className="pc-link">
            {s.label}
          </a>
        ))}
      </nav>

      <Section id="problem" title="The problem" takeaway="Hazard data is scattered across agencies, so go/no-go calls get made on instinct.">
        <p>A utility foreman deciding whether a crew should set up a bucket truck tomorrow would need to check a weather app, NWS alerts, a lightning map, FEMA flood maps, fire satellites and whatever the last crew said. Nobody has time for that at 6 AM, so the call is often a gut feeling.</p>
        <div role="img" aria-label="Before: six separate sources lead to a gut call. With Fieldcast: the same sources feed one score per site and a go, caution or no-go briefing." className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Box title="Before" tone="muted">Weather app, NWS, lightning map, FEMA, fire satellites, crew texts</Box>
            <Arrow />
            <Box title="Gut call" tone="muted">Different every foreman, every day</Box>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Box title="With Fieldcast">The same sources, checked automatically for every site</Box>
            <Arrow />
            <Box title="One score and rules">0–10 hazard index and lightning stop-work</Box>
            <Arrow />
            <Box title="Go / Caution / No-go" tone="brand">Per site, every evening at 6 PM</Box>
          </div>
        </div>
      </Section>

      <Section id="sources" title="Data sources" takeaway="Nine sources, each checked as often as it actually changes.">
        <div>
          <div className="hidden grid-cols-[10rem_1fr_7rem] gap-6 pbe-2 text-xs text-muted sm:grid">
            <span>Source</span><span>What it gives us</span><span className="text-end">How often</span>
          </div>
          <ul className="flex flex-col gap-5">
            {SOURCES.map((s) => (
              <li key={s.name} className="grid gap-1 sm:grid-cols-[10rem_1fr_7rem] sm:gap-6">
                <div>
                  <p className="font-semibold">{s.name}</p>
                  <p className="text-xs text-muted">{s.from}</p>
                </div>
                <p className="max-w-[68ch]">{s.gives}</p>
                <p className="text-xs text-muted sm:text-end sm:font-semibold sm:text-text">{s.every}</p>
              </li>
            ))}
          </ul>
        </div>
        <p className="max-w-[68ch] text-muted">If a source fails, the last good reading keeps being shown with its &quot;as of&quot; time, and the card is flagged when the reading gets old. A source with nothing yet shows &quot;No data&quot;, never a made-up zero.</p>
      </Section>

      <Section id="stop-work" title="Stop-work rule" takeaway="Lightning within 10 miles stops work. The 30-minute countdown restarts with every new strike.">
        <ul className="flex max-w-[68ch] list-disc flex-col gap-2 ps-5">
          <li>Any flash within <strong>10 miles</strong> of a site starts a stop-work alert.</li>
          <li><strong>All clear = the latest strike + 30 minutes.</strong> Each new strike pushes it later.</li>
          <li>The countdown uses <strong>when the lightning struck</strong>, not when our server read the file, so late or out-of-order satellite data can never shorten it.</li>
          <li>The check runs every 20 seconds <strong>even with no lightning</strong>, because the all-clear is triggered by silence.</li>
        </ul>

        <figure className="flex flex-col gap-2">
          <figcaption className="mbe-2 text-xs text-muted">Example: three strikes near one site</figcaption>
          <div className="flex flex-col gap-3">
            {TIMELINE.map((row) => (
              <div key={row.label} className="grid gap-1 sm:grid-cols-[11rem_1fr] sm:items-center sm:gap-3">
                <p className="text-xs text-muted">{row.label}</p>
                <div>
                  <div className="relative h-2 rounded-pill bg-surface-2" aria-hidden="true">
                    <div
                      className={`absolute inset-bs-0 h-2 rounded-pill ${row.kind === "late" ? "outline-[1.5px] -outline-offset-[1.5px] outline-dashed outline-muted" : "bg-risk-red-solid"}`}
                      style={{ left: pct(row.at), width: pct(30) }}
                    />
                    {/* The strike: a dot where the countdown starts. */}
                    <span className={`absolute -inset-bs-1 -ms-2 size-4 rounded-pill border-2 border-surface ${row.kind === "late" ? "bg-muted" : "bg-text"}`} style={{ left: pct(row.at) }} />
                  </div>
                  <p className={`mbs-1 text-xs ${row.kind === "late" ? "text-muted" : "text-risk-red"}`}>{row.note}</p>
                </div>
              </div>
            ))}
            <div className="grid gap-1 sm:grid-cols-[11rem_1fr] sm:items-center sm:gap-3">
              <p className="text-xs font-semibold">Result</p>
              <div>
                <div className="relative h-2 rounded-pill bg-surface-2" aria-hidden="true">
                  <div className="absolute inset-bs-0 h-2 rounded-pill bg-risk-red-solid" style={{ left: 0, width: pct(42) }} />
                  <div className="absolute inset-bs-0 h-2 rounded-pill bg-risk-green-solid" style={{ left: pct(42), width: pct(AXIS_MIN - 42) }} />
                </div>
                <p className="mbs-1 text-xs font-semibold text-risk-green">One continuous stop-work, 6:00 to 6:42. All clear at 6:42.</p>
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
        <div className="grid gap-4 sm:grid-cols-3" role="list" aria-label="Risk bands">
          {BAND_EXAMPLES.map((score) => {
            const band = BAND_STYLE[riskLevel(score)];
            return (
              <div key={score} role="listitem" className="flex flex-col">
                <p className={`flex items-center gap-1.5 text-xs font-semibold ${band.text}`}><span aria-hidden="true" className={`pc-shape ${band.shape}`} />{band.label}</p>
                <p className="text-xl font-semibold">{band.range}</p>
              </div>
            );
          })}
        </div>

        <h3 className="text-xl font-semibold">A hybrid: the highest risk wins</h3>
        <ol className="flex max-w-[68ch] list-decimal flex-col gap-2 ps-5">
          <li><strong>The model learns storms and floods</strong> from the forecast, turning its estimated probability into a 0–10 weather score. An index of 7 does not mean a 70% chance.</li>
          <li><strong>Take the highest score</strong> from the model, OSHA heat-index bands, wildfire detections, wildlife and crew reports. A mild forecast can never average away dangerous heat or a reported hazard.</li>
          <li><strong>Official NWS warnings set minimum scores:</strong> at least 9 for a Hurricane Warning, 7 for other supported warnings, and 4 for watches or advisories. Floors only raise a lower score. A nearby downed-line report also sets today&apos;s minimum to 7; our flood-risk alert sets it to 4.</li>
          <li><strong>Lightning stop-work overrides today&apos;s index to at least 9.0.</strong> The stop-work engine runs independently; no model forecast can shorten or clear its wait.</li>
          <li>Tomorrow uses tomorrow&apos;s forecast, peak heat, and watches or warnings in effect then. Today&apos;s crew-report floors, advisories and lightning stop-work do not carry over. If the model cannot score, safety rules still run.</li>
        </ol>
        {modelInfo && <details>
          <summary className="pc-link list-none">Hybrid rules from the model service</summary>
          <p className="mbs-2 max-w-[68ch] text-muted">{modelInfo.hybrid}</p>
        </details>}
        <ModelExplanation info={modelInfo} />
      </Section>

      <Section id="briefing" title="Next-day briefing" takeaway="Every evening at 6 PM site time, each site gets go, caution or no-go for tomorrow. Fixed rules in code make the call, never the AI writer.">
        <div className="flex flex-col gap-2">
          <h3 className="text-xl font-semibold">No-go only for a named hard stop during work hours</h3>
          <p className="max-w-[68ch] text-muted">Work hours are 7 AM to 5 PM site time. The briefing names the stop and when it applies, for example: “NO-GO for Thursday, Jul 16: Flood Warning 7 AM-3 PM.”</p>
        </div>
        <ul className="flex max-w-[68ch] list-disc flex-col gap-2 ps-5">
          <li><strong>An NWS warning</strong> in effect during work hours: Hurricane, Tropical Storm, Tornado, Flood (including Flash Flood and Coastal Flood), or Excessive or Extreme Heat. A Red Flag Warning counts when a fire is within 10 mi.</li>
          <li><strong>Very high heat:</strong> OSHA&apos;s very high band at the work-hours peak.</li>
          <li><strong>A confirmed fire within 5 mi:</strong> seen on 2 or more satellite passes, or with high confidence. One pass is a reason to check, not to stop.</li>
          <li><strong>A crew report</strong> of a downed line or site flooding in the last 48 hours.</li>
          <li><strong>3 in or more of rain during work hours when both forecasts agree:</strong> our forecast and the NWS forecast must each reach 3 in.</li>
        </ul>
        <div className="flex flex-col gap-2">
          <h3 className="text-xl font-semibold">Everything else is at most caution</h3>
          <p className="max-w-[68ch]">A high hazard index on its own, hazards outside work hours, thunderstorms likely during work hours, any other NWS watch or warning, a fire seen on one satellite pass, heavy rain in only one forecast, or a heat-illness report. Rain that falls mostly after work hours gets a plan-ahead action instead: secure tools and materials, and expect soft ground the next morning.</p>
        </div>
        <p className="max-w-[68ch] text-muted">Claude writes the briefing from the same facts (then Gemini, then a fixed template). Every number and hazard word is checked against the input before it&apos;s sent, and when our rain forecast and the NWS forecast are far apart, the app shows the range instead of the higher one.</p>
      </Section>

      <Section id="limits" title="Limits">
        <ul className="flex flex-col gap-5">
          {[
            { t: "Rainfall is a model estimate.", d: "Open-Meteo rain totals come from weather models, not a rain gauge at the site. Real totals can be higher or lower." },
            { t: "Wildfire depends on satellite passes.", d: "VIIRS satellites see a given spot only a few times a day, so a new fire can burn for hours before it shows up. Hot spots within 1 km of a plant are treated as plant heat and ignored, so a real fire inside that ring would be missed. Without a FIRMS key, wildfire data is off and the card says so." },
            { t: "It predicts hazardous weather days, not injuries.", d: "A high index flags conditions to check; it does not mean someone will get hurt. A low index does not mean a site is safe. It supports a supervisor's judgment; it doesn't replace it." },
            { t: "Lightning positions are approximate.", d: "Satellite pixels are about 8–14 km across, so a strike reported at 9.8 mi could be a little closer or farther. A strike reaches us 20–40 seconds after it happens." },
            { t: "Hazardous days are rare, and exact probabilities are uncertain.", d: "There are few reported events to learn from. The model ranks risky days better than it estimates exact chances; the highest probabilities can be overconfident. Day-ahead probability gains over the baselines are not statistically conclusive." },
            { t: "Reporting bias affects the model.", d: "NOAA records reported events, not every event that happened. Rural sites and nights are under-reported; lightning is usually logged only after damage or injury. Location partly reflects where reports come from, so a low score at a remote site is weaker evidence of a quiet day." },
            { t: "Heat and wildfire cannot be learned reliably from these labels.", d: "Heat reports are too sparse to validate the model's heat predictions, and weather alone captures wildfire poorly without drought or fuel conditions. OSHA heat bands and satellite fire detections supply the safety rules for these hazards." },
          ].map((l) => (
            <li key={l.t} className="max-w-[68ch]">
              <p className="font-semibold">{l.t}</p>
              <p className="text-muted">{l.d}</p>
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
        <ul className="flex max-w-[68ch] list-disc flex-col gap-2 ps-5">
          <li><strong>Why the real pipeline:</strong> it proves the code that protects crews actually works, and it gives exactly the alerts crews would have seen that evening. The alert engine has no clock of its own; it runs on whatever time it&apos;s given.</li>
          <li>Replay alerts are stored separately and <strong>never mix with live ones</strong>. Real lightning keeps being tracked during a replay: real alerts stay on screen next to the replay&apos;s, which are tagged REPLAY.</li>
          <li>After the last file, replay runs 31 quiet simulated minutes so every countdown can finish.</li>
          <li>Heat, rain, fire and wildlife stay live during a replay; only lightning is replayed.</li>
        </ul>
        <p>
          <Link href="/" className="pc-link">Open the dashboard and press Replay storm</Link>
        </p>
      </Section>
    </main>
  );
}
