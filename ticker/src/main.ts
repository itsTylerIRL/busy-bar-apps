// Crypto: price, change and a sparkline per coin, from Coinbase candles.
//
// Wheel: previous / next coin. OK: next timeframe. Start: toggle auto-rotate. Back: quit.
import { clear, draw, loadSettings, text, type Element } from "@shared/bar";
import manifest from "./appmeta/manifest.json";

const APP = manifest.id;

/** Chart geometry: the right 32 columns of the 72×16 screen. */
const CHART_W = 32;
const CHART_H = 16;
const CHART_X = 72 - CHART_W;
/** Text lives left of the chart with a 2px gap. */
const TEXT_W = CHART_X - 2;

const REFRESH_MS = 60_000;
const FLASH_MS = 1800;
/** After a failed fetch, wait this long before trying the same view again. */
const RETRY_MS = 15_000;

const GRAY = "#8A8A8AFF";
const WHITE = "#FFFFFFFF";
const UP = "#22DD66";
const UP_DIM = "#0B4020";
const DOWN = "#FF4455";
const DOWN_DIM = "#4A1018";
const BASELINE = "#555555";

interface Timeframe {
  label: string;
  /** Candle size in seconds (one of Coinbase's 60, 300, 900, 3600, 21600, 86400). */
  gran: number;
  /** How far back the chart reaches, in seconds. */
  span: number;
}

const TIMEFRAMES: Timeframe[] = [
  { label: "1H", gran: 60, span: 3600 },
  { label: "24H", gran: 900, span: 86400 },
  { label: "7D", gran: 3600, span: 7 * 86400 },
  { label: "30D", gran: 21600, span: 30 * 86400 },
];

/** One chart, downsampled to CHART_W points as soon as it arrives. */
interface Series {
  points: number[];
  open: number;
  last: number;
  at: number;
}

// ---------------------------------------------------------------- formatting

function commas(n: number): string {
  const s = String(Math.round(n));
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ",";
    out += s[i];
  }
  return out;
}

function formatPrice(p: number): string {
  if (p >= 1e6) return (p / 1e6).toFixed(2) + "M";
  if (p >= 1000) return commas(p);
  if (p >= 100) return p.toFixed(2);
  if (p >= 10) return p.toFixed(3);
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.001) return p.toFixed(5).replace(/0+$/, "");
  return p.toExponential(2);
}

/** Pixel width of a price string in a font whose digits advance d px (bold 7, normal 6, condensed 5). */
function priceWidth(s: string, d: number): number {
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    w += c === "," ? 3 : c === "." ? 4 : d;
  }
  return w;
}

/** The widest font that fits the price beside the chart. */
function priceFont(s: string): string {
  if (priceWidth(s, 7) <= TEXT_W) return "bold";
  if (priceWidth(s, 6) <= TEXT_W) return "normal";
  return "condensed";
}

function formatChange(pct: number): string {
  const a = Math.abs(pct);
  return (pct >= 0 ? "+" : "-") + a.toFixed(a < 10 ? 1 : 0) + "%";
}

// ---------------------------------------------------------------- chart

/** Sparkline as XPM2: dim fill under the line, a dotted baseline at the opening price. */
function chartXpm(s: Series): string {
  const up = s.last >= s.open;
  let lo = s.open;
  let hi = s.open;
  for (const v of s.points) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const range = hi - lo || 1;
  const yOf = (v: number) => Math.round((CHART_H - 1) - ((v - lo) / range) * (CHART_H - 1));

  const rows: string[][] = [];
  for (let y = 0; y < CHART_H; y++) {
    const row: string[] = [];
    for (let x = 0; x < CHART_W; x++) row.push(".");
    rows.push(row);
  }

  const base = yOf(s.open);
  for (let x = 0; x < CHART_W; x++) {
    const y = yOf(s.points[x]);
    for (let yy = y + 1; yy < CHART_H; yy++) rows[yy][x] = "d";
    if (x % 2 === 0) rows[base][x] = "b";
    // Join to the previous column so steep moves stay connected.
    const py = x > 0 ? yOf(s.points[x - 1]) : y;
    const top = Math.min(py, y);
    const bottom = Math.max(py, y);
    for (let yy = top; yy <= bottom; yy++) rows[yy][x] = "l";
  }

  let out = `! XPM2\n${CHART_W} ${CHART_H} 4 1\n. c none\nl c ${up ? UP : DOWN}\nd c ${up ? UP_DIM : DOWN_DIM}\nb c ${BASELINE}\n`;
  for (let y = 0; y < CHART_H; y++) out += rows[y].join("") + (y < CHART_H - 1 ? "\n" : "");
  return out;
}

// ---------------------------------------------------------------- data

async function fetchSeries(coin: string, tf: Timeframe): Promise<Series> {
  const end = Math.floor(Date.now() / 1000);
  const start = end - tf.span;
  const url =
    `https://api.exchange.coinbase.com/products/${coin}-USD/candles?granularity=${tf.gran}` +
    `&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`;
  const res = await fetch(url, { headers: { "User-Agent": "busybar-crypto/0.1", Accept: "application/json" } });
  if (res.status === 404) throw new Error("n/a");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // [time, low, high, open, close, volume], newest first.
  const candles = (await res.json()) as number[][];
  if (!candles.length) throw new Error("no data");

  const n = candles.length;
  const closeAt = (i: number) => candles[n - 1 - i][4]; // i counts from the oldest
  const points: number[] = [];
  for (let x = 0; x < CHART_W; x++) {
    const t = (x * (n - 1)) / (CHART_W - 1);
    const j = Math.floor(t);
    const f = t - j;
    points.push(j + 1 < n ? closeAt(j) * (1 - f) + closeAt(j + 1) * f : closeAt(j));
  }
  return { points, open: candles[n - 1][3], last: candles[0][4], at: Date.now() };
}

// ---------------------------------------------------------------- app

function parseCoins(v: unknown): string[] {
  const list = String(v ?? "")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((s) => s.length > 0);
  return list.length ? list.slice(0, 12) : ["BTC", "ETH", "LINK"];
}

function storedInt(key: string, fallback: number): number {
  try {
    const v = parseInt(localStorage.getItem(key) ?? "", 10);
    return isNaN(v) ? fallback : v;
  } catch {
    return fallback;
  }
}

function main(): void {
  const report = (err: unknown) => console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);

  let coins = ["BTC", "ETH", "LINK"];
  let rotateMs = 10_000;
  let coin = 0;
  let tf = storedInt("tf", 1);
  let rotating = true;
  let stopped = false;

  /** Chart cache, keyed "COIN/TF". Bounded by coins × timeframes, CHART_W numbers each. */
  const cache: Record<string, Series> = {};
  const failedAt: Record<string, number> = {};
  const errors: Record<string, string> = {};
  let inflight = "";

  let flash = "";
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  let fetchTimer: ReturnType<typeof setTimeout> | undefined;
  let rotateTimer: ReturnType<typeof setInterval> | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let lastFrame = "";

  const key = () => `${coins[coin]}/${tf}`;

  function frame(): Element[] {
    const sym = coins[coin];
    const s = cache[key()];
    const els: Element[] = [];
    els.push(text("sym", flash || (rotating ? sym : sym + "."), "small", 0, 0, "top_left", flash ? WHITE : GRAY));

    if (!s) {
      const err = errors[key()];
      els.push(text("chg", "", "tiny", TEXT_W, 0, "top_right"));
      els.push(text("px", err ? err : "...", "normal", 0, 16, "bottom_left", err ? DOWN + "FF" : GRAY));
      // Same element type as the real chart: the firmware rejects (400) an id that changes type.
      els.push({ id: "chart", type: "xpmbitmap", data: "! XPM2\n1 1 1 1\n. c none\n.", x: CHART_X, y: 0, align: "top_left" });
      return els;
    }

    const pct = ((s.last - s.open) / s.open) * 100;
    const color = (s.last >= s.open ? UP : DOWN) + "FF";
    const price = formatPrice(s.last);
    els.push(text("chg", formatChange(pct), "small", TEXT_W, 0, "top_right", color));
    els.push(text("px", price, priceFont(price), 0, 16, "bottom_left", WHITE));
    els.push({ id: "chart", type: "xpmbitmap", data: chartXpm(s), x: CHART_X, y: 0, align: "top_left" });
    return els;
  }

  /** Sends the frame if anything visible changed. */
  function render(): void {
    if (stopped) return;
    const els = frame();
    const sig = JSON.stringify(els);
    if (sig === lastFrame) return;
    lastFrame = sig;
    draw(APP, els).catch(report);
  }

  function load(force: boolean): void {
    const k = key();
    const s = cache[k];
    if (!force && s && Date.now() - s.at < REFRESH_MS) return;
    if (!force && failedAt[k] && Date.now() - failedAt[k] < RETRY_MS) return;
    if (inflight === k) return;
    inflight = k;
    const c = coins[coin];
    const t = TIMEFRAMES[tf];
    fetchSeries(c, t)
      .then((series) => {
        cache[k] = series;
        delete errors[k];
        delete failedAt[k];
      })
      .catch((err) => {
        failedAt[k] = Date.now();
        const msg = err instanceof Error ? err.message : String(err);
        errors[k] = msg === "n/a" ? "n/a" : "offline";
        report(`${k} ${msg}`);
      })
      .then(() => {
        if (inflight === k) inflight = "";
        if (key() === k) render();
      });
  }

  /** Coalesces fast wheel spins into one request for where the wheel stops. */
  function loadSoon(): void {
    if (fetchTimer !== undefined) clearTimeout(fetchTimer);
    fetchTimer = setTimeout(() => {
      fetchTimer = undefined;
      load(false);
    }, 350);
  }

  function showFlash(msg: string): void {
    flash = msg;
    if (flashTimer !== undefined) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashTimer = undefined;
      flash = "";
      render();
    }, FLASH_MS);
    render();
  }

  function step(delta: number): void {
    coin = (coin + delta + coins.length) % coins.length;
    render();
    loadSoon();
  }

  function startRotation(): void {
    stopRotation();
    if (rotateMs > 0 && coins.length > 1) rotateTimer = setInterval(() => step(1), rotateMs);
  }

  function stopRotation(): void {
    if (rotateTimer !== undefined) clearInterval(rotateTimer);
    rotateTimer = undefined;
  }

  function quit(): void {
    stopped = true;
    stopRotation();
    if (refreshTimer !== undefined) clearInterval(refreshTimer);
    if (fetchTimer !== undefined) clearTimeout(fetchTimer);
    if (flashTimer !== undefined) clearTimeout(flashTimer);
    try {
      localStorage.setItem("tf", String(tf));
    } catch {
      // Not worth failing the quit over.
    }
    clear(APP).catch(report);
    setTimeout(unbind, 0);
  }

  const unbind = listen("input", (event) => {
    if (stopped) return;
    if (event.key === "encoder") {
      // Turning the wheel takes over from auto-rotate until Start resumes it.
      if (rotating) {
        rotating = false;
        stopRotation();
      }
      step(event.delta);
      return;
    }
    if (event.action !== "short") return;
    if (event.key === "back") quit();
    else if (event.key === "ok") {
      tf = (tf + 1) % TIMEFRAMES.length;
      showFlash(TIMEFRAMES[tf].label);
      load(false);
    } else if (event.key === "start") {
      rotating = !rotating;
      if (rotating) startRotation();
      else stopRotation();
      showFlash(rotating ? "AUTO" : "HOLD");
    }
  });

  if (tf < 0 || tf >= TIMEFRAMES.length) tf = 1;
  render();

  loadSettings(APP)
    .then((values) => {
      if (stopped) return;
      coins = parseCoins(values.coins);
      if (typeof values.rotate_seconds === "number") rotateMs = values.rotate_seconds * 1000;
      if (typeof values.timeframe === "string") {
        const i = TIMEFRAMES.findIndex((t) => t.label === values.timeframe);
        if (i >= 0 && localStorage.getItem("tf") === null) tf = i;
      }
      if (rotateMs <= 0) rotating = false;
      coin = 0;
      render();
      load(true);
      if (rotating) startRotation();
      // Keeps the visible chart fresh; load() skips anything newer than REFRESH_MS.
      refreshTimer = setInterval(() => load(false), 5000);
    })
    .catch(report);
}

main();
