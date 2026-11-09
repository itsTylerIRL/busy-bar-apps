// ISS: a live map of where the space station is, from wheretheiss.at.
//
// The map shows land, the night side, the next orbit and home. Beside it, the readout
// cycles through position, altitude, speed and distance from home.
// Wheel: pick a readout (stops cycling). OK: resume cycling. Start: miles ⇄ km. Back: quit.
import { clear, draw, loadSettings, text, type Element } from "@shared/bar";
import manifest from "./appmeta/manifest.json";
import { LAND, LAT_BOTTOM, LAT_TOP, MAP_H, MAP_W } from "./land";

const APP = manifest.id;

const TEXT_X = MAP_W + 2;
const TEXT_R = 72;

const POLL_MS = 10_000;
const POLL_MAX_MS = 5 * 60_000;
const TRACK_MS = 10 * 60_000;
/** The track samples one orbit (~92 min) ahead, at the API's limit of 10 timestamps a request. */
const TRACK_STEP_S = 9 * 60;
const CYCLE_MS = 5000;
/** Closer than this, the ISS can be above your horizon. */
const NEAR_KM = 2000;

const WHITE = "#FFFFFFFF";
const GRAY = "#8A8A8AFF";
const YELLOW = "#FFD84AFF";
const RED = "#FF4455FF";

const SAT = "https://api.wheretheiss.at/v1/satellites/25544";
const KM_PER_MI = 1.609344;

interface Fix {
  lat: number;
  lon: number;
  altKm: number;
  kmh: number;
  sunlit: boolean;
  sunLat: number;
  sunLon: number;
}

interface Place {
  lat: number;
  lon: number;
}

// ---------------------------------------------------------------- data

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

async function fetchFix(): Promise<Fix> {
  const j = (await getJson(SAT)) as Record<string, unknown>;
  const n = (k: string) => {
    const v = j[k];
    if (typeof v !== "number") throw new Error(`no ${k}`);
    return v;
  };
  return {
    lat: n("latitude"),
    lon: n("longitude"),
    altKm: n("altitude"),
    kmh: n("velocity"),
    sunlit: j.visibility === "daylight",
    sunLat: n("solar_lat"),
    sunLon: n("solar_lon"),
  };
}

/** Ground track for the next orbit as flat [time, lat, lon, time, lat, lon, …], oldest first. */
async function fetchTrack(): Promise<number[]> {
  const now = Math.floor(Date.now() / 1000);
  const stamps: number[] = [];
  for (let i = 1; i <= 10; i++) stamps.push(now + i * TRACK_STEP_S);
  const list = (await getJson(`${SAT}/positions?timestamps=${stamps.join(",")}`)) as Record<string, unknown>[];
  const out: number[] = [];
  for (const p of list)
    if (typeof p.timestamp === "number" && typeof p.latitude === "number" && typeof p.longitude === "number")
      out.push(p.timestamp, p.latitude, p.longitude);
  return out;
}

function parsePlace(v: unknown): Place | null {
  const m = String(v ?? "").match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

/** Home from the settings, else the one found from our IP last time, else look it up. */
async function findHome(setting: unknown): Promise<Place> {
  const set = parsePlace(setting);
  if (set) return set;
  try {
    const saved = parsePlace(localStorage.getItem("loc"));
    if (saved) return saved;
  } catch {
    // Fall through to the lookup.
  }
  const j = (await getJson("http://ip-api.com/json/?fields=lat,lon")) as { lat?: number; lon?: number };
  if (typeof j.lat !== "number" || typeof j.lon !== "number") throw new Error("geoip: no location");
  try {
    localStorage.setItem("loc", `${j.lat.toFixed(3)},${j.lon.toFixed(3)}`);
  } catch {
    // Look it up again next launch.
  }
  return { lat: j.lat, lon: j.lon };
}

// ---------------------------------------------------------------- geometry

const RAD = Math.PI / 180;

function groundKm(a: Place, b: Place): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const colOf = (lon: number) => Math.floor(((((lon + 180) % 360) + 360) % 360) / (360 / MAP_W));
const rowOf = (lat: number) => Math.floor(((LAT_TOP - lat) / (LAT_TOP - LAT_BOTTOM)) * MAP_H);

// ---------------------------------------------------------------- map

const MAP_COLORS =
  ". c #0A2C66\n" + // ocean, day
  ", c #040F28\n" + // ocean, night
  "L c #2E8B3E\n" + // land, day
  "l c #0F3519\n" + // land, night
  "t c #FF9A1F\n" + // track
  "h c #FF3B3B\n" + // home
  "i c #FFFFFF\n" + // ISS
  "a c #FFD84A\n" + // ISS glow, sunlit
  "s c #7A7F8C\n"; // ISS glow, in Earth's shadow

/** The night side, by the angle between each pixel and the point where the sun is overhead. */
function baseMap(sunLat: number, sunLon: number): string[][] {
  const sLat = sunLat * RAD;
  const rows: string[][] = [];
  for (let r = 0; r < MAP_H; r++) {
    const lat = (LAT_TOP - ((r + 0.5) * (LAT_TOP - LAT_BOTTOM)) / MAP_H) * RAD;
    const row: string[] = [];
    for (let c = 0; c < MAP_W; c++) {
      const lon = (-180 + ((c + 0.5) * 360) / MAP_W) * RAD;
      const cos = Math.sin(lat) * Math.sin(sLat) + Math.cos(lat) * Math.cos(sLat) * Math.cos(lon - sunLon * RAD);
      const land = LAND[r][c] === "#";
      row.push(cos >= 0 ? (land ? "L" : ".") : land ? "l" : ",");
    }
    rows.push(row);
  }
  return rows;
}

function plot(g: string[][], x: number, y: number, c: string): void {
  if (x >= 0 && y >= 0 && x < MAP_W && y < MAP_H) g[y][x] = c;
}

/** Joins the track points still ahead; a hop of more than half the map is the date line, so it wraps. */
function drawTrack(g: string[][], pts: number[], from: Place): void {
  const now = Date.now() / 1000;
  let px = colOf(from.lon);
  let py = rowOf(from.lat);
  for (let i = 0; i + 2 < pts.length; i += 3) {
    if (pts[i] <= now) continue;
    const x = colOf(pts[i + 2]);
    const y = rowOf(pts[i + 1]);
    let x0 = px;
    let x1 = x;
    if (x1 - x0 > MAP_W / 2) x0 += MAP_W;
    else if (x0 - x1 > MAP_W / 2) x1 += MAP_W;
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y - py), 1);
    for (let s = 1; s <= steps; s++) {
      const xx = Math.round(x0 + ((x1 - x0) * s) / steps);
      const yy = Math.round(py + ((y - py) * s) / steps);
      // Dotted, so it reads as a path rather than a coastline.
      if ((xx + yy) % 2 === 0) plot(g, ((xx % MAP_W) + MAP_W) % MAP_W, yy, "t");
    }
    px = x;
    py = y;
  }
}

function mapXpm(fix: Fix, track: number[], home: Place | null): string {
  const g = baseMap(fix.sunLat, fix.sunLon);
  drawTrack(g, track, fix);
  if (home) plot(g, colOf(home.lon), rowOf(home.lat), "h");
  const x = colOf(fix.lon);
  const y = rowOf(fix.lat);
  // A sunlit ISS glows yellow; that is when it can be seen from the ground at dusk or dawn.
  const glow = fix.sunlit ? "a" : "s";
  plot(g, x - 1, y, glow);
  plot(g, x + 1, y, glow);
  plot(g, x, y - 1, glow);
  plot(g, x, y + 1, glow);
  plot(g, x, y, "i");
  return `! XPM2\n${MAP_W} ${MAP_H} 9 1\n${MAP_COLORS}` + g.map((r) => r.join("")).join("\n");
}

// ---------------------------------------------------------------- app

type Mode = "pos" | "alt" | "spd" | "dist";
const MODES: Mode[] = ["pos", "alt", "spd", "dist"];

function main(): void {
  const report = (err: unknown) => console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);

  let miles = true;
  let unitsChosen = false;
  try {
    const u = localStorage.getItem("units");
    if (u === "mi" || u === "km") {
      miles = u === "mi";
      unitsChosen = true;
    }
  } catch {
    // Settings decide below.
  }

  let fix: Fix | null = null;
  let track: number[] = [];
  let trackAt = 0;
  let home: Place | null = null;
  let offline = false;
  let mode = 0;
  let stopped = false;
  let pollMs = POLL_MS;

  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let cycleTimer: ReturnType<typeof setInterval> | undefined;

  const shown: Record<string, string> = {};
  let drawing = false;
  let dirty = false;

  const dist = (km: number) => Math.round(miles ? km / KM_PER_MI : km);
  const unit = () => (miles ? "MI" : "KM");

  /** Label, unit (top right), value, value color. */
  function readout(): [string, string, string, string] {
    if (!fix) return ["ISS", "", offline ? "OFFLN" : "...", offline ? RED : GRAY];
    switch (MODES[mode]) {
      case "pos":
        return [
          Math.round(Math.abs(fix.lat)) + "°" + (fix.lat >= 0 ? "N" : "S"),
          "",
          Math.round(Math.abs(fix.lon)) + "°" + (fix.lon >= 0 ? "E" : "W"),
          WHITE,
        ];
      case "alt":
        return ["ALT", unit(), String(dist(fix.altKm)), WHITE];
      case "spd":
        return ["SPD", miles ? "MPH" : "KPH", String(dist(fix.kmh)), WHITE];
      default: {
        if (!home) return ["DIST", "", "?", GRAY];
        const km = groundKm(home, fix);
        return ["DIST", unit(), String(dist(km)), km < NEAR_KM ? YELLOW : WHITE];
      }
    }
  }

  function frame(): Element[] {
    const [label, units, value, color] = readout();
    const pos = fix !== null && MODES[mode] === "pos";
    const els: Element[] = [];
    els.push({
      id: "map",
      type: "xpmbitmap",
      data: fix ? mapXpm(fix, track, home) : "! XPM2\n1 1 1 1\n. c none\n.",
      x: 0,
      y: 0,
      align: "top_left",
    });
    // Position is two values of the same weight; the others are a label over a figure.
    els.push(text("top", label, "small", TEXT_X, 0, "top_left", pos ? WHITE : offline && fix ? RED : GRAY));
    els.push(text("unit", units, "tiny", TEXT_R, 0, "top_right", GRAY));
    // Bold fits four digits beside the map; longer figures drop to small.
    const font = !pos && value.length <= 4 ? "bold" : "small";
    els.push(text("val", value, font, TEXT_X, 16, "bottom_left", color));
    return els;
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

  function poll(): void {
    pollTimer = undefined;
    const wantTrack = Date.now() - trackAt > TRACK_MS;
    fetchFix()
      .then((f) => {
        fix = f;
        offline = false;
        pollMs = POLL_MS;
        if (!wantTrack) return;
        // Spaced from the position request; the API asks for about one request a second.
        return new Promise<void>((done) => setTimeout(done, 1100))
          .then(() => (stopped ? [] : fetchTrack()))
          .then((t) => {
            if (t.length) {
              track = t;
              trackAt = Date.now();
            }
          })
          .catch(report);
      })
      .catch((err) => {
        report(err);
        offline = true;
        pollMs = Math.min(pollMs * 2, POLL_MAX_MS);
      })
      .then(() => {
        if (stopped) return;
        render();
        pollTimer = setTimeout(poll, pollMs);
      });
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
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    try {
      const u = miles ? "mi" : "km";
      if (unitsChosen && localStorage.getItem("units") !== u) localStorage.setItem("units", u);
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
      miles = !miles;
      unitsChosen = true;
      render();
    }
  });

  render();
  startCycle();
  loadSettings(APP)
    .then((v) => {
      if (stopped) return;
      if (!unitsChosen && (v.units === "mi" || v.units === "km")) miles = v.units === "mi";
      return findHome(v.location).then((p) => {
        home = p;
      });
    })
    .catch(report)
    .then(() => {
      if (stopped) return;
      render();
    });
  // Don't wait on home to show the station.
  poll();
}

main();
