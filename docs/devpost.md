# PlanIT Control: Devpost story (draft)

> Fill in or delete every `TODO` before submitting. Numbers come from `docs/alert-engine.md` and the code on `main`.

## Inspiration

The Sperry Tech PlanIT Control brief starts with a utility crew in the Everglades. Everything that decides whether they're safe tomorrow already exists: lightning, heat, flood warnings, fires, alligator sightings. But it's scattered across agencies and apps, so go/no-go calls get made on instinct. We wanted one honest screen that turns that data into a clear decision, and that says "we don't know" when it doesn't.

## What it does

PlanIT Control watches **55 real Florida power plants** from the EIA-860M inventory.

- **Lightning stop-work:** a strike within 10 miles stops work. All clear = 30 minutes after the latest strike, and every new strike restarts the countdown.
- **Hazard cards** for heat, lightning, flooding, soil, wildfire and wildlife, each with an "as of" time.
- **A 0–10 hazard index** for today and tomorrow, in green, amber and red bands.
- **Crew reports:** a photo pinned to a map, which raises the matching hazard nearby.
- **A 6 PM briefing** per site: go / caution / no-go, top risks, actions.
- **Replay mode:** a real storm, played through the live system.

## How we built it

- **Satellite lightning:** GOES-19 Geostationary Lightning Mapper files every 20 seconds, keeping every flash over Florida.
- **The stop-work engine** runs on *strike time*, not processing time, so a late satellite file can never shorten a countdown. It has no clock of its own: it uses the time it's given, which is what makes replay possible. It also checks for expired countdowns every cycle, because the all-clear is triggered by silence.
- **Real data sources:** Open-Meteo (hourly), NWS alerts (every 5 min), FEMA flood zones and USGS rivers, NASA FIRMS fires (every 30 min), iNaturalist wildlife (every 6 h).
- **Tiger Data (TimescaleDB):** flashes, readings and fire detections live in hypertables. A continuous aggregate counts each site's flashes within 10 miles in 5-minute buckets, so "strikes in the last 30 minutes" is one small read.
- **The hazard model:** TODO(ML owner): describe the model trained on archived forecasts against NOAA Storm Events, matching docs/ml-model.md. Until it ships, the index is a transparent rule-based score behind the same `predict()` function the model replaces.
- **Grounded briefings:** Claude writes each briefing from a JSON file of facts. Every number must appear in that JSON, hazard words must match the data, and the text must stay under 150 words. A rejected draft gets one retry, then we fall back to Gemini, then to a template. The go / caution / no-go call is made in code, never by the model.
- **Replay mode** feeds a recorded storm's satellite files through the same ingestion code on a simulated clock at 30–60× speed. Replay alerts never mix with live ones.

## Challenges we ran into

- **Messy real-time data.** Files arrive late or out of order. We wrote the rules as one pure function with an explicit "never shorten" case, and a test that fails if that case is removed.
- **Power plants look like wildfires.** Satellites flag hot stacks as fires, so we ignore detections within 1 km of our sites. That means a real fire inside that ring would be missed, and we say so.
- **Unknown versus zero.** Early versions showed sample data when the server was down. Now missing data looks missing, and after two minutes offline every page says "Status unknown · don't treat any site as clear".
- **Keeping a language model honest.** Drafts sounded right and weren't, so we built the grounding check.

## Accomplishments that we're proud of

- Replaying the **August 4, 2025** storm (16,533 flashes in one hour) alerted **21 of 55 sites**. Okeechobee Clean Energy Center **reset 177 times** and cleared exactly 30 minutes after its final strike: one continuous stop-work of nearly 90 minutes.
- Every alert change is logged with both strike time and processing time, so it can be audited.
- Live public data everywhere, and a UI that never passes off a placeholder as real.
- 69 backend tests (the engine's real SQL, in rolled-back transactions) and 18 frontend tests.
- TODO(ML owner): final test-year results vs. baselines.

## What we learned

- "When did it happen?" and "When did we hear about it?" are different questions in real-time safety, and mixing them up is a safety bug.
- A greyed-out "last known" value is more useful than a confident wrong one.
- TODO(John): what you learned.
- TODO(William): what you learned.
- TODO(Abid): what you learned.

## What's next

- Ship the ML model and publish its calibration (TODO(ML owner): link docs/ml-model.md).
- Push alerts to crews' phones.
- Add a safety margin to the 10-mile radius. Satellite lightning positions are only accurate to about 8–14 km.
- Be honest about the rest. Rainfall is a model estimate, not a site gauge. Wildfire detection depends on a few satellite passes a day. The index predicts hazardous weather days, not injuries. PlanIT supports a supervisor's judgment; it doesn't replace it.
- Pilot with a real crew.
