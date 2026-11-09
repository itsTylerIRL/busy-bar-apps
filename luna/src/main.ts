// Luna: moon phase and sun times, computed on the bar. No data service; the bar's clock
// gives the time and its time zone setting the local offset.
//
// The readout cycles: phase, next full moon, next new moon, sunrise, sunset, daylight.
// Wheel: pick a readout (stops cycling). OK: resume cycling. Start: 12 ⇄ 24-hour. Back: quit.
import { clear, draw, loadSettings, text, type Element } from "@shared/bar";
import manifest from "./appmeta/manifest.json";
import { elongation, illumination, nextPhase, sunDay, type SunDay } from "./astro";

const APP = manifest.id;

const TEXT_X = 18;
const CYCLE_MS = 5000;
const TICK_MS = 60_000;
const ZONE_MS = 60 * 60_000;
const DAY_MS = 86_400_000;

const WHITE = "#FFFFFFFF";
const GRAY = "#8A8A8AFF";
const GOLD = "#FFC94AFF";

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

// ---------------------------------------------------------------- moon picture

/** The near side's dark plains (maria), roughly where they sit, as seen from the north. */
const MARIA = [
  "................",
  "................",
  ".....mm..m......",
  "....mmmm.mmm....",
  "...mmmmm.mmmm...",
  "..mmmm...mmm.mm.",
  "..mmm.....mmmmm.",
  ".mmm......mmm...",
  ".mmmm...........",
  "..mmm..mm.......",
  "...mm..mmm......",
  ".......m........",
  "................",
  "................",
  "................",
  "................",
];

function moonXpm(elong: number, south: boolean): string {
  const p = elong / 360;
  const c = Math.cos(2 * Math.PI * p);
  const rows: string[] = [];
  for (let y = 0; y < 16; y++) {
    let row = "";
    for (let x = 0; x < 16; x++) {
      // From the southern hemisphere the moon is upside down: lit side and maria turn 180°.
      const sx = south ? 15 - x : x;
      const sy = south ? 15 - y : y;
      const nx = (sx - 7.5) / 7.7;
      const ny = (sy - 7.5) / 7.7;
      if (nx * nx + ny * ny > 1) {
        row += ".";
        continue;
      }
      const w = Math.sqrt(1 - ny * ny);
      const lit = p < 0.5 ? nx > w * c : nx < -w * c;
      const mare = MARIA[sy][sx] === "m";
      row += lit ? (mare ? "m" : "L") : mare ? "e" : "d";
    }
    rows.push(row);
  }
  return (
    "! XPM2\n16 16 5 1\n. c none\nL c #EFE8CF\nm c #A8A28C\nd c #1C1F2C\ne c #16182A\n" + rows.join("\n")
  );
}

// ---------------------------------------------------------------- sun picture

/** The day's arc over the horizon, with the sun where it is now; below the horizon at night. */
function sunXpm(now: number, sun: SunDay, nextRise: number): string {
  const g: string[][] = [];
  for (let y = 0; y < 16; y++) {
    const row: string[] = [];
    for (let x = 0; x < 16; x++) row.push(y === 12 ? "h" : ".");
    g.push(row);
  }
  const put = (x: number, y: number, c: string) => {
    if (x >= 0 && y >= 0 && x < 16 && y < 16) g[y][x] = c;
  };
  for (let i = 0; i <= 40; i++) {
    const f = i / 40;
    put(Math.round(1 + 13 * f), Math.round(12 - 10 * Math.sin(Math.PI * f)), "a");
  }

  let sx: number;
  let sy: number;
  let up: boolean;
  if (sun.polar) {
    up = sun.polar === "day";
    sx = 7;
    sy = up ? 2 : 14;
  } else if (now >= sun.rise && now <= sun.set) {
    const f = (now - sun.rise) / (sun.set - sun.rise);
    sx = Math.round(1 + 13 * f);
    sy = Math.round(12 - 10 * Math.sin(Math.PI * f));
    up = true;
  } else {
    // Night: the sun travels under the horizon from last sunset to the next sunrise.
    const lastSet = now > sun.set ? sun.set : sun.set - DAY_MS;
    const f = Math.max(0, Math.min(1, (now - lastSet) / (nextRise - lastSet)));
    sx = Math.round(14 - 13 * f);
    sy = Math.round(13 + 2 * Math.sin(Math.PI * f));
    up = false;
  }
  const c = up ? "y" : "n";
  put(sx, sy, c);
  if (up) {
    put(sx - 1, sy, c);
    put(sx + 1, sy, c);
    put(sx, sy - 1, c);
    put(sx, sy + 1, c);
  }
  return (
    "! XPM2\n16 16 5 1\n. c none\nh c #4E4E4E\na c #5C4A1C\ny c #FFC020\nn c #8A5A10\n" +
    g.map((r) => r.join("")).join("\n")
  );
}

// ---------------------------------------------------------------- text

function phaseName(e: number): string {
  if (e < 6 || e >= 354) return "NEW MOON";
  if (e < 84) return "WAX CRES";
  if (e < 96) return "1ST QTR";
  if (e < 174) return "WAX GIB";
  if (e < 186) return "FULL MOON";
  if (e < 264) return "WAN GIB";
  if (e < 276) return "LAST QTR";
  return "WAN CRES";
}

function untilText(ms: number): string {
  const h = ms / 3_600_000;
  return h < 36 ? Math.max(1, Math.round(h)) + "H" : Math.round(h / 24) + "D";
}

type Mode = "phase" | "full" | "new" | "rise" | "set" | "daylight";
const MODES: Mode[] = ["phase", "full", "new", "rise", "set", "daylight"];

interface Place {
  lat: number;
  lon: number;
}

function parsePlace(v: unknown): Place | null {
  const m = String(v ?? "").match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

/** Location from the settings, else the one found from our IP last time, else look it up. */
async function findPlace(setting: unknown): Promise<Place> {
  const set = parsePlace(setting);
  if (set) return set;
  try {
    const saved = parsePlace(localStorage.getItem("loc"));
    if (saved) return saved;
  } catch {
    // Fall through to the lookup.
  }
  const res = await fetch("http://ip-api.com/json/?fields=lat,lon");
  if (!res.ok) throw new Error(`geoip HTTP ${res.status}`);
  const j = (await res.json()) as { lat?: number; lon?: number };
  if (typeof j.lat !== "number" || typeof j.lon !== "number") throw new Error("geoip: no location");
  try {
    localStorage.setItem("loc", `${j.lat.toFixed(3)},${j.lon.toFixed(3)}`);
  } catch {
    // Look it up again next launch.
  }
  return { lat: j.lat, lon: j.lon };
}

/** The bar's UTC offset in ms, from its clock's ISO timestamp ("…-06:00"). */
async function fetchOffset(): Promise<number> {
  const res = await fetch(`http://${__BUSY_ADDR__}/api/time`);
  if (!res.ok) throw new Error(`time HTTP ${res.status}`);
  const j = (await res.json()) as { timestamp?: string };
  const m = String(j.timestamp ?? "").match(/([+-])(\d\d):?(\d\d)$/);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10)) * 60_000;
}

// ---------------------------------------------------------------- app

function main(): void {
  const report = (err: unknown) => console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);

  let h24 = false;
  let clockChosen = false;
  try {
    const c = localStorage.getItem("clock");
    if (c === "12" || c === "24") {
      h24 = c === "24";
      clockChosen = true;
    }
  } catch {
    // Settings decide below.
  }

  let place: Place | null = null;
  let offset = 0;
  let mode = 0;
  let stopped = false;

  let cycleTimer: ReturnType<typeof setInterval> | undefined;
  let tickTimer: ReturnType<typeof setTimeout> | undefined;
  let zoneTimer: ReturnType<typeof setInterval> | undefined;
  let placeTimer: ReturnType<typeof setTimeout> | undefined;
  let placeRetryMs = 60_000;
  let noPlace = false;

  const shown: Record<string, string> = {};
  let drawing = false;
  let dirty = false;

  /** Everything worked out for the current minute. */
  interface Sky {
    now: number;
    elong: number;
    full: number;
    new: number;
    sun: SunDay | null;
    nextRise: number;
  }
  let sky: Sky | null = null;

  function compute(): Sky {
    const now = Date.now();
    const elong = elongation(now);
    let sun: SunDay | null = null;
    let nextRise = NaN;
    if (place) {
      // Local noon of today, as a UTC instant.
      const localMidnight = Math.floor((now + offset) / DAY_MS) * DAY_MS - offset;
      sun = sunDay(localMidnight + DAY_MS / 2, place.lat, place.lon);
      nextRise = sunDay(localMidnight + DAY_MS * 1.5, place.lat, place.lon).rise;
    }
    return { now, elong, full: nextPhase(now, 180), new: nextPhase(now, 0), sun, nextRise };
  }

  function clockText(ms: number): [string, string] {
    if (isNaN(ms)) return ["--", ""];
    const d = new Date(ms + offset);
    const h = d.getUTCHours();
    const m = d.getUTCMinutes();
    const mm = (m < 10 ? "0" : "") + m;
    if (h24) return [(h < 10 ? "0" : "") + h + ":" + mm, ""];
    return [((h + 11) % 12) + 1 + ":" + mm, h < 12 ? "AM" : "PM"];
  }

  function dateText(ms: number): string {
    const d = new Date(ms + offset);
    return MONTHS[d.getUTCMonth()] + " " + d.getUTCDate();
  }

  /** Label, value, value's small suffix, value color. */
  function readout(s: Sky): [string, string, string, string] {
    const sun = s.sun;
    switch (MODES[mode]) {
      case "phase":
        return [phaseName(s.elong), Math.round(illumination(s.elong) * 100) + "%", "LIT", WHITE];
      case "full":
        return ["FULL " + untilText(s.full - s.now), dateText(s.full), "", WHITE];
      case "new":
        return ["NEW " + untilText(s.new - s.now), dateText(s.new), "", WHITE];
      case "rise":
      case "set": {
        const label = MODES[mode] === "rise" ? "SUNRISE" : "SUNSET";
        if (!sun) return [label, noPlace ? "NO LOC" : "...", "", GRAY];
        if (sun.polar) return [label, "NONE", "", GRAY];
        const [t, ampm] = clockText(MODES[mode] === "rise" ? sun.rise : sun.set);
        return [label, t, ampm, GOLD];
      }
      default: {
        if (!sun) return ["DAYLIGHT", noPlace ? "NO LOC" : "...", "", GRAY];
        const mins = sun.polar ? (sun.polar === "day" ? 1440 : 0) : Math.round((sun.set - sun.rise) / 60_000);
        return ["DAYLIGHT", Math.floor(mins / 60) + "H" + (mins % 60 < 10 ? "0" : "") + (mins % 60), "", WHITE];
      }
    }
  }

  function frame(): Element[] {
    if (!sky) sky = compute();
    const s = sky;
    const moon = mode < 3 || !s.sun;
    const [label, value, suffix, color] = readout(s);
    // Bold digits are 7px; the suffix sits 2px after the value.
    let w = 0;
    for (let i = 0; i < value.length; i++) w += value[i] === ":" ? 3 : value[i] === " " ? 4 : 7;
    return [
      {
        id: "pic",
        type: "xpmbitmap",
        data: moon ? moonXpm(s.elong, !!place && place.lat < 0) : sunXpm(s.now, s.sun as SunDay, s.nextRise),
        x: 0,
        y: 0,
        align: "top_left",
      },
      // y −1 leaves a pixel between the label and the bold value.
      text("label", label, "small", TEXT_X, -1, "top_left", mode === 0 ? WHITE : GRAY),
      text("val", value, "bold", TEXT_X, 16, "bottom_left", color),
      text("suffix", suffix, "small", TEXT_X + w + 2, 16, "bottom_left", GRAY),
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
    drawing = true;
    draw(APP, changed)
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

  function recompute(): void {
    sky = compute();
    render();
  }

  /** On the minute, so clock-driven values change when the bar's clock does. */
  function tick(): void {
    tickTimer = setTimeout(() => {
      tickTimer = undefined;
      recompute();
      tick();
    }, TICK_MS - (Date.now() % TICK_MS) + 50);
  }

  function updateZone(): void {
    fetchOffset()
      .then((o) => {
        if (o === offset) return;
        offset = o;
        recompute();
      })
      .catch(report);
  }

  function startCycle(): void {
    stopCycle();
    cycleTimer = setInterval(() => {
      mode = (mode + 1) % MODES.length;
      render();
    }, CYCLE_MS);
  }

  function stopCycle(): void {
    if (cycleTimer !== undefined) clearInterval(cycleTimer);
    cycleTimer = undefined;
  }

  function quit(): void {
    stopped = true;
    stopCycle();
    if (tickTimer !== undefined) clearTimeout(tickTimer);
    if (zoneTimer !== undefined) clearInterval(zoneTimer);
    if (placeTimer !== undefined) clearTimeout(placeTimer);
    try {
      const c = h24 ? "24" : "12";
      if (clockChosen && localStorage.getItem("clock") !== c) localStorage.setItem("clock", c);
    } catch {
      // Not worth failing the quit over.
    }
    clear(APP).catch(report);
    setTimeout(unbind, 0);
  }

  const unbind = listen("input", (event) => {
    if (stopped) return;
    if (event.key === "encoder") {
      stopCycle();
      mode = (mode + event.delta + MODES.length) % MODES.length;
      render();
      return;
    }
    if (event.action !== "short") return;
    if (event.key === "back") quit();
    else if (event.key === "ok") startCycle();
    else if (event.key === "start") {
      h24 = !h24;
      clockChosen = true;
      render();
    }
  });

  render();
  startCycle();
  tick();
  // The offset follows daylight saving time; check it hourly.
  updateZone();
  zoneTimer = setInterval(updateZone, ZONE_MS);
  /** Settings, then the location; a failed lookup (the bar's Wi-Fi drops DNS now and then) retries with backoff. */
  function locate(): void {
    placeTimer = undefined;
    loadSettings(APP)
      .then((v) => {
        if (stopped) return;
        if (!clockChosen && (v.clock === "12" || v.clock === "24")) h24 = v.clock === "24";
        return findPlace(v.location).then((p) => {
          place = p;
          noPlace = false;
        });
      })
      .catch((err) => {
        report(err);
        noPlace = true;
        if (stopped) return;
        placeTimer = setTimeout(locate, placeRetryMs);
        placeRetryMs = Math.min(placeRetryMs * 2, 30 * 60_000);
      })
      .then(() => {
        if (!stopped) recompute();
      });
  }
  locate();
}

main();
