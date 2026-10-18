"""Bridge between the PlanIT Control backend and the Arduino stop-work beacon.

Polls GET {url}/sites/{site_id}/beacon (and GET {url}/replay/status, for the
countdown speed) every 3 seconds and writes one line to the Arduino over USB
serial (see beacon/beacon.ino for the line formats). A failed or slow poll
(e.g. a phone hotspot dropping a request) keeps sending the last valid answer,
counting a stop-work down from when it was received; after GRACE_SECONDS with
no valid answer the bridge sends UNKNOWN, so the beacon never shows green (or
any state) from an answer older than that. Whatever the server says, including
unknown or stop, is shown at once. Only public GET endpoints are used: the
bridge needs no token or other secret.

    python bridge.py https://api.stormsafecrews.us --site vandolah-power-station
    python bridge.py http://localhost:8000 --site vandolah-power-station --site okeechobee-clean-energy-center
    python bridge.py --demo            # no backend: CLEAR -> APPR -> STOP 60 s -> CLEAR

With more than one --site, holding the beacon's button for 2 seconds switches
to the next one. Needs only pyserial (pip install pyserial, or apt install
python3-serial) and the standard library.
"""

from __future__ import annotations

import argparse
import dataclasses
import glob
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import serial
from serial.tools import list_ports

BAUD = 115200
POLL_SECONDS = 3.0
# Per request. A poll makes at most 3 requests (the site name once, the beacon, the replay speed only for a
# replayed stop-work), so even a slow poll resends a line well inside the sketch's 15 s NO DATA timeout.
HTTP_TIMEOUT_SECONDS = 3.0
# How long the last valid answer is still shown while polls fail (about 3 polls in a row), then UNKNOWN.
GRACE_SECONDS = 10.0
BEACON_STATES = ("stop", "approaching", "flood", "clear", "unknown")
# USB vendor ids: Arduino (ATmega16U2), WCH CH340 (Elegoo and most clones), FTDI, Silicon Labs.
ARDUINO_VIDS = {0x2341, 0x2A03, 0x1A86, 0x0403, 0x10C4}
# What the beacon sends back when its button is held for 2 seconds.
NEXT_SITE_LINE = "SITE"


def log(message: str) -> None:
    print(message, flush=True)


def find_port() -> str:
    ports = list(list_ports.comports())
    matches = [p.device for p in ports if p.vid in ARDUINO_VIDS]
    if len(matches) == 1:
        return matches[0]
    # Linux: the Uno is /dev/ttyACM* (ATmega16U2) or /dev/ttyUSB* (CH340); the Pi's own UARTs aren't.
    usb = sorted(glob.glob("/dev/ttyACM*") + glob.glob("/dev/ttyUSB*"))
    if len(usb) == 1:
        return usb[0]
    if not matches and not usb and len(ports) == 1:
        return ports[0].device
    found = ", ".join(f"{p.device} ({p.description})" for p in ports) or "none"
    raise serial.SerialException(f"couldn't pick the Arduino's port automatically (ports: {found}); pass --port")


def lcd_text(name: str) -> str:
    """The LCD only has ASCII; replace anything else."""
    return "".join(c if 32 <= ord(c) <= 126 else "?" for c in name).strip()


def get_json(url: str):
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SECONDS) as resp:
        return json.load(resp)


def replay_speed(status: dict) -> int:
    """Simulated seconds per real second from a ReplayStatus (shared/types.ts); 1 when live."""
    speed = status.get("speed")
    if not status.get("running") or not isinstance(speed, (int, float)):
        return 1
    return max(1, round(speed))


def beacon_line(beacon: dict, name: str, speed: int = 1) -> str:
    """Turns a Beacon (shared/types.ts) into one serial line."""
    state = beacon.get("state")
    if state in ("stop", "approaching") and beacon.get("replay") is True:
        # Mark a replayed alert on line 1 (the sketch cuts it to 16 characters), so nobody takes a
        # demo for a real one. The backend already prefers a real stop-work over a replayed one.
        name = f"REPLAY {name}"
    if state == "stop":
        secs = beacon.get("seconds_to_all_clear")
        # No countdown known: "-" makes the beacon show STOP WORK without a time.
        count = str(max(0, int(secs))) if isinstance(secs, (int, float)) else "-"
        # A replay's countdown is in simulated seconds; " x<speed>" tells the beacon how fast to tick
        # between updates. A real stop-work during a replay (replay: false) counts in real seconds.
        replayed = beacon.get("replay", True)   # backends before the field existed: replay state only
        return f"STOP {count} {name}" + (f" x{speed}" if speed > 1 and replayed else "")
    if state == "approaching":
        # minutes_to_arrival is deliberately not sent: arrival estimates run late.
        return f"APPR {name}"
    if state == "flood":
        return f"FLOOD {name}"
    if state == "clear":
        return f"CLEAR {name}"
    return "UNKNOWN"


class Beacon:
    """The serial connection; reopens itself if the USB cable is unplugged."""

    def __init__(self, port: str | None):
        self.port = port
        self.conn: serial.Serial | None = None
        self.error: str | None = None   # logged once per outage, not on every retry
        self.pending = b""

    def _connect(self) -> serial.Serial:
        if self.conn is None:
            device = self.port or find_port()
            self.conn = serial.Serial(device, BAUD, timeout=0)
            # Opening the port resets the Uno; wait for its self-test to finish.
            time.sleep(3)
            self.conn.reset_input_buffer()
            self.pending = b""
            log(f"Connected to {device}")
            self.error = None
        return self.conn

    def _failed(self, e: Exception) -> None:
        if str(e) != self.error:
            log(f"Serial error: {e}; retrying")
            self.error = str(e)
        if self.conn is not None:
            try:
                self.conn.close()
            except (serial.SerialException, OSError):
                pass
        self.conn = None

    def send(self, line: str) -> None:
        try:
            conn = self._connect()
            conn.write((line + "\n").encode("ascii", "replace"))
            conn.flush()
        except (serial.SerialException, OSError) as e:
            self._failed(e)

    def read_lines(self) -> list[str]:
        """Lines the beacon sent (without blocking); empty while disconnected."""
        if self.conn is None:
            return []
        try:
            waiting = self.conn.in_waiting
            if waiting:
                self.pending += self.conn.read(waiting)
        except (serial.SerialException, OSError) as e:
            self._failed(e)
            return []
        *lines, self.pending = self.pending.split(b"\n")
        return [raw.decode("ascii", "replace").strip() for raw in lines]


@dataclasses.dataclass
class Answer:
    """The last valid answer from the backend, and when it arrived (time.monotonic())."""
    beacon: dict
    name: str
    speed: int
    at: float


def poll(base_url: str, site_id: str, names: dict[str, str]) -> tuple[dict, str, int]:
    """One poll: (Beacon, LCD name, replay speed). Raises on any network, HTTP or format problem."""
    site = urllib.parse.quote(site_id, safe="")
    if site_id not in names:
        names[site_id] = lcd_text(get_json(f"{base_url}/sites/{site}")["name"]) or site_id
    beacon = get_json(f"{base_url}/sites/{site}/beacon")
    if not isinstance(beacon, dict) or beacon.get("state") not in BEACON_STATES:
        raise ValueError(f"unexpected beacon reply: {str(beacon)[:80]}")
    speed = 1
    if beacon["state"] == "stop" and beacon.get("replay", True):
        # Only a replayed stop-work ticks at the replay speed (beacon_line), so only then is it needed.
        speed = replay_speed(get_json(f"{base_url}/replay/status"))
    return beacon, names[site_id], speed


def line_for(answer: Answer | None, now: float) -> str:
    """The line to send at `now`: the last valid answer while it's at most GRACE_SECONDS old, else UNKNOWN.
    A stop-work's seconds are counted down from when the answer arrived (at the replay speed when the
    beacon ticks at it), so resending it never pushes the beacon's countdown back."""
    if answer is None or now - answer.at > GRACE_SECONDS:
        return "UNKNOWN"
    beacon = answer.beacon
    secs = beacon.get("seconds_to_all_clear")
    if beacon.get("state") == "stop" and isinstance(secs, (int, float)) and now > answer.at:
        rate = answer.speed if answer.speed > 1 and beacon.get("replay", True) else 1
        beacon = {**beacon, "seconds_to_all_clear": max(0, secs - (now - answer.at) * rate)}
    return beacon_line(beacon, answer.name, answer.speed)


def run_live(beacon: Beacon, base_url: str, site_ids: list[str]) -> None:
    base_url = base_url.rstrip("/")
    names: dict[str, str] = {}
    index = 0
    answer: Answer | None = None
    last_state = last_error = None
    log(f"Watching {site_ids[index]}")
    while True:
        site_id = site_ids[index]
        try:
            answer = Answer(*poll(base_url, site_id, names), at=time.monotonic())
            last_error = None
        except (urllib.error.URLError, OSError, ValueError, KeyError, TypeError, AttributeError) as e:
            if str(e) != last_error:
                log(f"Backend error: {e}; keeping the last answer for up to {GRACE_SECONDS:.0f} s, then UNKNOWN")
                last_error = str(e)
        line = line_for(answer, time.monotonic())
        beacon.send(line)
        state = (site_id, line.split(" ")[0])   # log state changes, not every countdown tick
        if state != last_state:
            log(f"{site_id}: {line}")
            last_state = state

        # Wait for the next poll, listening for a long press on the beacon's button.
        next_poll = time.monotonic() + POLL_SECONDS
        while time.monotonic() < next_poll:
            if NEXT_SITE_LINE in beacon.read_lines():
                if len(site_ids) > 1:
                    index = (index + 1) % len(site_ids)
                    answer = None   # the old site's answer must never show for the new one
                    log(f"Button: switching to {site_ids[index]}")
                    break   # poll the new site right away
                log("Button: only one --site given, nothing to switch to")
            time.sleep(0.1)


def run_demo(beacon: Beacon) -> None:
    name = "Demo Site"
    steps = [("CLEAR", 10), ("APPR", 15), ("STOP", 60), ("CLEAR", 10)]
    while True:
        for state, seconds in steps:
            end = time.monotonic() + seconds
            log(f"{state} for {seconds} s")
            while (left := end - time.monotonic()) > 0:
                beacon.send(f"STOP {round(left)} {name}" if state == "STOP" else f"{state} {name}")
                time.sleep(min(POLL_SECONDS, left))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("url", nargs="?", help="backend URL, e.g. https://api.stormsafecrews.us")
    parser.add_argument("site_id", nargs="?", help=argparse.SUPPRESS)   # older form: bridge.py URL SITE_ID
    parser.add_argument("--site", action="append", default=[], metavar="SITE_ID",
                        help="site id, e.g. vandolah-power-station; repeat it to switch sites with a long press")
    parser.add_argument("--port", help="serial port (e.g. COM3 or /dev/ttyACM0); auto-detected if omitted")
    parser.add_argument("--demo", action="store_true", help="cycle CLEAR -> APPR -> STOP -> CLEAR without a backend")
    args = parser.parse_args()
    site_ids = ([args.site_id] if args.site_id else []) + args.site
    if not args.demo and not (args.url and site_ids):
        parser.error("give a backend URL and --site SITE_ID, or --demo")

    beacon = Beacon(args.port)
    try:
        if args.demo:
            run_demo(beacon)
        else:
            run_live(beacon, args.url, site_ids)
    except KeyboardInterrupt:
        beacon.send("UNKNOWN")  # don't leave a stale state on the display


if __name__ == "__main__":
    main()
