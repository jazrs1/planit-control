"""Tests for bridge.py's API-response-to-serial-line mapping, using sample API responses.

    cd hardware && python -m unittest test_bridge

Needs pyserial installed (bridge.py imports it), like the bridge itself.
"""

import unittest

import urllib.error
from unittest import mock

import bridge
from bridge import Answer, beacon_line, line_for, replay_speed

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


class GraceTest(unittest.TestCase):
    """A failed or slow poll keeps the last valid answer for GRACE_SECONDS, then UNKNOWN."""

    def answer(self, b, at=100.0, speed=1):
        return Answer(b, NAME, speed, at)

    def test_no_answer_yet_is_unknown(self):
        self.assertEqual(line_for(None, 100.0), "UNKNOWN")

    def test_clear_is_kept_through_failed_polls_then_unknown_after_10_s(self):
        clear = self.answer(beacon("clear", False))
        for later in (0, 3, 6, 9, 10):   # about 3 failed polls in a row
            self.assertEqual(line_for(clear, 100.0 + later), "CLEAR Vandolah Power Station")
        self.assertEqual(line_for(clear, 110.1), "UNKNOWN")   # never clear from an answer older than 10 s

    def test_every_state_goes_unknown_after_the_grace_period(self):
        for state in ("approaching", "flood", "stop"):
            self.assertEqual(line_for(self.answer(beacon(state, False, seconds=900)), 111.0), "UNKNOWN")

    def test_a_held_stop_work_keeps_counting_down_instead_of_restarting(self):
        stop = self.answer(beacon("stop", False, seconds=600))
        self.assertEqual(line_for(stop, 100.0), "STOP 600 Vandolah Power Station")
        self.assertEqual(line_for(stop, 106.0), "STOP 594 Vandolah Power Station")
        self.assertEqual(line_for(self.answer(beacon("stop", False, seconds=4)), 109.0),
                         "STOP 0 Vandolah Power Station")   # never negative

    def test_a_replayed_stop_work_counts_down_at_the_replay_speed(self):
        stop = self.answer(beacon("stop", True, seconds=1471), speed=30)
        self.assertEqual(line_for(stop, 103.0), "STOP 1381 REPLAY Vandolah Power Station x30")
        # A real stop-work during a replay ticks in real seconds.
        real = self.answer(beacon("stop", False, seconds=600), speed=30)
        self.assertEqual(line_for(real, 103.0), "STOP 597 Vandolah Power Station")

    def test_unknown_or_stop_from_the_server_shows_at_once(self):
        # Each valid answer replaces the last one as soon as it arrives, whatever it says.
        self.assertEqual(line_for(self.answer(beacon("unknown", False)), 100.0), "UNKNOWN")
        self.assertEqual(line_for(self.answer(beacon("stop", False, seconds=1800)), 100.0),
                         "STOP 1800 Vandolah Power Station")


class PollTest(unittest.TestCase):
    URL = "https://api.example"

    def poll(self, replies):
        calls = []

        def fake_get_json(url):
            calls.append(url.removeprefix(self.URL))
            reply = replies[url.removeprefix(self.URL)]
            if isinstance(reply, Exception):
                raise reply
            return reply
        with mock.patch.object(bridge, "get_json", fake_get_json):
            result = bridge.poll(self.URL, "vandolah-power-station", {})
        return result, calls

    SITE = {"/sites/vandolah-power-station": {"name": NAME}}

    def test_clear_needs_only_the_beacon_and_name(self):
        (b, name, speed), calls = self.poll({**self.SITE, "/sites/vandolah-power-station/beacon": beacon("clear", False)})
        self.assertEqual((b["state"], name, speed), ("clear", NAME, 1))
        self.assertNotIn("/replay/status", calls)

    def test_replayed_stop_reads_the_speed(self):
        (_, _, speed), _ = self.poll({**self.SITE, "/sites/vandolah-power-station/beacon": beacon("stop", True, 900),
                                      "/replay/status": REPLAY_RUNNING})
        self.assertEqual(speed, 30)

    def test_timeouts_errors_and_odd_replies_raise_so_the_grace_period_applies(self):
        bad = [TimeoutError("timed out"), urllib.error.URLError("no route"), {"state": "purple"}, ["not", "a", "dict"]]
        for reply in bad:
            with self.assertRaises((OSError, ValueError, urllib.error.URLError)):
                self.poll({**self.SITE, "/sites/vandolah-power-station/beacon": reply})


class RunLiveTest(unittest.TestCase):
    """run_live end to end with a fake clock and serial port: one dropped poll on a hotspot doesn't blink."""

    def test_failed_polls_keep_the_last_line_then_unknown(self):
        sent, clock = [], [0.0]
        replies = iter([beacon("clear", False), TimeoutError("timed out"), TimeoutError("timed out"),
                        beacon("clear", False), TimeoutError("timed out"), TimeoutError("timed out"),
                        TimeoutError("timed out"), TimeoutError("timed out")])

        def fake_poll(url, site_id, names):
            reply = next(replies, None)
            if reply is None:
                raise KeyboardInterrupt
            if isinstance(reply, Exception):
                raise reply
            return reply, NAME, 1

        def fake_sleep(seconds):
            clock[0] += seconds

        port = mock.Mock()
        port.send.side_effect = sent.append
        port.read_lines.return_value = []
        with mock.patch.object(bridge, "poll", fake_poll), mock.patch.object(bridge.time, "monotonic", lambda: clock[0]), \
                mock.patch.object(bridge.time, "sleep", fake_sleep), mock.patch.object(bridge, "log"):
            with self.assertRaises(KeyboardInterrupt):
                bridge.run_live(port, "https://api.example", ["vandolah-power-station"])
        clear = "CLEAR Vandolah Power Station"
        # Polls every ~3 s: two failures are covered; after the next good answer, the 4th failure in a row
        # (more than 10 s since it) sends UNKNOWN.
        self.assertEqual(sent, [clear, clear, clear, clear, clear, clear, clear, "UNKNOWN"])

if __name__ == "__main__":
    unittest.main()
