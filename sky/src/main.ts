// Sky: current weather and a 7-day forecast from Open-Meteo, each with a 24-hour chart.
//
// Wheel: Now / today / next six days. OK: back to Now. Start: °F ⇄ °C. Back: quit.
import { clear, draw, loadSettings, text, type Element } from "@shared/bar";
import manifest from "./appmeta/manifest.json";
import { iconXpm } from "./icons";

const APP = manifest.id;

/** Layout: 12px icon, text block, chart on the right. */
const ICON_Y = 2;
const TEXT_X = 15;
const CHART_W = 28;
const CHART_H = 16;
const CHART_X = 72 - CHART_W;
const TEXT_R = CHART_X - 2;

const REFRESH_MS = 15 * 60_000;
const RETRY_MIN_MS = 60_000;
/** Drift back to Now after this long without input. */
const IDLE_MS = 45_000;

const WHITE = "#FFFFFFFF";
const GRAY = "#8A8A8AFF";
const BLUE = "#4A9BFFFF";
const RED = "#FF4455FF";
const LINE = "#FFB030";
const NIGHT = "#0B1433";
const RAIN = "#1D4E9E";
const NOW_MARK = "#6A6A6A";

const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

interface Forecast {
  offset: number;
  nowTemp: number;
  nowCode: number;
  nowDay: boolean;
  /** Index into the hourly arrays of the current hour. */
  nowHour: number;
  /** Hourly from local midnight today, °C / % / 0|1. */
  temp: number[];
  pop: number[];
  isDay: number[];
  dayTime: number[];
  dayCode: number[];
  dayMax: number[];
  dayMin: number[];
  dayPop: number[];
}

// ---------------------------------------------------------------- data

function num(v: unknown): number {
  return typeof v === "number" ? v : NaN;
}

function nums(v: unknown): number[] {
  return Array.isArray(v) ? v.map(num) : [];
}

async function fetchForecast(lat: number, lon: number): Promise<Forecast> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}` +
    "&current=temperature_2m,weather_code,is_day" +
    "&hourly=temperature_2m,precipitation_probability,is_day" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
    "&timezone=auto&forecast_days=7&timeformat=unixtime";
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`forecast HTTP ${res.status}`);
  const j = (await res.json()) as Record<string, Record<string, unknown>> & { utc_offset_seconds: number };
  const cur = j.current;
  const hourly = j.hourly;
  const daily = j.daily;
  const times = nums(hourly.time);
  const nowTime = num(cur.time);
  return {
    offset: j.utc_offset_seconds || 0,
    nowTemp: num(cur.temperature_2m),
    nowCode: num(cur.weather_code),
    nowDay: cur.is_day === 1,
    nowHour: Math.max(0, Math.floor((nowTime - times[0]) / 3600)),
    temp: nums(hourly.temperature_2m),
    pop: nums(hourly.precipitation_probability),
    isDay: nums(hourly.is_day),
    dayTime: nums(daily.time),
    dayCode: nums(daily.weather_code),
    dayMax: nums(daily.temperature_2m_max),
    dayMin: nums(daily.temperature_2m_min),
    dayPop: nums(daily.precipitation_probability_max),
  };
}

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

// ---------------------------------------------------------------- drawing

function deg(c: number, f: boolean): string {
  if (isNaN(c)) return "--";
  return String(Math.round(f ? (c * 9) / 5 + 32 : c));
}

/** 24 hours from `start` as XPM2: night shading, rain-chance bars, the temperature line. */
function chartXpm(fc: Forecast, start: number, mark: number): string {
  const n = Math.min(24, fc.temp.length - start);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const t = fc.temp[start + i];
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  // At least 4°C of range, so a steady day draws flat instead of jagged.
  const mid = (lo + hi) / 2;
  if (hi - lo < 4) {
    lo = mid - 2;
    hi = mid + 2;
  }
  const top = 1;
  const bottom = CHART_H - 2;
  const yOf = (t: number) => Math.round(bottom - ((t - lo) / (hi - lo)) * (bottom - top));
  const hourAt = (x: number) => (x * (n - 1)) / (CHART_W - 1);
  const tempAt = (x: number) => {
    const h = hourAt(x);
    const j = Math.floor(h);
    const f = h - j;
    return j + 1 < n ? fc.temp[start + j] * (1 - f) + fc.temp[start + j + 1] * f : fc.temp[start + j];
  };

  const rows: string[][] = [];
  for (let y = 0; y < CHART_H; y++) rows.push([]);
  let prev = yOf(tempAt(0));
  for (let x = 0; x < CHART_W; x++) {
    const h = start + Math.round(hourAt(x));
    const bg = fc.isDay[h] === 0 ? "n" : ".";
    const rain = Math.round(((fc.pop[h] || 0) / 100) * 7);
    const y = yOf(tempAt(x));
    const y0 = Math.min(prev, y);
    const y1 = Math.max(prev, y);
    for (let yy = 0; yy < CHART_H; yy++) {
      let c = bg;
      if (mark >= 0 && Math.round(((mark - start) * (CHART_W - 1)) / (n - 1)) === x && yy % 2 === 0) c = "k";
      if (yy >= CHART_H - rain) c = "p";
      if (yy >= y0 && yy <= y1) c = "l";
      rows[yy].push(c);
    }
    prev = y;
  }

  let out = `! XPM2\n${CHART_W} ${CHART_H} 5 1\n. c none\nn c ${NIGHT}\np c ${RAIN}\nl c ${LINE}\nk c ${NOW_MARK}\n`;
  out += rows.map((r) => r.join("")).join("\n");
  return out;
}

function main(): void {
  const report = (err: unknown) => console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);

  let fahrenheit = true;
  try {
    const u = localStorage.getItem("units");
    if (u === "C" || u === "F") fahrenheit = u === "F";
  } catch {
    // Settings decide below.
  }
  let unitsFromStore = false;
  try {
    unitsFromStore = localStorage.getItem("units") !== null;
  } catch {
    // Treat as unset.
  }

  let fc: Forecast | null = null;
  let status = "...";
  let view = 0;
  let stopped = false;
  let place: Place | null = null;
  let retryMs = RETRY_MIN_MS;

  let fetchTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  /** What the device shows, by element id, so only changed elements are sent. */
  const shown: Record<string, string> = {};
  let drawing = false;
  let dirty = false;

  const views = () => (fc ? 1 + Math.min(7, fc.dayTime.length) : 1);

  function frame(): Element[] {
    const els: Element[] = [];
    const icon = (code: number, day: boolean) =>
      els.push({ id: "icon", type: "xpmbitmap", data: iconXpm(code, day), x: 0, y: ICON_Y, align: "top_left" });
    const chart = (data: string) => els.push({ id: "chart", type: "xpmbitmap", data, x: CHART_X, y: 0, align: "top_left" });

    if (!fc) {
      // Same element types as a loaded frame: the firmware rejects (400) an id that changes type.
      els.push({ id: "icon", type: "xpmbitmap", data: "! XPM2\n1 1 1 1\n. c none\n.", x: 0, y: ICON_Y, align: "top_left" });
      els.push(text("top", "SKY", "small", TEXT_X, 0, "top_left", GRAY));
      els.push(text("big", status, "small", TEXT_X, 16, "bottom_left", status === "..." ? GRAY : RED));
      els.push(text("side", "", "tiny", TEXT_R, 16, "bottom_right"));
      els.push(text("pop", "", "tiny", TEXT_R, 0, "top_right"));
      chart("! XPM2\n1 1 1 1\n. c none\n.");
      return els;
    }

    if (view === 0) {
      icon(fc.nowCode, fc.nowDay);
      els.push(text("top", status || "NOW", "small", TEXT_X, 0, "top_left", status ? RED : GRAY));
      els.push(text("big", deg(fc.nowTemp, fahrenheit) + "°", "bold", TEXT_X, 16, "bottom_left", WHITE));
      els.push(text("side", "", "tiny", TEXT_R, 16, "bottom_right"));
      // Chance of rain over the next 24 hours.
      let pop = 0;
      for (let i = 0; i < 24; i++) pop = Math.max(pop, fc.pop[fc.nowHour + i] || 0);
      els.push(text("pop", pop >= 20 ? pop + "%" : "", "tiny", TEXT_R, 0, "top_right", BLUE));
      chart(chartXpm(fc, fc.nowHour, -1));
      return els;
    }

    const d = view - 1;
    const name = DAYS[new Date((fc.dayTime[d] + fc.offset) * 1000).getUTCDay()];
    const hi = deg(fc.dayMax[d], fahrenheit) + "°";
    const lo = deg(fc.dayMin[d], fahrenheit);
    icon(fc.dayCode[d], true);
    els.push(text("top", d === 0 ? "TDY" : name, "small", TEXT_X, 0, "top_left", d === 0 ? WHITE : GRAY));
    els.push(text("big", hi, "bold", TEXT_X, 16, "bottom_left", WHITE));
    // The low tucks in beside the high when there is room for it.
    els.push(text("side", hi.length <= 3 ? lo : "", "tiny", TEXT_R, 16, "bottom_right", GRAY));
    const pop = fc.dayPop[d] || 0;
    els.push(text("pop", pop >= 20 ? pop + "%" : "", "tiny", TEXT_R, 0, "top_right", BLUE));
    chart(chartXpm(fc, d * 24, d === 0 ? fc.nowHour : -1));
    return els;
  }

  /** Sends the elements that changed; one request in flight, later changes coalesce. */
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
        // Forget what we think is shown so the next frame resends everything.
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

  function schedule(ms: number): void {
    if (stopped) return;
    if (fetchTimer !== undefined) clearTimeout(fetchTimer);
    fetchTimer = setTimeout(() => {
      fetchTimer = undefined;
      refresh();
    }, ms);
  }

  function refresh(): void {
    const where = place ? Promise.resolve(place) : loadSettings(APP).then((v) => findPlace(v.location));
    where
      .then((p) => {
        place = p;
        return fetchForecast(p.lat, p.lon);
      })
      .then((f) => {
        if (stopped) return;
        fc = f;
        status = "";
        if (view >= views()) view = 0;
        retryMs = RETRY_MIN_MS;
        schedule(REFRESH_MS);
        render();
      })
      .catch((err) => {
        report(err);
        if (stopped) return;
        status = "OFFLN";
        render();
        schedule(retryMs);
        retryMs = Math.min(retryMs * 2, REFRESH_MS);
      });
  }

  function goHomeLater(): void {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
    if (view === 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      view = 0;
      render();
    }, IDLE_MS);
  }

  function quit(): void {
    stopped = true;
    if (fetchTimer !== undefined) clearTimeout(fetchTimer);
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    try {
      if (localStorage.getItem("units") !== (fahrenheit ? "F" : "C")) localStorage.setItem("units", fahrenheit ? "F" : "C");
    } catch {
      // Not worth failing the quit over.
    }
    clear(APP).catch(report);
    setTimeout(unbind, 0);
  }

  const unbind = listen("input", (event) => {
    if (stopped) return;
    if (event.key === "encoder") {
      const n = views();
      view = Math.max(0, Math.min(n - 1, view + event.delta));
      goHomeLater();
      render();
      return;
    }
    if (event.action !== "short") return;
    if (event.key === "back") quit();
    else if (event.key === "ok") {
      view = 0;
      goHomeLater();
      render();
    } else if (event.key === "start") {
      fahrenheit = !fahrenheit;
      unitsFromStore = true;
      render();
    }
  });

  render();
  loadSettings(APP)
    .then((v) => {
      if (stopped) return;
      if (!unitsFromStore && (v.units === "C" || v.units === "F")) {
        fahrenheit = v.units === "F";
        render();
      }
    })
    .catch(report)
    .then(() => {
      if (!stopped) refresh();
    });
}

main();
