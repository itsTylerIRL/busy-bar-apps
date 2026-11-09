// Vitals: the bar's own health. Wi-Fi signal, internet round trip, battery and uptime,
// each with a short history chart.
//
// Wheel: pick a page. OK: cycle the pages automatically. Start: check the internet now. Back: quit.
import { clear, draw, text, loadSettings, type Element } from "@shared/bar";
import manifest from "./appmeta/manifest.json";

const APP = manifest.id;
const API = `http://${__BUSY_ADDR__}/api`;

const TEXT_X = 16;
const UNIT_R = 46;
const CHART_X = 48;
const CHART_W = 24;
const CHART_H = 16;

/** One chart column per sample. */
const SAMPLE_MS = 30_000;
const CYCLE_MS = 5000;
/** A round trip still unanswered after this long is charted as a failure. */
const SLOW_MS = 10_000;

const GOOD = "#2EE06A";
const FAIR = "#FFC83A";
const POOR = "#FF4040";
const GRAY = "#8A8A8AFF";
const WHITE = "#FFFFFFFF";

type Page = "wifi" | "net" | "batt" | "up";
const PAGES: Page[] = ["wifi", "net", "batt", "up"];

/** A bounded history: the newest sample last, NaN for a failure. */
class Series {
  values: number[] = [];
  push(v: number): void {
    this.values.push(v);
    if (this.values.length > CHART_W) this.values.shift();
  }
  last(): number | undefined {
    return this.values.length ? this.values[this.values.length - 1] : undefined;
  }
}

async function getJson(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(API + path);
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

// ---------------------------------------------------------------- grading

const wifiColor = (dbm: number) => (dbm >= -60 ? GOOD : dbm >= -72 ? FAIR : POOR);
const pingColor = (ms: number) => (isNaN(ms) ? POOR : ms < 150 ? GOOD : ms < 500 ? FAIR : POOR);
const battColor = (pct: number) => (pct > 50 ? GOOD : pct > 20 ? FAIR : POOR);

/** Bar heights: Wi-Fi from −90 to −30 dBm, ping on a log scale from 10 ms to 3 s, battery 0–100%. */
const wifiHeight = (dbm: number) => ((dbm + 90) / 60) * CHART_H;
const pingHeight = (ms: number) => (Math.log(Math.max(ms, 10) / 10) / Math.log(300)) * CHART_H;
const battHeight = (pct: number) => (pct / 100) * CHART_H;

// ---------------------------------------------------------------- pictures

const COLORS = `g c ${GOOD}\ny c ${FAIR}\nr c ${POOR}\nd c #2C2C2C\nw c #D8D8D8\n`;
const key = (color: string) => (color === GOOD ? "g" : color === FAIR ? "y" : "r");

/** Bars along the bottom, newest on the right; a failure is a full-height red bar. */
function chartXpm(s: Series, height: (v: number) => number, color: (v: number) => string): string {
  const rows: string[][] = [];
  for (let y = 0; y < CHART_H; y++) {
    const row: string[] = [];
    for (let x = 0; x < CHART_W; x++) row.push(".");
    rows.push(row);
  }
  const off = CHART_W - s.values.length;
  for (let i = 0; i < s.values.length; i++) {
    const v = s.values[i];
    const fail = isNaN(v);
    const h = fail ? CHART_H : Math.max(1, Math.min(CHART_H, Math.round(height(v))));
    const c = fail ? "r" : key(color(v));
    for (let y = CHART_H - h; y < CHART_H; y++) rows[y][off + i] = c;
  }
  return `! XPM2\n${CHART_W} ${CHART_H} 6 1\n. c none\n${COLORS}` + rows.map((r) => r.join("")).join("\n");
}

function icon(rows: string[]): string {
  return `! XPM2\n${rows[0].length} ${rows.length} 6 1\n. c none\n${COLORS}` + rows.join("\n");
}

/** Four rising bars, lit by signal quality. */
function wifiIcon(dbm: number | undefined): string {
  const lit = dbm === undefined || isNaN(dbm) ? 0 : dbm >= -55 ? 4 : dbm >= -65 ? 3 : dbm >= -75 ? 2 : 1;
  const c = dbm === undefined || isNaN(dbm) ? "r" : key(wifiColor(dbm));
  const rows: string[] = [];
  for (let y = 0; y < 14; y++) {
    let row = "";
    for (let x = 0; x < 14; x++) {
      const bar = Math.floor(x / 4);
      const h = (bar + 1) * 3 + 2;
      row += x % 4 < 3 && 14 - y <= h ? (bar < lit ? c : "d") : ".";
    }
    rows.push(row);
  }
  return icon(rows);
}

/** A globe: rim, a meridian ellipse and two parallels, colored by the last round trip. */
function netIcon(ms: number | undefined): string {
  const c = ms === undefined ? "d" : key(pingColor(ms));
  const rows: string[] = [];
  for (let y = 0; y < 14; y++) {
    let row = "";
    for (let x = 0; x < 14; x++) {
      const dx = x - 6.5;
      const dy = y - 6.5;
      const r = Math.sqrt(dx * dx + dy * dy);
      const rim = r > 5.6 && r < 6.8;
      // The ellipse x²/a² + y²/b² = 1 with a = 2.8, b = 6.2.
      const e = Math.sqrt((dx * dx) / 7.84 + (dy * dy) / 38.44);
      const meridian = e > 0.78 && e < 1.18 && r < 6;
      const parallel = (y === 4 || y === 9) && r < 6;
      row += rim || meridian || parallel ? c : ".";
    }
    rows.push(row);
  }
  return icon(rows);
}

/** A battery filled to its charge, with a bolt drawn over it while charging. */
function battIcon(pct: number | undefined, charging: boolean): string {
  const fill = pct === undefined ? 0 : Math.round((pct / 100) * 9);
  const c = pct === undefined ? "d" : key(battColor(pct));
  const bolt = ["......", "...ww.", "..ww..", ".wwww.", "..ww..", ".ww..."];
  const rows: string[] = [];
  for (let y = 0; y < 14; y++) {
    let row = "";
    for (let x = 0; x < 14; x++) {
      let ch = ".";
      if (y >= 3 && y <= 10 && (x === 0 || x === 11 || y === 3 || y === 10) && x <= 11) ch = "w";
      else if (x === 12 && y >= 5 && y <= 8) ch = "w";
      else if (y >= 5 && y <= 8 && x >= 2 && x <= 10) ch = x - 2 < fill ? c : "d";
      if (charging && y >= 4 && y <= 9 && x >= 3 && x <= 8 && bolt[y - 4][x - 3] === "w") ch = "w";
      row += ch;
    }
    rows.push(row);
  }
  return icon(rows);
}

function clockIcon(): string {
  const rows: string[] = [];
  for (let y = 0; y < 14; y++) {
    let row = "";
    for (let x = 0; x < 14; x++) {
      const dx = x - 6.5;
      const dy = y - 6.5;
      const r = Math.sqrt(dx * dx + dy * dy);
      const hand = (x === 6 || x === 7) && y >= 3 && y <= 7 ? true : (y === 6 || y === 7) && x >= 7 && x <= 10;
      row += r > 5.6 && r < 6.8 ? "w" : hand ? "g" : ".";
    }
    rows.push(row);
  }
  return icon(rows);
}

// ---------------------------------------------------------------- app

function uptimeText(s: number): [string, string] {
  if (s < 3600) return [String(Math.floor(s / 60)), "MIN"];
  if (s < 2 * 86400) return [String(Math.floor(s / 3600)), "HRS"];
  return [String(Math.floor(s / 86400)), "DAYS"];
}

function main(): void {
  const report = (err: unknown) => console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);

  const wifi = new Series();
  const ping = new Series();
  const batt = new Series();
  let charging = false;
  let bootTime = 0;
  let pingUrl = "http://cp.cloudflare.com/generate_204";
  let pinging = false;
  let page = 0;
  let stopped = false;

  let sampleTimer: ReturnType<typeof setInterval> | undefined;
  let cycleTimer: ReturnType<typeof setInterval> | undefined;

  const shown: Record<string, string> = {};
  let drawing = false;
  let dirty = false;

  function frame(): Element[] {
    let pic: string;
    let label: string;
    let unit = "";
    let value: string;
    let color = WHITE;
    let chart = "! XPM2\n1 1 1 1\n. c none\n.";
    switch (PAGES[page]) {
      case "wifi": {
        const v = wifi.last();
        pic = wifiIcon(v);
        // dBm; the unit doesn't fit beside the label.
        label = "WIFI";
        value = v === undefined ? "..." : isNaN(v) ? "OFF" : String(v);
        if (v !== undefined) color = (isNaN(v) ? POOR : wifiColor(v)) + "FF";
        chart = chartXpm(wifi, wifiHeight, wifiColor);
        break;
      }
      case "net": {
        const v = ping.last();
        pic = netIcon(v);
        label = "PING";
        unit = "MS";
        value = v === undefined ? "..." : isNaN(v) ? "FAIL" : v >= 1000 ? (v / 1000).toFixed(1) + "S" : String(v);
        if (v !== undefined) color = pingColor(v) + "FF";
        if (v !== undefined && !isNaN(v) && v >= 1000) unit = "";
        chart = chartXpm(ping, pingHeight, pingColor);
        break;
      }
      case "batt": {
        const v = batt.last();
        pic = battIcon(v, charging);
        label = charging ? "CHRG" : "BATT";
        unit = "%";
        value = v === undefined ? "..." : String(v);
        if (v !== undefined) color = battColor(v) + "FF";
        chart = chartXpm(batt, battHeight, battColor);
        break;
      }
      default: {
        pic = clockIcon();
        label = "UP";
        if (bootTime) {
          const [n, u] = uptimeText(Date.now() / 1000 - bootTime);
          value = n;
          unit = u;
        } else value = "...";
      }
    }
    return [
      { id: "pic", type: "xpmbitmap", data: pic, x: 0, y: 1, align: "top_left" },
      text("label", label, "small", TEXT_X, -1, "top_left", GRAY),
      text("unit", unit, "tiny", UNIT_R, 0, "top_right", GRAY),
      text("val", value, value.length <= 4 ? "bold" : "small", TEXT_X, 16, "bottom_left", color),
      { id: "chart", type: "xpmbitmap", data: chart, x: CHART_X, y: 0, align: "top_left" },
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

  /** One round trip to the check URL; a slow or failed one is charted as a failure. */
  function checkNet(): void {
    if (pinging) return;
    pinging = true;
    const t0 = Date.now();
    let recorded = false;
    // fetch has no timeout here (no AbortSignal), so a hung request is recorded as failed on time.
    const slow = setTimeout(() => {
      recorded = true;
      ping.push(NaN);
      render();
    }, SLOW_MS);
    fetch(pingUrl, { method: "GET" })
      .then((res) => {
        if (res.status >= 400) throw new Error(`ping HTTP ${res.status}`);
        return res.text();
      })
      .then(() => {
        if (!recorded) ping.push(Date.now() - t0);
      })
      .catch((err) => {
        report(err);
        if (!recorded) ping.push(NaN);
      })
      .then(() => {
        clearTimeout(slow);
        pinging = false;
        render();
      });
  }

  /** The local readings: cheap, answered by the bar itself. */
  function sampleLocal(): void {
    getJson("/wifi/status")
      .then((w) => {
        const connected = w.state === "connected" && typeof w.rssi === "number" && w.rssi < 0;
        wifi.push(connected ? (w.rssi as number) : NaN);
      })
      .catch((err) => {
        report(err);
        wifi.push(NaN);
      })
      .then(() => getJson("/status/power"))
      .then((p) => {
        if (typeof p.battery_charge === "number") batt.push(p.battery_charge);
        charging = p.state === "charging";
      })
      .catch(report)
      .then(() => (bootTime ? null : getJson("/status/system")))
      .then((s) => {
        if (s && typeof s.boot_time === "number") bootTime = s.boot_time;
      })
      .catch(report)
      .then(() => render());
  }

  function sample(): void {
    sampleLocal();
    checkNet();
  }

  function startCycle(): void {
    stopCycle();
    cycleTimer = setInterval(() => {
      page = (page + 1) % PAGES.length;
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
    if (sampleTimer !== undefined) clearInterval(sampleTimer);
    clear(APP).catch(report);
    setTimeout(unbind, 0);
  }

  function handle(event: BusyInputEvent): void {
    if (stopped) return;
    if (event.key === "encoder") {
      stopCycle();
      page = (page + event.delta + PAGES.length) % PAGES.length;
      render();
      return;
    }
    if (event.action !== "short") return;
    if (event.key === "back") quit();
    else if (event.key === "ok") {
      if (cycleTimer === undefined) startCycle();
      else stopCycle();
    } else if (event.key === "start") checkNet();
  }

  const unbind = listen("input", handle);

  render();
  loadSettings(APP)
    .then((v) => {
      if (typeof v.ping_url === "string" && /^https?:\/\//.test(v.ping_url.trim())) pingUrl = v.ping_url.trim();
    })
    .catch(report)
    .then(() => {
      if (stopped) return;
      sample();
      sampleTimer = setInterval(sample, SAMPLE_MS);
    });
}

main();
