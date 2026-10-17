# Stop-work beacon

A desk-sized alarm for one job site: red / yellow / green lights, a buzzer and a 16×2 LCD driven by an Arduino Uno. A small Python bridge on the laptop polls the backend's `GET /sites/{id}/beacon` every 3 seconds and sends the state to the Arduino over USB.

| State | LEDs | LCD line 2 | Buzzer |
|---|---|---|---|
| Lightning stop-work | red | `STOP WORK mm:ss` (time to all-clear, ticks every second) | 3 short beeps on entry |
| Lightning approaching | yellow | `STORM NEARBY` (no minutes: arrival estimates run late) | 3 short beeps on entry |
| Flood risk | yellow | `FLOOD RISK` | — |
| All clear | green | `ALL CLEAR` | — |
| No data (backend down, bad reply, or nothing from the bridge for 15 s) | blinking yellow | `NO DATA` | — |

Line 1 is the site name (first 16 characters). Green only appears after the backend explicitly says `clear`. If the countdown reaches 00:00 before the backend confirms the all-clear, the beacon stays red at `STOP WORK 00:00`. The push button silences the beeps until the state changes.

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
python bridge.py http://localhost:8000 okeechobee-clean-energy-center
```

The site id is the slug from `GET /sites` (e.g. `big-bend`, `vandolah-power-station`). The port is auto-detected; if you have several serial devices, pass it: `--port COM5` or `--port /dev/ttyACM0`. Opening the port resets the Uno, so the bridge waits 3 seconds before its first line. Any network error, HTTP error or unexpected reply sends `UNKNOWN`. If the USB cable is pulled, the bridge keeps retrying until it's plugged back in. Ctrl+C sends `UNKNOWN` before exiting so the beacon doesn't keep showing a stale state.

### Serial protocol

One line per message, `\n`-terminated, 115200 baud:

```
STOP <seconds_until_all_clear> <site name>
APPR <site name>
FLOOD <site name>
CLEAR <site name>
UNKNOWN
```

`<seconds_until_all_clear>` may be `-` if the backend doesn't know it; the beacon then shows `STOP WORK` with no time. Anything it can't parse counts as `UNKNOWN`.

## Judge demo: Aug 4, 2025 storm replay

Before the demo, download the storm once: `cd backend && python -m scripts.find_replay_window`. The replay plays one real hour (6–7 PM Eastern, 22:00–23:00 UTC) at 30× speed, so the whole storm takes about 2 minutes.

1. Start the backend and frontend (repo `README.md`), plug in the beacon, and point the bridge at a site:

   ```bash
   python bridge.py http://localhost:8000 okeechobee-clean-energy-center
   ```

   The beacon shows green `ALL CLEAR` (assuming no live storm right now).

2. Start the replay: click **⚡ Replay storm** on the dashboard (http://localhost:3000), or

   ```bash
   curl -X POST localhost:8000/replay/start -H "content-type: application/json" -d '{"speed": 30}'
   ```

3. **Okeechobee Clean Energy Center** goes red within seconds: its first strike within 10 miles comes 9 seconds into the hour. Three beeps, `STOP WORK 30:00`. It was the busiest site of the storm (the countdown reset 177 times), so the countdown keeps jumping back up as new strikes land, and the site stays red for the whole replay. Press the button to silence the beeps.

4. **To show yellow then red,** run the bridge for **Vandolah Power Station** instead (`vandolah-power-station`). The storm forecast needs about 15 simulated minutes of lightning to start tracking cells, and Vandolah's storm was spotted about 24 minutes before it hit: around 20 seconds into the replay the beacon turns yellow, `STORM NEARBY`, and around 70 seconds in it turns red, `STOP WORK 30:00`. Northside Generating Station (`northside-generating-station`, 26 min warning) works too. Okeechobee goes red too early in the hour for a warning (see `docs/lightning-forecast.md`).

5. Stop the replay with the dashboard button or `curl -X POST localhost:8000/replay/stop`; the beacon returns to the live state.

During a replay the backend counts the all-clear in **simulated** seconds, while the beacon ticks in real seconds between updates, so at 30× the countdown jumps down by about 90 seconds every 3-second poll. Live, the two match. Flood alerts are live-only, so `FLOOD RISK` never appears during a replay.
