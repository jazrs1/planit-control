# PlanIT Control: Devpost story (draft)

> Fill in or delete every `TODO` before submitting.

## Inspiration

The Sperry Tech PlanIT Control brief starts with a utility crew in the Everglades. Everything that decides whether they're safe tomorrow already exists: lightning, heat, flood warnings, fires, alligator sightings. But it's scattered across agencies and apps, so go/no-go calls get made on instinct. We wanted one honest screen that turns that data into a clear decision, and that says "we don't know" when it doesn't.

## What it does

PlanIT Control watches **55 real Florida power plants** (EIA-860M), live at **stormsafecrews.us**.

- **Lightning stop-work:** a strike within 10 miles stops work. All clear = 30 minutes after the latest strike, and every new strike restarts the countdown.
- **"Lightning approaching":** a heads-up when a storm is projected to reach a site's 10-mile ring within the hour. It's never a stop-work order.
- **Hazard cards** for heat, lightning, flooding, soil, wildfire and wildlife.
- **A 0–10 hazard index** for today and tomorrow, from an ML model plus safety rules.
- **Crew reports:** a photo pinned to a map, which raises the matching hazard nearby.
- **A 6 PM briefing** per site: go / caution / no-go, risks, actions.
- **Push notifications** for stop-work, approaching lightning, all clear, flood alerts and briefings.
- **A hardware beacon:** an Arduino with red, yellow and green lights, a buzzer, and an LCD stop-work countdown.
- **Replay mode:** a real storm, played through the live system.

## How we built it

- **Lightning:** GOES-19 satellite files every 20 seconds. The stop-work engine runs on *strike time*, so a late file can never shorten a countdown. It uses the time it's given, which makes replay possible.
- **Data:** Open-Meteo, NWS alerts, FEMA flood zones, USGS rivers, NASA FIRMS fires and iNaturalist, stored in **Tiger Data** (TimescaleDB), with hypertables for flashes and readings.
- **The hazard model:** LightGBM trained on archived HRRR forecasts against NOAA Storm Events: did a crew-relevant hazardous event happen within 15 miles, or in the site's NWS zone, that day? Trained on 2022–2023, calibrated on 2024, tested on 2025. The index is the highest of the model, the OSHA heat band, and the wildfire, wildlife and crew-report rules. NWS warnings set floors, and a stop-work holds today at 9 or more.
- **Arrival forecast:** we cluster the last 20 minutes of flashes into storm cells, fit each cell's motion, and project its leading edge toward each site. Advisories live in their own table, so they can't touch a stop-work.
- **Grounded briefings:** Claude writes each briefing from a JSON file of facts. Code checks that every number appears in it, that hazard words match the data, and that the text is under 150 words. Then Claude Haiku rereads it for wrong statements. A rejected draft gets one retry, then Gemini, then a template. The go / no-go call is made in code, never by a model.
- **Push and beacon:** each push is queued after an alert commits, so a failed push can't affect an alert, and each event is sent once. The beacon only shows green when the server says clear.
- **Deployment:** Next.js on Vercel, FastAPI on a Vultr server behind Caddy, and Tiger Data.

## Challenges we ran into

- **Messy real-time data.** Files arrive late or out of order, so the rules are one pure function with an explicit "never shorten" case.
- **Power plants look like wildfires.** We ignore satellite detections within 1 km of our sites or any Florida thermal plant, and we say a real fire there would be missed.
- **Unknown versus zero.** After two minutes offline, every page says "Status unknown", never "All clear".
- **Honest labels.** NOAA reports cluster where people report, so part of the model's skill is location, and the app says so.

## Accomplishments that we're proud of

- Replaying the **August 4, 2025** storm (16,533 flashes in one hour) alerted **21 of 55 sites**. Okeechobee Clean Energy Center **reset 177 times** and cleared exactly 30 minutes after its final strike.
- **The model beats both baselines on 2025**, a year it never saw.
  - PR-AUC is 0.128, against 0.032 for monthly climatology and 0.040 for a rain/heat rule.
  - Red days were 8% of site-days and held 44% of logged hazardous events.
- **On that storm, the forecast warned 8 of 13 stop-works** a median of 10.8 minutes ahead, counting those after a 15-minute warm-up. It's one storm, and we tuned on it.
  - Arrival estimates ran late in 7 of 8, so the app never shows an arrival countdown.
  - 11 of 19 advisories weren't followed by a stop-work.
- **Every alert change is logged** with strike time and processing time, for audits.
- 265 backend tests and 58 frontend tests.

## What we learned

- "When did it happen?" and "When did we hear about it?" are different questions, and mixing them up is a safety bug.
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
