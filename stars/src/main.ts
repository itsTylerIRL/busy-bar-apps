// Stars: a live planetarium. The whole sky around you is unrolled onto the screen: azimuth
// across (north at the left edge, east, south in the middle, west, 5° a pixel) and altitude
// up (the horizon at the bottom row, the zenith at the top). Stars are tinted by their color,
// the planets, moon and sun are drawn where they are, and the sky's color follows the sun.
//
// Wheel: sweep a cursor across what's up, east to west, with its name, altitude and direction.
// OK: hide the cursor. Start: time-lapse (ten minutes a frame) / back to now. Back: quit.
import { clear, draw, loadSettings, text, type Element } from "@shared/bar";
import manifest from "./appmeta/manifest.json";
import { STARS } from "./catalog";
import { moon, planet, PLANETS, siderealDeg, sun, toHorizontal, type Equatorial } from "./sky";

const APP = manifest.id;

const W = 72;
const H = 16;
const DEG_X = 360 / W;
const DEG_Y = 90 / H;

const TICK_MS = 60_000;
const CURSOR_MS = 8000;
const WARP_STEP_MS = 10 * 60_000;
const WARP_FRAME_MS = 300;

const POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

/** Star colors: bright then dim, per tint. */
const TINTS: Record<string, [string, string, string, string]> = {
  b: ["1", "2", "#D4E2FF", "#6E7FA8"],
  w: ["3", "4", "#FFFFFF", "#8E8E8E"],
  y: ["5", "6", "#FFF0B0", "#9A9468"],
  o: ["7", "8", "#FFC080", "#9A7048"],
  r: ["9", "0", "#FF7A5A", "#9A4A3A"],
};
const PLANET_KEYS = "QVAJS";

interface Thing {
  name: string;
  /** The label's color: the star's bright tint even when the dot is dim. */
  label: string;
  alt: number;
  az: number;
  key: string;
  color: string;
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

async function fetchOffset(): Promise<number> {
  const res = await fetch(`http://${__BUSY_ADDR__}/api/time`);
  if (!res.ok) throw new Error(`time HTTP ${res.status}`);
  const j = (await res.json()) as { timestamp?: string };
  const m = String(j.timestamp ?? "").match(/([+-])(\d\d):?(\d\d)$/);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10)) * 60_000;
}

/** Sky color and the faintest star that shows, by how far the sun is below the horizon. */
function skyFor(sunAlt: number): [string, number] {
  if (sunAlt > 0) return ["#0B3A7A", -9];
  if (sunAlt > -6) return ["#0A2152", 0.5];
  if (sunAlt > -12) return ["#06112E", 1.6];
  if (sunAlt > -18) return ["#030818", 2.5];
  return ["none", 9];
}

function main(): void {
  const report = (err: unknown) => console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);

  let place: Place | null = null;
  let offset = 0;
  let stopped = false;
  let noPlace = false;
  let things: Thing[] = [];
  let skyColor = "none";
  let cursorName = "";
  let cursorUntil = 0;
  let warp = false;
  let warpAt = 0;

  let tickTimer: ReturnType<typeof setTimeout> | undefined;
  let warpTimer: ReturnType<typeof setTimeout> | undefined;
  let cursorTimer: ReturnType<typeof setTimeout> | undefined;
  let placeTimer: ReturnType<typeof setTimeout> | undefined;
  let placeRetryMs = 60_000;

  const shown: Record<string, string> = {};
  let drawing = false;
  let dirty = false;

  const skyTime = () => (warp ? warpAt : Date.now());

  /** Everything above the horizon (and visible against the sky) at the sky time, east to west. */
  function compute(): void {
    if (!place) return;
    const ms = skyTime();
    const lst = siderealDeg(ms, place.lon);
    const at = (eq: Equatorial) => toHorizontal(eq, lst, place!.lat);
    const out: Thing[] = [];

    const s = at(sun(ms));
    const [color, limit] = skyFor(s.alt);
    skyColor = color;
    if (s.alt > -1) out.push({ name: "SUN", alt: s.alt, az: s.az, key: "O", color: "#FFE04A", label: "#FFE04A" });

    const mo = moon(ms);
    const mh = at(mo);
    const lit = (1 - Math.cos((mo.elong * Math.PI) / 180)) / 2;
    if (mh.alt > -1) out.push({ name: `MOON ${Math.round(lit * 100)}%`, alt: mh.alt, az: mh.az, key: lit > 0.4 ? "m" : "n", color: "#F0EAD0", label: "#F0EAD0" });

    for (let i = 0; i < PLANETS.length; i++) {
      const p = at(planet(i, ms));
      if (p.alt > 0) out.push({ name: PLANETS[i].name, alt: p.alt, az: p.az, key: PLANET_KEYS[i], color: PLANETS[i].color, label: PLANETS[i].color });
    }

    for (const [name, ra, dec, mag, tint] of STARS) {
      if (mag > limit) continue;
      const h = at({ ra: ra * 15, dec });
      if (h.alt <= 0) continue;
      const t = TINTS[tint];
      out.push({ name, alt: h.alt, az: h.az, key: mag < 1 ? t[0] : t[1], color: mag < 1 ? t[2] : t[3], label: t[2] });
    }
    out.sort((a, b) => a.az - b.az);
    things = out;
  }

  const xOf = (az: number) => Math.floor(az / DEG_X) % W;
  const yOf = (alt: number) => Math.max(0, Math.min(H - 1, H - 1 - Math.floor(alt / DEG_Y)));

  function skyXpm(cursor: Thing | undefined): string {
    const g: string[][] = [];
    for (let y = 0; y < H; y++) {
      const row: string[] = [];
      for (let x = 0; x < W; x++) row.push(".");
      g.push(row);
    }
    const put = (x: number, y: number, c: string) => {
      if (y >= 0 && y < H) g[y][((x % W) + W) % W] = c;
    };
    // Faint compass points along the horizon.
    for (let i = 0; i < 4; i++) put(i * 18, H - 1, i === 0 ? "N" : "k");
    // Stars first, then the planets, moon and sun over them.
    const order = (t: Thing) => ("OmnQVAJS".indexOf(t.key) >= 0 ? 1 : 0);
    for (const pass of [0, 1]) {
      for (const t of things) {
        if (order(t) !== pass) continue;
        const x = xOf(t.az);
        const y = yOf(t.alt);
        if (t.key === "O") {
          put(x, y, "O");
          put(x - 1, y, "O");
          put(x + 1, y, "O");
          put(x, y - 1, "O");
          put(x, y + 1, "O");
        } else if (t.key === "m" || t.key === "n") {
          put(x, y, t.key);
          put(x + 1, y, t.key);
          put(x, y - 1, t.key);
          put(x + 1, y - 1, t.key);
        } else put(x, y, t.key);
      }
    }
    if (cursor) {
      const x = xOf(cursor.az);
      const y = yOf(cursor.alt);
      const big = cursor.key === "O" || cursor.key === "m" || cursor.key === "n" ? 1 : 0;
      for (const [dx, dy] of [[-1 - big, -1 - big], [1 + big, -1 - big], [-1 - big, 1], [1 + big, 1]]) put(x + dx, y + dy, "+");
    }

    let colors = `. c ${skyColor}\nN c #8A3030\nk c #303848\nO c #FFE04A\nm c #F0EAD0\nn c #8A8676\n+ c #FF3A6A\n`;
    for (let i = 0; i < PLANETS.length; i++) colors += `${PLANET_KEYS[i]} c ${PLANETS[i].color}\n`;
    for (const k in TINTS) colors += `${TINTS[k][0]} c ${TINTS[k][2]}\n${TINTS[k][1]} c ${TINTS[k][3]}\n`;
    return `! XPM2\n${W} ${H} ${colors.split("\n").length - 1} 1\n${colors}` + g.map((r) => r.join("")).join("\n");
  }

  function clockText(ms: number): string {
    const d = new Date(ms + offset);
    const h = d.getUTCHours();
    const m = d.getUTCMinutes();
    return (((h + 11) % 12) + 1) + ":" + (m < 10 ? "0" : "") + m + (h < 12 ? "A" : "P");
  }

  function frame(): Element[] {
    const cursorOn = Date.now() < cursorUntil;
    const cursor = cursorOn ? things.find((t) => t.name === cursorName) : undefined;
    let label = "";
    let labelColor = "#FFFFFFFF";
    let right = false;
    if (!place) label = noPlace ? "NO LOCATION" : "...";
    else if (cursor) {
      label = `${cursor.name} ${Math.round(cursor.alt)}° ${POINTS[Math.round(cursor.az / 45) % 8]}`;
      labelColor = cursor.label + "FF";
      // Keep the label on the other half of the screen from what it names.
      right = xOf(cursor.az) < W / 2;
    }
    return [
      { id: "sky", type: "xpmbitmap", data: place ? skyXpm(cursor) : "! XPM2\n1 1 1 1\n. c none\n.", x: 0, y: 0, align: "top_left" },
      text("label", label, "small", right ? W : 0, -1, right ? "top_right" : "top_left", labelColor),
      text("clock", warp ? clockText(warpAt) : "", "tiny", right ? 0 : W, 16, right ? "bottom_left" : "bottom_right", "#FFC83AFF"),
    ];
  }

  function send(els: Element[]): Promise<void> {
    const changed: Element[] = [];
    const sigs: Record<string, string> = {};
    for (const el of els) {
      const sig = JSON.stringify(el);
      if (shown[el.id] !== sig) {
        changed.push(el);
        sigs[el.id] = sig;
      }
    }
    if (!changed.length) return Promise.resolve();
    drawing = true;
    return draw(APP, changed)
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

  function render(): void {
    if (stopped) return;
    if (drawing) {
      dirty = true;
      return;
    }
    send(frame()).catch(report);
  }

  /** Real time: recompute on the minute. */
  function tick(): void {
    tickTimer = setTimeout(() => {
      tickTimer = undefined;
      if (!warp) {
        compute();
        render();
      }
      tick();
    }, TICK_MS - (Date.now() % TICK_MS) + 50);
  }

  /** Time-lapse: the sky advances ten minutes a frame, a frame as fast as the bar takes them. */
  function warpFrame(): void {
    warpTimer = undefined;
    if (stopped || !warp) return;
    const t0 = Date.now();
    warpAt += WARP_STEP_MS;
    compute();
    send(frame()).then(() => {
      if (stopped || !warp) return;
      warpTimer = setTimeout(warpFrame, Math.max(0, WARP_FRAME_MS - (Date.now() - t0)));
    });
  }

  function moveCursor(delta: number): void {
    if (!things.length) return;
    let i = things.findIndex((t) => t.name === cursorName);
    const fresh = Date.now() >= cursorUntil || i < 0;
    if (fresh) {
      // Start from the brightest thing up: the sun or moon, else a planet, else the first star.
      i = things.findIndex((t) => "OmnVJ".indexOf(t.key) >= 0);
      if (i < 0) i = 0;
    } else i = (i + delta + things.length) % things.length;
    cursorName = things[i].name;
    cursorUntil = Date.now() + CURSOR_MS;
    if (cursorTimer !== undefined) clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => {
      cursorTimer = undefined;
      render();
    }, CURSOR_MS + 50);
    render();
  }

  function quit(): void {
    stopped = true;
    for (const t of [tickTimer, warpTimer, cursorTimer, placeTimer]) if (t !== undefined) clearTimeout(t);
    clear(APP).catch(report);
    setTimeout(unbind, 0);
  }

  function handle(event: BusyInputEvent): void {
    if (stopped) return;
    if (event.key === "encoder") {
      moveCursor(event.delta);
      return;
    }
    if (event.action !== "short") return;
    if (event.key === "back") quit();
    else if (event.key === "ok") {
      cursorUntil = 0;
      render();
    } else if (event.key === "start" && place) {
      warp = !warp;
      if (warp) {
        warpAt = Date.now();
        warpFrame();
      } else {
        if (warpTimer !== undefined) clearTimeout(warpTimer);
        warpTimer = undefined;
        compute();
        render();
      }
    }
  }

  const unbind = listen("input", handle);

  /** Settings, then the location; a failed lookup retries with backoff. */
  function locate(): void {
    placeTimer = undefined;
    loadSettings(APP)
      .then((v) => (stopped ? null : findPlace(v.location)))
      .then((p) => {
        if (!p) return;
        place = p;
        noPlace = false;
        compute();
      })
      .catch((err) => {
        report(err);
        noPlace = true;
        if (stopped) return;
        placeTimer = setTimeout(locate, placeRetryMs);
        placeRetryMs = Math.min(placeRetryMs * 2, 30 * 60_000);
      })
      .then(() => render());
  }

  render();
  fetchOffset()
    .then((o) => {
      offset = o;
    })
    .catch(report)
    .then(() => {
      if (stopped) return;
      locate();
      tick();
    });
}

main();
