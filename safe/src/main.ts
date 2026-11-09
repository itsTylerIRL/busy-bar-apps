// Safecracker: find a three-number combination on a 0–39 dial with the wheel.
//
// The dial number's color says how close it is to the current tumbler's number:
// blue cold, gray cool, orange warm, red hot (within one). OK tries the number. A miss
// costs one of three lights and says which way to turn; a fourth miss sets off the alarm.
//
// Wheel: turn the dial. OK: try the number (or start the next safe). Start: new safe. Back: quit.
import { clear, draw, loadSettings, playStock, text, type Element } from "@shared/bar";
import manifest from "./appmeta/manifest.json";

const APP = manifest.id;

const DIAL = 40;
const PINS = 3;
const LIGHTS = 3;

const TAPE_X = 12;
const TAPE_W = 47;
const TAPE_Y = 10;
const TAPE_H = 6;
const TAPE_MID = 23;

const COLD = "#3C78FF";
const COOL = "#A0A6B4";
const WARM = "#FF9A30";
const HOT = "#FF3030";
const GREEN = "#2EE06A";
const GRAY = "#8A8A8AFF";
const WHITE = "#FFFFFFFF";

const SOUND_CLICK = "shared/sounds/volume_change.snd";
const SOUND_OPEN = "shared/sounds/calendar_event_starts.snd";
const SOUND_ALARM = "shared/sounds/calendar_reminder_ends.snd";

type State = "ready" | "play" | "open" | "alarm";

function dist(a: number, b: number): number {
  const d = Math.abs(a - b) % DIAL;
  return Math.min(d, DIAL - d);
}

function heatColor(d: number): string {
  if (d <= 1) return HOT;
  if (d <= 4) return WARM;
  if (d <= 9) return COOL;
  return COLD;
}

function newCombo(): number[] {
  const c: number[] = [];
  while (c.length < PINS) {
    const n = Math.floor(Math.random() * DIAL);
    // Consecutive numbers far enough apart that the next search starts cold.
    if (!c.length || dist(n, c[c.length - 1]) >= 8) c.push(n);
  }
  return c;
}

function clock(ms: number): string {
  const s = Math.round(ms / 1000);
  return Math.floor(s / 60) + ":" + (s % 60 < 10 ? "0" : "") + (s % 60);
}

/** The dial as a strip of ticks, 2px per number, with the pointer in the middle. */
function tapeXpm(value: number, pointer: string): string {
  const rows: string[][] = [];
  for (let y = 0; y < TAPE_H; y++) {
    const row: string[] = [];
    for (let x = 0; x < TAPE_W; x++) row.push(".");
    rows.push(row);
  }
  for (let x = 0; x < TAPE_W; x++) {
    const o = x - TAPE_MID;
    if (o % 2 !== 0) continue;
    const v = (((value + o / 2) % DIAL) + DIAL) % DIAL;
    const h = v % 10 === 0 ? 5 : v % 5 === 0 ? 3 : 1;
    // Ticks fade toward the ends of the strip.
    const c = Math.abs(o) > 16 ? "f" : "t";
    for (let y = TAPE_H - h; y < TAPE_H; y++) rows[y][x] = c;
  }
  for (let y = 0; y < TAPE_H; y++) rows[y][TAPE_MID] = "p";
  rows[0][TAPE_MID - 1] = "p";
  rows[0][TAPE_MID + 1] = "p";
  return (
    `! XPM2\n${TAPE_W} ${TAPE_H} 4 1\n. c none\nt c #7A7A7A\nf c #3A3A3A\np c ${pointer}\n` +
    rows.map((r) => r.join("")).join("\n")
  );
}

/** Three tumblers, stacked: green once open, white for the one being worked, dark for the rest. */
function pinsXpm(done: number, state: State): string {
  const rows: string[] = [];
  for (let y = 0; y < 16; y++) {
    const i = Math.floor((y - 1) / 5);
    const inPin = y >= 1 && (y - 1) % 5 < 4 && i < PINS;
    let c = ".";
    if (inPin) c = i < done || state === "open" ? "g" : i === done && state === "play" ? "w" : state === "alarm" ? "r" : "d";
    let row = "";
    for (let x = 0; x < 8; x++) row += inPin ? c : ".";
    rows.push(row);
  }
  return `! XPM2\n8 16 5 1\n. c none\ng c ${GREEN}\nw c #E0E0E0\nd c #333333\nr c ${HOT}\n` + rows.join("\n");
}

/** Strike lights: dark while unused, red once spent. */
function lightsXpm(used: number): string {
  const rows: string[] = [];
  for (let y = 0; y < 2; y++) {
    let row = "";
    for (let x = 0; x < 10; x++) {
      const i = Math.floor(x / 4);
      row += x % 4 < 2 && i < LIGHTS ? (i < used ? "r" : "d") : ".";
    }
    rows.push(row);
  }
  return `! XPM2\n10 2 3 1\n. c none\nr c ${HOT}\nd c #333333\n` + rows.join("\n");
}

function main(): void {
  const report = (err: unknown) => console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);

  let sound = true;
  let best = 0;
  try {
    best = parseInt(localStorage.getItem("best") ?? "", 10) || 0;
  } catch {
    // No record yet.
  }

  let state: State = "ready";
  let combo = newCombo();
  let value = 0;
  let done = 0;
  let misses = 0;
  let hint = "";
  let startedAt = 0;
  let took = 0;
  let stopped = false;
  let led: string | undefined;

  const shown: Record<string, string> = {};
  let drawing = false;
  let dirty = false;

  function frame(): Element[] {
    const d = state === "play" ? dist(value, combo[done]) : 99;
    let big: string;
    let bigColor: string;
    let corner = "";
    let cornerColor = GRAY;
    let pointer = "#E0E0E0";
    if (state === "ready") {
      big = "TURN";
      bigColor = GRAY;
      corner = best ? clock(best) : "";
    } else if (state === "play") {
      big = (value < 10 ? "0" : "") + value;
      bigColor = heatColor(d) + "FF";
      pointer = heatColor(d);
      corner = hint;
      cornerColor = WHITE;
    } else if (state === "open") {
      big = "OPEN";
      bigColor = GREEN + "FF";
      pointer = GREEN;
      corner = clock(took);
      cornerColor = took === best ? GREEN + "FF" : WHITE;
    } else {
      big = "ALARM";
      bigColor = HOT + "FF";
      pointer = HOT;
    }
    return [
      { id: "pins", type: "xpmbitmap", data: pinsXpm(done, state), x: 0, y: 0, align: "top_left" },
      text("big", big, "bold", TAPE_X + TAPE_MID, -1, "top_mid", bigColor),
      { id: "tape", type: "xpmbitmap", data: tapeXpm(value, pointer), x: TAPE_X, y: TAPE_Y, align: "top_left" },
      { id: "lights", type: "xpmbitmap", data: lightsXpm(misses), x: 62, y: 1, align: "top_left" },
      text("corner", corner, "small", 72, 16, "bottom_right", cornerColor),
    ];
  }

  function render(): void {
    if (stopped) return;
    if (drawing) {
      dirty = true;
      return;
    }
    const changed: Element[] = [];
    const sigs: Record<string, string> = {};
    for (const el of frame()) {
      const sig = JSON.stringify(el);
      if (shown[el.id] !== sig) {
        changed.push(el);
        sigs[el.id] = sig;
      }
    }
    if (!changed.length) return;
    const flash = led;
    led = undefined;
    drawing = true;
    draw(APP, changed, flash)
      .then(() => {
        for (const id in sigs) shown[id] = sigs[id];
      })
      .catch((err) => {
        for (const id in shown) delete shown[id];
        report(err);
      })
      .then(() => {
        drawing = false;
        if (dirty) {
          dirty = false;
          render();
        }
      });
  }

  function play(path: string): void {
    if (sound) playStock(APP, path).catch(report);
  }

  function newSafe(): void {
    combo = newCombo();
    state = "ready";
    done = 0;
    misses = 0;
    hint = "";
    render();
  }

  function attempt(): void {
    const target = combo[done];
    if (value === target) {
      done++;
      hint = "";
      if (done < PINS) {
        play(SOUND_CLICK);
      } else {
        state = "open";
        took = Date.now() - startedAt;
        if (!best || took < best) {
          best = took;
          try {
            localStorage.setItem("best", String(best));
          } catch {
            // The record just won't survive a restart.
          }
        }
        led = "#00FF40FF";
        play(SOUND_OPEN);
      }
    } else if (misses < LIGHTS) {
      misses++;
      // Which way is shorter to the number.
      hint = (target - value + DIAL) % DIAL <= DIAL / 2 ? ">" : "<";
    } else {
      state = "alarm";
      led = "#FF0000FF";
      play(SOUND_ALARM);
    }
    render();
  }

  function quit(): void {
    stopped = true;
    clear(APP).catch(report);
    setTimeout(unbind, 0);
  }

  function handle(event: BusyInputEvent): void {
    if (stopped) return;
    if (event.key === "encoder") {
      if (state === "open" || state === "alarm") return;
      if (state === "ready") {
        state = "play";
        startedAt = Date.now();
      }
      value = (value + event.delta + DIAL) % DIAL;
      render();
      return;
    }
    if (event.action !== "short") return;
    if (event.key === "back") quit();
    else if (event.key === "start") newSafe();
    else if (event.key === "ok") {
      if (state === "play") attempt();
      else if (state === "open" || state === "alarm") newSafe();
    }
  }

  const unbind = listen("input", handle);

  render();
  loadSettings(APP)
    .then((v) => {
      sound = v.sound !== false;
    })
    .catch(report);
}

main();
