"""Rescore every site now, so today's and tomorrow's stored scores use the current index anchors, factor
rules and hybrid rules right away instead of after the next hourly weather poll.

On the server, after deploying (the restart also empties the API's in-process cache):

    cd /opt/planit/app/backend && sudo -u planit -H /opt/planit/venv/bin/python -m scripts.rescore_today \\
      && systemctl restart planit-api

By default it runs the hourly job's own weather step (hazards/scheduler._weather): one Open-Meteo request
per site (55), then the hazard model scores every site from those forecasts, so the stored model factors
are recomputed too. --stored skips the weather calls and re-combines the stored model probabilities
(re-mapped to the current anchors) with the current rules; stored model factors are kept as they are.
"""

import argparse
from collections import Counter
from datetime import datetime, timezone

from app.db import close_pool, get_pool, open_pool
from hazards import model_scores, scheduler, snapshot
from hazards.risk import predict


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--stored", action="store_true", help="no weather calls: re-combine stored model scores")
    args = parser.parse_args()
    open_pool()
    try:
        now = datetime.now(timezone.utc)
        if args.stored:
            print(f"Stored {model_scores.store_run(get_pool(), now, fresh={})} hazard scores (stored model parts)")
        else:
            print(scheduler._weather(get_pool(), now))
        snap = snapshot.load(get_pool(), replay=False)
        today = [predict(snap.inputs[s["id"]], snap.species_counts[s["id"]])["hazard_index_today"] for s in snap.sites]
        bins = Counter("0-2" if x < 2 else "2-4" if x < 4 else "4-6" if x < 6 else "6-8" if x < 8 else "8-10" for x in today)
        print(f"Today's index across {len(today)} sites at {now:%Y-%m-%d %H:%M} UTC: "
              + ", ".join(f"{k}: {bins.get(k, 0)}" for k in ("0-2", "2-4", "4-6", "6-8", "8-10")))
    finally:
        close_pool()


if __name__ == "__main__":
    main()
