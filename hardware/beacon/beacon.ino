// PlanIT Control stop-work beacon.
//
// Reads one line at a time over USB serial (115200 baud) from hardware/bridge.py:
//   STOP <seconds_until_all_clear> <site name>
//   APPR <site name>
//   FLOOD <site name>
//   CLEAR <site name>
//   UNKNOWN
// No line for 15 seconds counts as UNKNOWN. Green is shown only after an explicit CLEAR.
//
// A short button press silences the beeps. Holding it for 2 seconds sends "SITE" back to the
// bridge, which switches to its next --site.

#include <LiquidCrystal.h>

const uint8_t PIN_BUTTON = 2;
const uint8_t PIN_RED = 3;
const uint8_t PIN_BUZZER = 4;
const uint8_t PIN_YELLOW = 5;
const uint8_t PIN_GREEN = 6;

LiquidCrystal lcd(7, 8, 9, 10, 11, 12);  // RS, E, D4, D5, D6, D7

const unsigned long STALE_MS = 15000;     // no line for this long -> NO DATA
const unsigned long BLINK_MS = 500;       // NO DATA yellow blink half-period
const unsigned long BEEP_ON_MS = 120;
const unsigned long BEEP_OFF_MS = 120;
const uint8_t BEEP_COUNT = 3;
const unsigned long DEBOUNCE_MS = 40;
const unsigned long LONG_PRESS_MS = 2000; // hold the button this long to switch sites

enum State { ST_UNKNOWN, ST_STOP, ST_APPR, ST_FLOOD, ST_CLEAR };

State state = ST_UNKNOWN;
char siteName[17] = "PlanIT Control";
bool stopHasTime = false;
unsigned long stopSyncMs = 0;             // millis() of the last STOP line
unsigned long stopSyncSecs = 0;           // seconds to all-clear in that line
unsigned long stopRate = 1;               // countdown seconds per real second (replay speed)
const unsigned long MAX_RATE = 1000;
unsigned long lastLineMs = 0;
bool everReceived = false;

char lineBuf[96];
uint8_t lineLen = 0;
bool lineOverflow = false;

// Beeps: a burst of BEEP_COUNT short beeps, run without blocking.
bool silenced = false;                    // button pressed; cleared on the next state change
uint8_t beepsLeft = 0;
bool beepOn = false;
unsigned long beepPhaseMs = 0;

bool buttonStable = HIGH;
bool buttonLastRead = HIGH;
unsigned long buttonChangedMs = 0;
unsigned long buttonDownMs = 0;
bool longPressSent = false;

char shownLine0[17] = "";
char shownLine1[17] = "";

void setLeds(bool red, bool yellow, bool green) {
  digitalWrite(PIN_RED, red ? HIGH : LOW);
  digitalWrite(PIN_YELLOW, yellow ? HIGH : LOW);
  digitalWrite(PIN_GREEN, green ? HIGH : LOW);
}

// Writes a 16-character LCD row, padded with spaces; skips the write if nothing changed.
void showRow(uint8_t row, const char *text) {
  char padded[17];
  uint8_t i = 0;
  for (; i < 16 && text[i]; i++) padded[i] = text[i];
  for (; i < 16; i++) padded[i] = ' ';
  padded[16] = '\0';
  char *shown = row == 0 ? shownLine0 : shownLine1;
  if (strcmp(shown, padded) == 0) return;
  strcpy(shown, padded);
  lcd.setCursor(0, row);
  lcd.print(padded);
}

void startBeeps() {
  if (silenced) return;
  beepsLeft = BEEP_COUNT;
  beepOn = true;
  beepPhaseMs = millis();
  digitalWrite(PIN_BUZZER, HIGH);
}

void stopBeeps() {
  beepsLeft = 0;
  beepOn = false;
  digitalWrite(PIN_BUZZER, LOW);
}

void updateBeeps(unsigned long now) {
  if (beepsLeft == 0) return;
  if (beepOn && now - beepPhaseMs >= BEEP_ON_MS) {
    digitalWrite(PIN_BUZZER, LOW);
    beepOn = false;
    beepPhaseMs = now;
    beepsLeft--;
  } else if (!beepOn && now - beepPhaseMs >= BEEP_OFF_MS) {
    digitalWrite(PIN_BUZZER, HIGH);
    beepOn = true;
    beepPhaseMs = now;
  }
}

void enterState(State next) {
  if (next == state) return;
  state = next;
  silenced = false;
  stopBeeps();
  if (next == ST_STOP || next == ST_APPR) startBeeps();
}

void setSiteName(const char *name) {
  while (*name == ' ') name++;
  if (!*name) return;  // keep the previous name if the line had none
  uint8_t i = 0;
  for (; i < 16 && name[i]; i++) {
    char c = name[i];
    siteName[i] = (c >= 32 && c <= 126) ? c : '?';
  }
  siteName[i] = '\0';
}

// Returns the text after the command word, or "" if there is none.
const char *afterWord(const char *line) {
  const char *p = strchr(line, ' ');
  return p ? p + 1 : "";
}

bool startsWithWord(const char *line, const char *word) {
  size_t n = strlen(word);
  return strncmp(line, word, n) == 0 && (line[n] == ' ' || line[n] == '\0');
}

void handleLine(char *line) {
  // Trim trailing whitespace (the bridge sends \n; a terminal may send \r\n).
  int len = strlen(line);
  while (len > 0 && (line[len - 1] == ' ' || line[len - 1] == '\r')) line[--len] = '\0';
  while (*line == ' ') line++;
  if (!*line) return;

  unsigned long now = millis();
  if (startsWithWord(line, "STOP")) {
    // Optional trailing " x<speed>" during a replay; without it the countdown runs in real time.
    stopRate = 1;
    char *speed = strrchr(line, ' ');
    if (speed && speed[1] == 'x' && speed[2] >= '0' && speed[2] <= '9') {
      char *speedEnd;
      long rate = strtol(speed + 2, &speedEnd, 10);
      if (*speedEnd == '\0') {
        stopRate = rate < 1 ? 1 : (rate > (long)MAX_RATE ? MAX_RATE : (unsigned long)rate);
        *speed = '\0';
      }
    }
    const char *rest = afterWord(line);
    char *end;
    long secs = strtol(rest, &end, 10);
    stopHasTime = end != rest && secs >= 0;
    if (stopHasTime) {
      stopSyncMs = now;
      stopSyncSecs = (unsigned long)secs;
    } else if (*end == '-') {
      end++;
    }
    setSiteName(end);
    enterState(ST_STOP);
  } else if (startsWithWord(line, "APPR")) {
    setSiteName(afterWord(line));
    enterState(ST_APPR);
  } else if (startsWithWord(line, "FLOOD")) {
    setSiteName(afterWord(line));
    enterState(ST_FLOOD);
  } else if (startsWithWord(line, "CLEAR")) {
    setSiteName(afterWord(line));
    enterState(ST_CLEAR);
  } else {
    // UNKNOWN, or anything we can't parse: treat as not knowing.
    enterState(ST_UNKNOWN);
  }
  lastLineMs = now;
  everReceived = true;
}

void readSerial() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n') {
      lineBuf[lineLen] = '\0';
      if (!lineOverflow) handleLine(lineBuf);
      lineLen = 0;
      lineOverflow = false;
    } else if (lineLen < sizeof(lineBuf) - 1) {
      lineBuf[lineLen++] = c;
    } else {
      lineOverflow = true;  // drop over-long lines instead of acting on half of one
    }
  }
}

void readButton(unsigned long now) {
  bool reading = digitalRead(PIN_BUTTON);
  if (reading != buttonLastRead) {
    buttonLastRead = reading;
    buttonChangedMs = now;
  }
  if (now - buttonChangedMs >= DEBOUNCE_MS && reading != buttonStable) {
    buttonStable = reading;
    if (buttonStable == LOW) {  // pressed (INPUT_PULLUP)
      silenced = true;
      stopBeeps();
      buttonDownMs = now;
      longPressSent = false;
    }
  }
  if (buttonStable == LOW && !longPressSent && now - buttonDownMs >= LONG_PRESS_MS) {
    // Ask the bridge for the next site. Until its first line for that site arrives we don't
    // know the new site's state, so show NO DATA rather than the old site's.
    longPressSent = true;
    Serial.println("SITE");
    strcpy(siteName, "Switching site");
    enterState(ST_UNKNOWN);
  }
}

void render(unsigned long now) {
  char row1[17];
  switch (state) {
    case ST_STOP: {
      setLeds(true, false, false);
      if (stopHasTime) {
        // Keep showing 00:00 until the bridge says CLEAR: never assume the all-clear.
        // Elapsed stays small: a fresh STOP line resyncs every few seconds, and 15 s of
        // silence switches to NO DATA, so elapsed * MAX_RATE can't overflow.
        unsigned long counted = (now - stopSyncMs) * stopRate / 1000;
        unsigned long left = counted < stopSyncSecs ? stopSyncSecs - counted : 0;
        unsigned long mm = left / 60, ss = left % 60;
        if (mm > 99) { mm = 99; ss = 59; }
        snprintf(row1, sizeof(row1), "STOP WORK %02lu:%02lu", mm, ss);
      } else {
        strcpy(row1, "STOP WORK");
      }
      break;
    }
    case ST_APPR:
      setLeds(false, true, false);
      strcpy(row1, "STORM NEARBY");
      break;
    case ST_FLOOD:
      setLeds(false, true, false);
      strcpy(row1, "FLOOD RISK");
      break;
    case ST_CLEAR:
      setLeds(false, false, true);
      strcpy(row1, "ALL CLEAR");
      break;
    default:
      setLeds(false, (now / BLINK_MS) % 2 == 0, false);
      strcpy(row1, "NO DATA");
      break;
  }
  showRow(0, siteName);
  showRow(1, row1);
}

void selfTest() {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("PlanIT Control");
  lcd.setCursor(0, 1);
  lcd.print("Self-test");
  const uint8_t leds[] = {PIN_RED, PIN_YELLOW, PIN_GREEN};
  for (uint8_t i = 0; i < 3; i++) {
    digitalWrite(leds[i], HIGH);
    delay(300);
    digitalWrite(leds[i], LOW);
  }
  digitalWrite(PIN_BUZZER, HIGH);
  delay(100);
  digitalWrite(PIN_BUZZER, LOW);
  delay(700);
  lcd.clear();
  shownLine0[0] = shownLine1[0] = '\0';
}

void setup() {
  pinMode(PIN_RED, OUTPUT);
  pinMode(PIN_YELLOW, OUTPUT);
  pinMode(PIN_GREEN, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_BUTTON, INPUT_PULLUP);
  setLeds(false, false, false);
  digitalWrite(PIN_BUZZER, LOW);

  lcd.begin(16, 2);
  selfTest();

  Serial.begin(115200);
  lastLineMs = millis();
}

void loop() {
  unsigned long now = millis();
  readSerial();
  readButton(now);
  if (state != ST_UNKNOWN && (!everReceived || now - lastLineMs >= STALE_MS)) {
    enterState(ST_UNKNOWN);
  }
  updateBeeps(now);
  render(now);
}
