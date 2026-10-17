"""Bridge between the PlanIT Control backend and the Arduino stop-work beacon.

Polls GET {url}/sites/{site_id}/beacon (and GET {url}/replay/status, for the
countdown speed) every 3 seconds and writes one line to the Arduino over USB serial (see beacon/beacon.ino for the line formats). Any network
or parsing error sends UNKNOWN, so the beacon never shows green when unsure.

    python bridge.py http://localhost:8000 okeechobee-clean-energy-center
    python bridge.py --demo            # no backend: CLEAR -> APPR -> STOP 60 s -> CLEAR

Needs only pyserial (pip install pyserial) and the standard library.
"""

from __future__ import annotations

import argparse
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
HTTP_TIMEOUT_SECONDS = 5.0
# USB vendor ids: Arduino (ATmega16U2), WCH CH340 (Elegoo and most clones), FTDI, Silicon Labs.
ARDUINO_VIDS = {0x2341, 0x2A03, 0x1A86, 0x0403, 0x10C4}


def find_port() -> str:
    ports = list(list_ports.comports())
    matches = [p for p in ports if p.vid in ARDUINO_VIDS]
    if len(matches) == 1:
        return matches[0].device
    if not matches and len(ports) == 1:
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

    def send(self, line: str) -> None:
        try:
            if self.conn is None:
                device = self.port or find_port()
                self.conn = serial.Serial(device, BAUD, timeout=1)
                # Opening the port resets the Uno; wait for its self-test to finish.
                time.sleep(3)
                print(f"Connected to {device}")
            self.conn.write((line + "\n").encode("ascii", "replace"))
            self.conn.flush()
        except serial.SerialException as e:
            print(f"Serial error: {e}; retrying", file=sys.stderr)
            if self.conn is not None:
                self.conn.close()
            self.conn = None


def run_live(beacon: Beacon, base_url: str, site_id: str) -> None:
    base_url = base_url.rstrip("/")
    site = urllib.parse.quote(site_id, safe="")
    name: str | None = None
    last = None
    while True:
        started = time.monotonic()
        try:
            if name is None:
                name = lcd_text(get_json(f"{base_url}/sites/{site}")["name"]) or site_id
            speed = replay_speed(get_json(f"{base_url}/replay/status"))
            line = beacon_line(get_json(f"{base_url}/sites/{site}/beacon"), name, speed)
        except (urllib.error.URLError, OSError, ValueError, KeyError, TypeError, AttributeError) as e:
            print(f"Backend error: {e}", file=sys.stderr)
            line = "UNKNOWN"
        beacon.send(line)
        if line != last:
            print(line)
            last = line
        time.sleep(max(0.0, POLL_SECONDS - (time.monotonic() - started)))


def run_demo(beacon: Beacon) -> None:
    name = "Demo Site"
    steps = [("CLEAR", 10), ("APPR", 15), ("STOP", 60), ("CLEAR", 10)]
    while True:
        for state, seconds in steps:
            end = time.monotonic() + seconds
            print(f"{state} for {seconds} s")
            while (left := end - time.monotonic()) > 0:
                beacon.send(f"STOP {round(left)} {name}" if state == "STOP" else f"{state} {name}")
                time.sleep(min(POLL_SECONDS, left))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("url", nargs="?", help="backend URL, e.g. http://localhost:8000")
    parser.add_argument("site_id", nargs="?", help="site id, e.g. okeechobee-clean-energy-center")
    parser.add_argument("--port", help="serial port (e.g. COM3 or /dev/ttyACM0); auto-detected if omitted")
    parser.add_argument("--demo", action="store_true", help="cycle CLEAR -> APPR -> STOP -> CLEAR without a backend")
    args = parser.parse_args()
    if not args.demo and not (args.url and args.site_id):
        parser.error("give a backend URL and a site id, or --demo")

    beacon = Beacon(args.port)
    try:
        if args.demo:
            run_demo(beacon)
        else:
            run_live(beacon, args.url, args.site_id)
    except KeyboardInterrupt:
        beacon.send("UNKNOWN")  # don't leave a stale state on the display


if __name__ == "__main__":
    main()
