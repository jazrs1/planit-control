# PlanIT Control: Devpost story (draft)

> Fill in or delete every `TODO` before submitting.

## Inspiration

Sperry Tech's PlanIT Control brief starts with a utility crew in the Everglades. Everything that decides whether they're safe tomorrow already exists: lightning, heat, flood warnings, fires, alligator sightings. But it's scattered across agencies and apps, so go/no-go calls get made on instinct. We wanted one honest screen that turns that data into a clear decision and says "we don't know" when it doesn't.

## What it does

PlanIT Control watches **55 real Florida power plants** (EIA-860M), live at **stormsafecrews.us**, with hazard cards for heat, lightning, flooding, soil, wildfire and wildlife.

- **Lightning stop-work:** a strike within 10 miles stops work. All clear = 30 minutes after the latest strike; every new strike restarts the countdown.
- **"Lightning approaching":** a heads-up when a storm is projected to reach a site's 10-mile ring within the hour.
- **A 0–10 hazard index** for today and tomorrow, from an ML model plus safety rules.
- **Crew reports:** a photo pinned to a map, which raises the matching hazard nearby.
- **A 6 PM briefing** per site: go / caution / no-go, risks, actions.
- **Push notifications** for stop-work, approaching lightning, all clear, flood and briefings.
- **A hardware beacon:** red, yellow and green lights, a buzzer and an LCD stop-work countdown.
- **Replay mode:** a real storm, played through the live system.

## How we built it

- **Lightning:** GOES-19 satellite files every 20 seconds. The stop-work engine runs on *strike time* and uses the time it's given, which makes replay possible.
- **Data:** Open-Meteo, NWS alerts, FEMA flood zones, USGS rivers, NASA FIRMS fires and iNaturalist, in **Tiger Data** (TimescaleDB hypertables for flashes and readings).
- **The hazard model:** LightGBM on archived HRRR forecasts, predicting whether NOAA Storm Events logs a crew-relevant hazard within 15 miles (or in the site's NWS zone) that day. Trained on 2022–2023, calibrated on 2024, tested on 2025. The index is the highest of the model, the OSHA heat band, and the wildfire, wildlife and crew-report rules; NWS warnings set floors, and a stop-work holds today at 9 or more.
- **Arrival forecast:** storm cells from the last 20 minutes of flashes are tracked and projected toward each site. Advisories live in their own table, so they can't touch a stop-work.
- **Grounded briefings:** Claude writes each briefing from a JSON file of facts. Code checks every number and hazard word against it and keeps the text under 150 words; then Claude Haiku rereads it. A rejected draft gets one retry, then Gemini, then a template. The go / no-go call is made in code, never by a model.
- **Push and beacon:** pushes are queued after each alert commits and sent once per event; the beacon shows green only when the server says clear.
- **Deployment:** Next.js on Vercel and FastAPI on a Vultr server behind Caddy.

## Challenges we ran into

- **Messy real-time data.** Files arrive late or out of order; one pure function makes sure a late file never shortens a countdown.
- **Power plants look like wildfires.** We ignore detections within 1 km of our sites or any Florida thermal plant, and say a real fire there would be missed.
- **Unknown versus zero.** After two minutes offline, every page says "Status unknown", never "All clear".
- **Honest labels.** NOAA reports cluster where people are, so part of the model's skill is location, and the app says so.

## Accomplishments that we're proud of

- Replaying the **August 4, 2025** storm (16,533 flashes in one hour) alerted **21 of 55 sites**. Okeechobee Clean Energy Center **reset 177 times** and cleared exactly 30 minutes after its final strike.
- **The model beats both baselines on 2025**, a year it never saw.
  - PR-AUC is 0.128, against 0.032 for monthly climatology and 0.040 for a rain/heat rule.
  - Amber starts at 2× an average day's risk, red at 5×. Red days (about 2% of site-days) had a logged event about 1 in 5 times.
  - Amber and red days held 42% of logged events (83% with our first, looser anchors, which colored most sites on an ordinary day); 58% fell on green days, because many Florida storms form with little warning. The index plans the day; the lightning engine and NWS warnings protect the crew.
- **On that storm, the forecast warned 8 of 13 stop-works** (after a 15-minute warm-up) a median of 10.8 minutes ahead. It's one storm, and we tuned on it. Arrival estimates ran late in 7 of 8, so the app never shows an arrival countdown, and 11 of 19 advisories weren't followed by a stop-work.
- **Reaction time.** On our production server, real stop-work alerts were saved a median of 35 seconds after the strike (worst 49 s, five stop-works), nearly all of it the GOES-19 satellite's own delivery time; our engine adds about one second. A small sample: one afternoon of storms over southeast Florida.
- 332 backend tests and 83 frontend tests.

## What we learned

- "When did it happen?" and "When did we hear about it?" are different questions; mixing them up is a safety bug.
- A greyed-out "last known" value beats a confident wrong one.
- TODO(John): what you learned.
- TODO(William): what you learned.
- TODO(Abid): what you learned.

## What's next

- Test the forecast on more storms, and retrain the model on more years.
- Add a safety margin to the 10-mile radius: satellite positions are accurate to only 8–14 km.
- Stay honest:
  - Rainfall is a model estimate.
  - Fire detection depends on a few satellite passes a day.
  - The index predicts hazardous weather, not injuries.
  - The forecast misses storms that form overhead.
  - PlanIT supports a supervisor's judgment; it doesn't replace it.
- Pilot with a real crew.
