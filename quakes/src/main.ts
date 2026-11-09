// Quakes: recent earthquakes from the USGS feed on a small world map. Each quake is a dot
// colored and sized by magnitude; the one being shown is ringed in white, and its magnitude,
// age and place (scrolling) are beside the map. The list steps through on its own, newest first.
//
// Wheel: pick a quake (stops the stepping). OK: resume. Start: refresh now. Back: quit.
import { clear, draw, loadSettings, text, type Element } from "@shared/bar";
import manifest from "./appmeta/manifest.json";
import { LAND, LAT_BOTTOM, LAT_TOP, MAP_H, MAP_W } from "./land";

const APP = manifest.id;
const FEED = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/";

const TEXT_X = MAP_W + 2;
const TEXT_W = 72 - TEXT_X;
const REFRESH_MS = 5 * 60_000;
const RETRY_MIN_MS = 60_000;
const STEP_MS = 8000;
/** At most this many quakes are kept, the newest. */
const KEEP = 40;

const GRAY = "#8A8A8AFF";
const RED = "#FF4444FF";

interface Quake {
  id: string;
  mag: number;
  place: string;
  time: number;
  lat: number;
  lon: number;
}

/** Color by magnitude: yellow, orange, red, magenta. */
function magKey(m: number): string {
  return m >= 7 ? "4" : m >= 6 ? "3" : m >= 5 ? "2" : "1";
}
const MAG_COLORS: Record<string, string> = { "1": "#FFE04A", "2": "#FF9A2A", "3": "#FF3A3A", "4": "#FF4AE0" };

const SWAP: Record<string, string> = { "‘": "'", "’": "'", "–": "-", "—": "-" };
const ACCENTS = "àáâãäåèéêëìíîïòóôõöùúûüñçýōūīāēÀÁÂÃÄÅÈÉÊËÌÍÎÏÒÓÔÕÖÙÚÛÜÑÇÝŌŪĪĀĒ";
const PLAIN = "aaaaaaeeeeiiiiooooouuuuncyouiaeAAAAAAEEEEIIIIOOOOOUUUUNCYOUIAE";

/** The bar's fonts are printable ASCII only. */
function ascii(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const code = s.charCodeAt(i);
    if (code >= 32 && code < 127) out += c;
    else if (SWAP[c]) out += SWAP[c];
    else {
      const k = ACCENTS.indexOf(c);
      if (k >= 0) out += PLAIN[k];
    }
  }
  return out;
}

function age(ms: number): string {
  const m = Math.max(0, Math.floor((Date.now() - ms) / 60_000));
  if (m < 60) return m + "M";
  if (m < 48 * 60) return Math.floor(m / 60) + "H";
  return Math.floor(m / 1440) + "D";
}

async function fetchQuakes(feed: string): Promise<Quake[]> {
  const res = await fetch(`${FEED}${feed}.geojson`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as { features?: unknown[] };
  const out: Quake[] = [];
  // Keep only what is drawn; the rest of the payload goes with `j`.
  for (const f of j.features ?? []) {
    const feat = f as { id?: string; properties?: Record<string, unknown>; geometry?: { coordinates?: number[] } };
    const p = feat.properties ?? {};
    const c = feat.geometry?.coordinates ?? [];
    if (typeof p.mag !== "number" || typeof p.time !== "number" || c.length < 2) continue;
    out.push({
      id: String(feat.id ?? p.time),
      mag: p.mag,
      place: ascii(typeof p.place === "string" ? p.place : "Unknown"),
      time: p.time,
      lon: c[0],
      lat: c[1],
    });
  }
  out.sort((a, b) => b.time - a.time);
  return out.slice(0, KEEP);
}

const colOf = (lon: number) => Math.min(MAP_W - 1, Math.floor(((((lon + 180) % 360) + 360) % 360) / (360 / MAP_W)));
const rowOf = (lat: number) =>
  Math.max(0, Math.min(MAP_H - 1, Math.floor(((LAT_TOP - lat) / (LAT_TOP - LAT_BOTTOM)) * MAP_H)));

function mapXpm(quakes: Quake[], sel: number): string {
  const g: string[][] = [];
  for (let r = 0; r < MAP_H; r++) {
    const row: string[] = [];
    for (let c = 0; c < MAP_W; c++) row.push(LAND[r][c] === "#" ? "L" : ".");
    g.push(row);
  }
  const plot = (x: number, y: number, ch: string) => {
    if (x >= 0 && y >= 0 && x < MAP_W && y < MAP_H) g[y][x] = ch;
  };
  // Oldest first, so newer and bigger quakes draw on top; the selected one last of all.
  for (let i = quakes.length - 1; i >= 0; i--) {
    if (i === sel) continue;
    const q = quakes[i];
    const x = colOf(q.lon);
    const y = rowOf(q.lat);
    const k = magKey(q.mag);
    plot(x, y, k);
    if (q.mag >= 6) {
      plot(x - 1, y, k);
      plot(x + 1, y, k);
      plot(x, y - 1, k);
      plot(x, y + 1, k);
    }
  }
  if (sel >= 0 && sel < quakes.length) {
    const q = quakes[sel];
    const x = colOf(q.lon);
    const y = rowOf(q.lat);
    for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]])
      plot(x + dx, y + dy, "w");
    plot(x, y, magKey(q.mag));
  }
  let colors = ". c #0A1E3C\nL c #1F4A2A\nw c #FFFFFF\n";
  for (const k in MAG_COLORS) colors += `${k} c ${MAG_COLORS[k]}\n`;
  return `! XPM2\n${MAP_W} ${MAP_H} 7 1\n${colors}` + g.map((r) => r.join("")).join("\n");
}

function main(): void {
  const report = (err: unknown) => console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);

  let feed = "4.5_day";
  let alertMag = 6;
  let quakes: Quake[] = [];
  let seen: Record<string, boolean> | null = null;
  let sel = 0;
  let status = "...";
  let stopped = false;
  let retryMs = RETRY_MIN_MS;
  let led: string | undefined;

  let fetchTimer: ReturnType<typeof setTimeout> | undefined;
  let stepTimer: ReturnType<typeof setInterval> | undefined;

  const shown: Record<string, string> = {};
  let drawing = false;
  let dirty = false;

  function frame(): Element[] {
    const q = quakes[sel];
    const els: Element[] = [{ id: "map", type: "xpmbitmap", data: mapXpm(quakes, q ? sel : -1), x: 0, y: 0, align: "top_left" }];
    if (!q) {
      els.push(text("mag", status === "..." ? "..." : status, "bold", TEXT_X, -1, "top_left", status === "..." ? GRAY : RED));
      els.push(text("age", "", "tiny", 72, 0, "top_right", GRAY));
      els.push(text("place", status === "..." ? "..." : "", "small", TEXT_X, 16, "bottom_left", GRAY, { width: TEXT_W }));
      return els;
    }
    // The magnitude in bold, colored by size; "M" would crowd the age beside it.
    els.push(text("mag", q.mag.toFixed(1), "bold", TEXT_X, -1, "top_left", MAG_COLORS[magKey(q.mag)] + "FF"));
    els.push(text("age", age(q.time), "tiny", 72, 0, "top_right", status ? RED : GRAY));
    els.push(
      text("place", q.place, "small", TEXT_X, 16, "bottom_left", "#FFFFFFFF", {
        width: TEXT_W,
        scroll_rate: 1500,
        scroll_start_delay: 1000,
        scroll_repeat_delay: 1500,
      }),
    );
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

  function schedule(ms: number): void {
    if (stopped) return;
    if (fetchTimer !== undefined) clearTimeout(fetchTimer);
    fetchTimer = setTimeout(refresh, ms);
  }

  function refresh(): void {
    fetchTimer = undefined;
    fetchQuakes(feed)
      .then((list) => {
        if (stopped) return;
        // Flash for a big quake that wasn't in the last fetch (not on the first one).
        const ids: Record<string, boolean> = {};
        let big = false;
        for (const q of list) {
          ids[q.id] = true;
          if (seen && !seen[q.id] && q.mag >= alertMag) big = true;
        }
        seen = ids;
        if (big) {
          led = "#FF3A3AFF";
          sel = 0;
        }
        const current = quakes[sel];
        quakes = list;
        if (!big && current) {
          const at = quakes.findIndex((q) => q.id === current.id);
          sel = at >= 0 ? at : 0;
        }
        if (sel >= quakes.length) sel = 0;
        status = quakes.length ? "" : "NONE";
        retryMs = RETRY_MIN_MS;
        schedule(REFRESH_MS);
      })
      .catch((err) => {
        report(err);
        if (stopped) return;
        status = "OFFLN";
        schedule(retryMs);
        retryMs = Math.min(retryMs * 2, REFRESH_MS);
      })
      .then(() => render());
  }

  function startStep(): void {
    stopStep();
    stepTimer = setInterval(() => {
      if (quakes.length < 2) return;
      sel = (sel + 1) % quakes.length;
      render();
    }, STEP_MS);
  }

  function stopStep(): void {
    if (stepTimer !== undefined) clearInterval(stepTimer);
    stepTimer = undefined;
  }

  function quit(): void {
    stopped = true;
    stopStep();
    if (fetchTimer !== undefined) clearTimeout(fetchTimer);
    clear(APP).catch(report);
    setTimeout(unbind, 0);
  }

  function handle(event: BusyInputEvent): void {
    if (stopped) return;
    if (event.key === "encoder") {
      if (!quakes.length) return;
      stopStep();
      sel = (sel + event.delta + quakes.length) % quakes.length;
      render();
      return;
    }
    if (event.action !== "short") return;
    if (event.key === "back") quit();
    else if (event.key === "ok") startStep();
    else if (event.key === "start") refresh();
  }

  const unbind = listen("input", handle);

  render();
  startStep();
  loadSettings(APP)
    .then((v) => {
      if (v.feed === "4.5_day" || v.feed === "2.5_day" || v.feed === "significant_month") feed = v.feed;
      if (typeof v.alert === "number") alertMag = v.alert;
    })
    .catch(report)
    .then(() => {
      if (!stopped) refresh();
    });
}

main();
