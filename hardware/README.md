# Stop-work beacon

A desk-sized alarm for one job site: red / yellow / green lights, a buzzer and a 16×2 LCD driven by an Arduino Uno. A small Python bridge on the laptop polls the backend's `GET /sites/{id}/beacon` every 3 seconds and sends the state to the Arduino over USB.

| State | LEDs | LCD line 2 | Buzzer |
|---|---|---|---|
| Lightning stop-work | red | `STOP WORK mm:ss` (time to all-clear, ticks every second) | 3 short beeps on entry |
| Lightning approaching | yellow | `STORM NEARBY` (no minutes: arrival estimates run late) | 3 short beeps on entry |
| Flood risk | yellow | `FLOOD RISK` | — |
| All clear | green | `ALL CLEAR` | — |
| No data (backend down, bad reply, or nothing from the bridge for 15 s) | blinking yellow | `NO DATA` | — |

Line 1 is the site name (first 16 characters). A stop-work or approaching alert that comes from a **replay** (the beacon endpoint's `replay: true`) shows `REPLAY` before the name, e.g. `REPLAY Osceola G` / `STOP WORK 24:31`, so a demo is never taken for a real alert; LEDs and buzzer are the same. Real alerts show the plain name. Green only appears after the backend explicitly says `clear`. If the countdown reaches 00:00 before the backend confirms the all-clear, the beacon stays red at `STOP WORK 00:00`. A short press of the push button silences the beeps until the state changes. Holding it for **2 seconds** switches to the bridge's next site (when it was started with more than one `--site`): the LCD shows `Switching site` / `NO DATA` until the new site's first update, a moment later, then the new site's name and state.

## Parts (Elegoo Uno R3 kit)

- Arduino Uno R3 + USB cable
- LCD1602 module (parallel, no I2C backpack)
- 10 kΩ potentiometer (LCD contrast)
- Red, yellow and green 5 mm LEDs
- 3 × 220 Ω resistors
- Active buzzer (the one with the sealed top; it beeps on plain 5 V)
- Push button
- Breadboard and jumper wires

## Wiring

| Part | Pin | Arduino |
|---|---|---|
| LCD | VSS (1) | GND |
| LCD | VDD (2) | 5V |
| LCD | V0 (3) | pot wiper (middle leg); pot outer legs to 5V and GND |
| LCD | RS (4) | D7 |
| LCD | RW (5) | GND |
| LCD | E (6) | D8 |
| LCD | D4 (11) | D9 |
| LCD | D5 (12) | D10 |
| LCD | D6 (13) | D11 |
| LCD | D7 (14) | D12 |
| LCD | A (15, backlight +) | 5V (through 220 Ω if your module has no built-in resistor) |
| LCD | K (16, backlight −) | GND |
| Red LED | anode (long leg) | D3 through 220 Ω; cathode to GND |
| Yellow LED | anode | D5 through 220 Ω; cathode to GND |
| Green LED | anode | D6 through 220 Ω; cathode to GND |
| Active buzzer | + (long leg) | D4; − to GND |
| Push button | one side | D2 (`INPUT_PULLUP`, no resistor needed) |
| Push button | other side | GND |

LCD D0–D3 (pins 7–10) stay unconnected.

## Upload the sketch (Arduino IDE)

1. Install the [Arduino IDE](https://www.arduino.cc/en/software) (2.x).
2. Open `hardware/beacon/beacon.ino` (the IDE wants the sketch in a folder of the same name, which it already is).
3. **Tools → Board → Arduino AVR Boards → Arduino Uno.**
4. **Tools → Port →** the Uno's port (`COM3` or similar on Windows, `/dev/ttyACM0` or `/dev/cu.usbmodem…` on Linux/macOS). Elegoo boards with a CH340 chip may need the [CH340 driver](https://www.wch-ic.com/downloads/CH341SER_EXE.html) on Windows.
5. Click **Upload**. `LiquidCrystal` ships with the IDE; nothing else to install.

On power-up the beacon runs a self-test: the LCD shows `PlanIT Control`, red, yellow and green light in turn, and it beeps once. It then blinks yellow with `NO DATA` until the bridge sends something. If the LCD shows only blocks or nothing, turn the contrast pot.

**Close the IDE's Serial Monitor before running the bridge**; only one program can hold the port. For a quick test without the bridge you can type lines into the Serial Monitor (115200 baud, "Newline" line ending), e.g. `STOP 90 Test Site`.

## Run the bridge

```bash
pip install pyserial
cd hardware
```

**Demo mode** (no backend; tests the hardware on its own). Cycles CLEAR (10 s) → APPR (15 s) → STOP with a 60 s countdown → CLEAR (10 s), then repeats:

```bash
python bridge.py --demo
```

**Real mode** (backend running, see the repo `README.md`):

```bash
python bridge.py http://localhost:8000 --site okeechobee-clean-energy-center
python bridge.py https://api.stormsafecrews.us --site osceola-generating-station-fl --site okeechobee-clean-energy-center
```

The site id is the slug from `GET /sites` (e.g. `big-bend`, `vandolah-power-station`). Repeat `--site` to switch between sites with a long press; the bridge starts on the first one. The older form `python bridge.py URL SITE_ID` still works. The bridge only reads public GET endpoints; it never needs `ADMIN_TOKEN` or any other secret. The port is auto-detected (on Linux, the one `/dev/ttyACM*` or `/dev/ttyUSB*`); if you have several serial devices, pass it: `--port COM5` or `--port /dev/ttyACM0`. Opening the port resets the Uno, so the bridge waits 3 seconds before its first line. A network error, HTTP error, timeout or unexpected reply keeps sending the last valid answer (a stop-work keeps counting down) for up to 10 seconds, about 3 polls, so one dropped request on a phone hotspot doesn't blink `NO DATA`; with no valid answer for longer than that it sends `UNKNOWN`. Whatever the server answers, including `unknown` or `stop`, is sent at once. If the USB cable is pulled or the network drops, the bridge keeps retrying (logging each problem once, not on every retry) and recovers on its own. Ctrl+C sends `UNKNOWN` before exiting so the beacon doesn't keep showing a stale state.

Tests (sample API responses → serial lines; needs pyserial): `cd hardware && python -m unittest test_bridge`.

### Serial protocol

One line per message, `\n`-terminated, 115200 baud:

```
STOP <seconds_until_all_clear> <site name> [x<speed>]
APPR <site name>
FLOOD <site name>
CLEAR <site name>
UNKNOWN
```

`<seconds_until_all_clear>` may be `-` if the backend doesn't know it; the beacon then shows `STOP WORK` with no time. The optional `x<speed>` (e.g. `x30`) is sent only while a replay runs: the countdown is then in simulated seconds, so the beacon counts down that many seconds per real second and resyncs on every line. Without it the countdown runs in real time, so plain `STOP <seconds> <site name>` still works. Anything it can't parse counts as `UNKNOWN`.

The beacon sends one line back: `SITE` when the button is held for 2 seconds.

## Raspberry Pi setup

A Raspberry Pi (Raspberry Pi OS Lite, 64-bit) can run the bridge instead of a laptop, with the Uno plugged into one of its USB ports. `pi/install.sh` installs `python3-serial` with apt, adds the user to the `dialout` group (serial port access), copies `bridge.py` to `/opt/planit-beacon/`, and enables `pi/planit-beacon.service`, which starts the bridge at boot and restarts it if it exits. The service watches Osceola and Okeechobee on `https://api.stormsafecrews.us`; edit `ExecStart` in the service file to change the backend or sites. Nothing secret goes on the Pi.

From the repo root on your laptop:

```bash
ssh planit@planit-beacon.local mkdir -p planit-beacon
scp hardware/bridge.py hardware/pi/install.sh hardware/pi/planit-beacon.service planit@planit-beacon.local:planit-beacon/
ssh planit@planit-beacon.local sh planit-beacon/install.sh
```

Check it:

```bash
ssh planit@planit-beacon.local systemctl status planit-beacon
ssh planit@planit-beacon.local journalctl -u planit-beacon -f
```

To update the bridge later, copy the files and run `install.sh` again. The beacon comes back on its own after the Pi loses power, about a minute after it's plugged back in. It always starts on the first site.

## Judge demo: Aug 4, 2025 storm replay

Before the demo, download the storm once: `cd backend && python -m scripts.find_replay_window`. The replay plays one real hour (6–7 PM Eastern, 22:00–23:00 UTC) at 30× speed, so the whole storm takes about 2 minutes. The bridge reads the speed from `GET /replay/status`, so the beacon's countdown runs at the same 30× and stays in step with the dashboard.

Start the backend and frontend (repo `README.md`) and plug in the beacon. To start a replay, click **⚡ Replay storm** on the dashboard (http://localhost:3000; it asks for the demo code, `ADMIN_TOKEN` in `backend/.env`), or:

```bash
curl -X POST localhost:8000/replay/start -H "X-Admin-Token: $ADMIN_TOKEN" -H "content-type: application/json" -d '{"speed": 30}'
```

Stop it with the dashboard button or `curl -X POST localhost:8000/replay/stop -H "X-Admin-Token: $ADMIN_TOKEN"`; the beacon goes back to the live state. During a replay the backend combines the real and replayed state for the site and the higher one wins (stop > unknown > approaching > flood > clear), so a real stop-work, storm warning or flood alert still shows. The beacon's `replay` field says whose alert it is: only a replayed stop-work ticks at the replay speed, and only replayed stop-work and approaching alerts get the `REPLAY` label on line 1. If a real and a replayed stop-work overlap, the real one is shown. On a backend with `LIGHTNING_INGEST_ENABLED=false` the replay's yellow and green show normally; with ingestion on but stalled, the beacon shows `NO DATA` instead.

### 1. Yellow, then red: Osceola Generating Station

```bash
python bridge.py http://localhost:8000 --site osceola-generating-station-fl --site okeechobee-clean-energy-center
```

1. The beacon shows green `ALL CLEAR` (assuming no live storm right now). During the replay, line 1 reads `REPLAY Osceola G` whenever the yellow or red comes from the replay.
2. Start the replay. About 21 seconds in (6:10:40 PM simulated), it turns **yellow**, `STORM NEARBY`, with three beeps: the storm forecast spotted the cell heading for Osceola, then 33.7 mi away, 16 simulated minutes before it hit. (No minutes are shown on purpose: arrival estimates run late.)
3. About 53 seconds in (6:26:40 PM simulated), a strike 8.8 mi away starts the stop-work: **red**, three beeps, `STOP WORK` from about 30:00, counting down. Press the button to silence the beeps. Its all clear comes only at about 3:00, as the replay ends.

The forecast needs some minutes of lightning before it tracks a cell (Osceola's warning came 10:40 into the hour), so only sites hit after that can get a warning. NOAA Storm Events logged a tornado about 11 mi from Osceola that day (`docs/ml-model.md`). Northside Generating Station (`northside-generating-station`, 26 min warning) also works.

### 2. The countdown that resets: Okeechobee Clean Energy Center

Hold the beacon's button for 2 seconds to switch to Okeechobee (or start the bridge with `--site okeechobee-clean-energy-center`).

Okeechobee was the busiest site of the storm. Its first strike within 10 miles comes 9 seconds into the hour, so it goes **red** almost as soon as the replay starts (too early for a yellow warning). Every new strike pushes the all-clear back to 30 minutes after it, and Okeechobee had 177 of those resets, so you can watch the countdown tick down at 30× and jump back up to about `30:00` again and again. It stays red for the rest of the hour.

You can run part 2 in the same replay: once Osceola is red, hold the button to switch to Okeechobee. Or stop and restart the replay to watch Okeechobee from the start.
