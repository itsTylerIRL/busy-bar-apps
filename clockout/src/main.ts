// Clock Out: how long until the workday ends. A countdown, the share of the day done and a
// progress bar that fills from blue to green, gold in the last 15 minutes. At quitting time
// it chimes, flashes the LED and says GO HOME. Before work it counts down to the start;
// on days off it says so.
//
// The bar's clock gives the time and its time zone setting the local offset. One redraw a minute.
// Start: 12 ⇄ 24-hour. Back: quit.
import { clear, draw, loadSettings, playStock, text, type Element } from "@shared/bar";
import manifest from "./appmeta/manifest.json";

const APP = manifest.id;

const MIN_MS = 60_000;
const DAY_MIN = 1440;
const ZONE_MS = 60 * MIN_MS;
const FINAL_MIN = 15;

const WHITE = "#FFFFFFFF";
const GRAY = "#8A8A8AFF";
const GOLD = "#FFC83AFF";
const GREEN = "#2EE06AFF";
const BLUE = "#4A9BFFFF";

const SOUND_DONE = "shared/sounds/calendar_event_starts.snd";
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const BAR_W = 72;
const BAR_H = 1;

/** "17:30" → 1050 minutes after midnight, or the fallback. */
function parseHm(v: unknown, fallback: number): number {
  const m = String(v ?? "").match(/^\s*(\d{1,2})[:.](\d{2})\s*$/);
  if (!m) return fallback;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  return h < 24 && min < 60 ? h * 60 + min : fallback;
}

/** Blends two #RRGGBB colors. */
function mix(a: string, b: string, t: number): string {
  let out = "#";
  for (let i = 1; i < 7; i += 2) {
    const v = Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t);
    out += (v < 16 ? "0" : "") + v.toString(16);
  }
  return out;
}

/** The progress bar: filled part fading from blue to green (gold at the end), the rest dark. */
function barXpm(done: number, final: boolean, off: boolean): string {
  const fill = Math.round(done * BAR_W);
  // Eight color steps along the bar are plenty at this width.
  const keys = "01234567";
  let header = `! XPM2\n${BAR_W} ${BAR_H} 10 1\n. c none\nd c ${off ? "none" : "#262626"}\n`;
  for (let k = 0; k < 8; k++) header += `${keys[k]} c ${final ? "#FFC83A" : mix("#2A6BFF", "#2EE06A", k / 7)}\n`;
  let row = "";
  for (let x = 0; x < BAR_W; x++) row += x < fill ? keys[Math.min(7, Math.floor((x / BAR_W) * 8))] : "d";
  return header + row;
}

async function fetchOffset(): Promise<number> {
  const res = await fetch(`http://${__BUSY_ADDR__}/api/time`);
  if (!res.ok) throw new Error(`time HTTP ${res.status}`);
  const j = (await res.json()) as { timestamp?: string };
  const m = String(j.timestamp ?? "").match(/([+-])(\d\d):?(\d\d)$/);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10)) * MIN_MS;
}

function main(): void {
  const report = (err: unknown) => console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);

  let start = 9 * 60;
  let end = 17 * 60;
  let workdays = [false, true, true, true, true, true, false];
  let h24 = false;
  let clockChosen = false;
  let sound = true;
  let offset = 0;
  let stopped = false;
  /** The day (local days since epoch) we last chimed for, so it happens once. */
  let chimedDay = -1;
  let led: string | undefined;

  try {
    const c = localStorage.getItem("clock");
    if (c === "12" || c === "24") {
      h24 = c === "24";
      clockChosen = true;
    }
    chimedDay = parseInt(localStorage.getItem("chimed") ?? "", 10) || -1;
  } catch {
    // Defaults.
  }

  let tickTimer: ReturnType<typeof setTimeout> | undefined;
  let zoneTimer: ReturnType<typeof setInterval> | undefined;

  const shown: Record<string, string> = {};
  let drawing = false;
  let dirty = false;

  function clockText(min: number): string {
    const h = Math.floor(min / 60) % 24;
    const m = min % 60;
    const mm = (m < 10 ? "0" : "") + m;
    if (h24) return h + ":" + mm;
    return (((h + 11) % 12) + 1) + (m ? ":" + mm : "") + (h < 12 ? "AM" : "PM");
  }

  const span = (min: number) => Math.floor(min / 60) + ":" + (min % 60 < 10 ? "0" : "") + (min % 60);

  function frame(): Element[] {
    const local = Date.now() + offset;
    const day = Math.floor(local / (DAY_MIN * MIN_MS));
    const now = Math.floor((local % (DAY_MIN * MIN_MS)) / MIN_MS);
    const dow = new Date(local).getUTCDay();
    const working = workdays[dow] && end > start;

    let label: string;
    let corner = "";
    let value: string;
    let valueColor = WHITE;
    let suffix = "";
    let done = 0;
    let final = false;
    let barOff = false;

    if (!working) {
      label = "DAY OFF";
      value = "ENJOY";
      valueColor = GREEN;
      barOff = true;
    } else if (now < start) {
      label = "STARTS IN";
      corner = clockText(start);
      value = span(start - now);
      valueColor = BLUE;
    } else if (now < end) {
      const left = end - now;
      final = left <= FINAL_MIN;
      done = (now - start) / (end - start);
      label = "LEFT";
      corner = "OUT " + clockText(end);
      value = span(left);
      valueColor = final ? GOLD : WHITE;
      suffix = Math.floor(done * 100) + "%";
    } else {
      label = "DONE";
      corner = clockText(end);
      value = "GO HOME";
      valueColor = GREEN;
      done = 1;
      if (chimedDay !== day) {
        chimedDay = day;
        led = "#00FF40FF";
        if (sound && now - end < 5) playStock(APP, SOUND_DONE).catch(report);
        try {
          localStorage.setItem("chimed", String(day));
        } catch {
          // It may chime again after a restart.
        }
      }
    }

    // Bold digits are 7px and the colon 3px; the percentage sits 3px after the countdown.
    let w = 0;
    for (let i = 0; i < value.length; i++) w += value[i] === ":" ? 3 : value[i] === " " ? 4 : 7;
    return [
      text("label", label, "small", 0, -1, "top_left", GRAY),
      text("corner", corner, "tiny", 72, 0, "top_right", GRAY),
      text("val", value, "bold", 0, 15, "bottom_left", valueColor),
      text("pct", suffix, "small", w + 3, 15, "bottom_left", GRAY),
      { id: "bar", type: "xpmbitmap", data: barXpm(done, final, barOff), x: 0, y: 15, align: "top_left" },
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

  /** On the minute, so the countdown changes when the bar's clock does. */
  function tick(): void {
    tickTimer = setTimeout(() => {
      tickTimer = undefined;
      render();
      tick();
    }, MIN_MS - (Date.now() % MIN_MS) + 50);
  }

  function updateZone(): void {
    fetchOffset()
      .then((o) => {
        if (o === offset) return;
        offset = o;
        render();
      })
      .catch(report);
  }

  function quit(): void {
    stopped = true;
    if (tickTimer !== undefined) clearTimeout(tickTimer);
    if (zoneTimer !== undefined) clearInterval(zoneTimer);
    try {
      const c = h24 ? "24" : "12";
      if (clockChosen && localStorage.getItem("clock") !== c) localStorage.setItem("clock", c);
    } catch {
      // Not worth failing the quit over.
    }
    clear(APP).catch(report);
    setTimeout(unbind, 0);
  }

  function handle(event: BusyInputEvent): void {
    if (stopped || event.key === "encoder" || event.action !== "short") return;
    if (event.key === "back") quit();
    else if (event.key === "start") {
      h24 = !h24;
      clockChosen = true;
      render();
    }
  }

  const unbind = listen("input", handle);

  // Hold the first frame until the time zone is known, so it doesn't open on UTC.
  fetchOffset()
    .then((o) => {
      offset = o;
    })
    .catch(report)
    .then(() => loadSettings(APP))
    .then((v) => {
      start = parseHm(v.start, start);
      end = parseHm(v.end, end);
      workdays = DAY_KEYS.map((k, i) => (typeof v[k] === "boolean" ? (v[k] as boolean) : workdays[i]));
      if (!clockChosen && (v.clock === "12" || v.clock === "24")) h24 = v.clock === "24";
      sound = v.sound !== false;
    })
    .catch(report)
    .then(() => {
      if (stopped) return;
      render();
      tick();
      zoneTimer = setInterval(updateZone, ZONE_MS);
    });
}

main();
