"""Tests for bridge.py's API-response-to-serial-line mapping, using sample API responses.

    cd hardware && python -m unittest test_bridge

Needs pyserial installed (bridge.py imports it), like the bridge itself.
"""

import unittest

from bridge import beacon_line, replay_speed

NAME = "Vandolah Power Station"

# Sample GET /replay/status responses (ReplayStatus in shared/types.ts).
REPLAY_RUNNING = {"running": True, "window": "2025-08-04_2200-2300", "speed": 30,
                  "simulated_now": "2025-08-04T22:34:10Z", "files_total": 180, "files_done": 102,
                  "flashes_ingested": 9120}
REPLAY_OFF = {"running": False, "window": None, "speed": None, "simulated_now": None,
              "files_total": 0, "files_done": 0, "flashes_ingested": 0}


def beacon(state, replay, seconds=None, minutes=None):
    """A sample GET /sites/{id}/beacon response (Beacon in shared/types.ts)."""
    return {"site_id": "vandolah-power-station", "state": state, "seconds_to_all_clear": seconds,
            "minutes_to_arrival": minutes, "as_of": "2025-08-04T22:34:10Z", "replay": replay}


class ReplayLabelTest(unittest.TestCase):
    def line(self, b, status):
        return beacon_line(b, NAME, replay_speed(status))

    def test_replay_stop_is_labeled_and_ticks_at_replay_speed(self):
        self.assertEqual(self.line(beacon("stop", True, seconds=1471), REPLAY_RUNNING),
                         "STOP 1471 REPLAY Vandolah Power Station x30")

    def test_replay_approach_is_labeled(self):
        self.assertEqual(self.line(beacon("approaching", True, minutes=12), REPLAY_RUNNING),
                         "APPR REPLAY Vandolah Power Station")

    def test_real_stop_during_a_replay_is_not_labeled_and_ticks_in_real_time(self):
        # The backend returns the real stop-work when both exist (replay: false).
        self.assertEqual(self.line(beacon("stop", False, seconds=600), REPLAY_RUNNING),
                         "STOP 600 Vandolah Power Station")

    def test_real_approach_during_a_replay_is_not_labeled(self):
        self.assertEqual(self.line(beacon("approaching", False, minutes=20), REPLAY_RUNNING),
                         "APPR Vandolah Power Station")

    def test_live_alerts_are_not_labeled(self):
        self.assertEqual(self.line(beacon("stop", False, seconds=1800), REPLAY_OFF),
                         "STOP 1800 Vandolah Power Station")
        self.assertEqual(self.line(beacon("approaching", False, minutes=8), REPLAY_OFF),
                         "APPR Vandolah Power Station")

    def test_clear_flood_and_unknown_are_never_labeled(self):
        self.assertEqual(self.line(beacon("clear", True), REPLAY_RUNNING), "CLEAR Vandolah Power Station")
        self.assertEqual(self.line(beacon("flood", False), REPLAY_RUNNING), "FLOOD Vandolah Power Station")
        self.assertEqual(self.line(beacon("unknown", True), REPLAY_RUNNING), "UNKNOWN")

    def test_backend_without_replay_field_is_not_labeled(self):
        old = beacon("stop", None, seconds=900)
        del old["replay"]
        self.assertEqual(self.line(old, REPLAY_OFF), "STOP 900 Vandolah Power Station")

    def test_label_fits_the_lcd_after_the_sketch_cuts_it(self):
        line = self.line(beacon("approaching", True, minutes=5), REPLAY_RUNNING)
        self.assertEqual(line.split(" ", 1)[1][:16], "REPLAY Vandolah ")


if __name__ == "__main__":
    unittest.main()
