// Commits: a GitHub contribution graph, from github-contributions-api.jogruber.de.
//
// Wheel: cycle the stat (today, week, streak, year). OK: half year ⇄ full year.
// Start: refresh now. Back: quit. The front LED flashes green when today's count goes up.
import { clear, draw, loadSettings, text, type Element } from "@shared/bar";
import manifest from "./appmeta/manifest.json";

const APP = manifest.id;

const GRAPH_Y = 1;
const PANEL_X = 55;

const REFRESH_MS = 30 * 60_000;
const RETRY_MIN_MS = 60_000;

const WHITE = "#FFFFFFFF";
const GRAY = "#8A8A8AFF";
const GREEN = "#39D353FF";
const RED = "#FF4455FF";

/** GitHub's dark-theme greens, level 0–4; level 0 lifted a little so the grid shows on the LEDs. */
const LEVELS = ["#14261A", "#0E4429", "#006D32", "#26A641", "#39D353"];

interface Graph {
  /** Level 0–4 per day, oldest first; the last entry is today. */
  levels: number[];
  /** Weekday of the last entry, 0 = Sunday. */
  todayDow: number;
  today: number;
  week: number;
  streak: number;
  year: number;
}

async function fetchGraph(user: string): Promise<Graph> {
  const res = await fetch(`https://github-contributions-api.jogruber.de/v4/${encodeURIComponent(user)}?y=last`, {
    headers: { Accept: "application/json" },
  });
  if (res.status === 404) throw new Error("no user");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as { contributions?: { date: string; count: number; level: number }[] };
  const days = j.contributions;
  if (!days || !days.length) throw new Error("no data");

  const levels: number[] = [];
  const counts: number[] = [];
  for (const d of days) {
    levels.push(d.level >= 0 && d.level <= 4 ? d.level : 0);
    counts.push(d.count || 0);
  }
  const last = days[days.length - 1].date.split("-").map((s) => parseInt(s, 10));
  const todayDow = new Date(Date.UTC(last[0], last[1] - 1, last[2])).getUTCDay();

  const n = counts.length;
  let year = 0;
  for (const c of counts) year += c;
  let week = 0;
  for (let i = n - 1 - todayDow; i < n; i++) if (i >= 0) week += counts[i];
  // The current streak still counts while today is empty, the way GitHub shows it.
  let streak = 0;
  for (let i = counts[n - 1] > 0 ? n - 1 : n - 2; i >= 0 && counts[i] > 0; i--) streak++;
  return { levels, todayDow, today: counts[n - 1], week, streak, year };
}

/** Weeks as columns, Sunday on top, newest week on the right; a cell is cw×2 pixels. */
function graphXpm(g: Graph, weeks: number, cw: number): string {
  const w = weeks * cw;
  const h = 14;
  const rows: string[][] = [];
  for (let y = 0; y < h; y++) {
    const row: string[] = [];
    for (let x = 0; x < w; x++) row.push(".");
    rows.push(row);
  }
  const n = g.levels.length;
  for (let back = 0; back < n; back++) {
    const col = weeks - 1 - Math.floor((back + 6 - g.todayDow) / 7);
    if (col < 0) break;
    const dow = (((g.todayDow - back) % 7) + 7) % 7;
    const c = String(g.levels[n - 1 - back]);
    for (let dx = 0; dx < cw; dx++) {
      rows[dow * 2][col * cw + dx] = c;
      rows[dow * 2 + 1][col * cw + dx] = c;
    }
  }
  let out = `! XPM2\n${w} ${h} 6 1\n. c none\n`;
  for (let i = 0; i < LEVELS.length; i++) out += `${i} c ${LEVELS[i]}\n`;
  return out + rows.map((r) => r.join("")).join("\n");
}

type Stat = "today" | "week" | "streak" | "year";
const STATS: Stat[] = ["today", "week", "streak", "year"];
const LABELS: Record<Stat, string> = { today: "TDY", week: "WK", streak: "STK", year: "YR" };

function main(): void {
  const report = (err: unknown) => console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);

  let user = "itsTylerIRL";
  let graph: Graph | null = null;
  let status = "...";
  let stat = 0;
  let fullYear = false;
  let stopped = false;
  let loading = false;
  let retryMs = RETRY_MIN_MS;
  /** Set when today's count rises; the next draw carries the LED flash. */
  let celebrate = false;

  try {
    fullYear = localStorage.getItem("zoom") === "year";
  } catch {
    // Default to the half year.
  }

  let fetchTimer: ReturnType<typeof setTimeout> | undefined;

  const shown: Record<string, string> = {};
  let drawing = false;
  let dirty = false;

  function frame(): Element[] {
    const els: Element[] = [];
    // 26 two-pixel weeks fill the space beside the panel; a full year fits only at one pixel.
    const data = graph ? (fullYear ? graphXpm(graph, 53, 1) : graphXpm(graph, 26, 2)) : "! XPM2\n1 1 1 1\n. c none\n.";
    els.push({ id: "graph", type: "xpmbitmap", data, x: 0, y: GRAPH_Y, align: "top_left" });
    if (!graph) {
      els.push(text("label", "GH", "small", PANEL_X, 0, "top_left", GRAY));
      els.push(text("val", status, "small", PANEL_X, 16, "bottom_left", status === "..." ? GRAY : RED));
      return els;
    }
    const s = STATS[stat];
    const v = graph[s];
    const value = v > 999 ? (v / 1000).toFixed(1) + "K" : String(v);
    els.push(text("label", status || LABELS[s], "small", PANEL_X, 0, "top_left", status ? RED : GRAY));
    // Bold holds two digits in the panel; more drop to small.
    const color = s === "today" && v > 0 ? GREEN : s === "streak" && v >= 7 ? GREEN : WHITE;
    els.push(text("val", value, value.length <= 2 ? "bold" : "small", PANEL_X, 16, "bottom_left", color));
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
    const led = celebrate ? "#00FF40" : undefined;
    celebrate = false;
    drawing = true;
    draw(APP, changed, led)
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
    fetchTimer = setTimeout(() => {
      fetchTimer = undefined;
      refresh();
    }, ms);
  }

  function refresh(): void {
    if (loading) return;
    loading = true;
    fetchGraph(user)
      .then((g) => {
        if (stopped) return;
        // Only a rise on the same day: a new day starts at zero.
        if (graph && g.todayDow === graph.todayDow && g.today > graph.today) celebrate = true;
        graph = g;
        status = "";
        retryMs = RETRY_MIN_MS;
        schedule(REFRESH_MS);
      })
      .catch((err) => {
        report(err);
        if (stopped) return;
        status = err instanceof Error && err.message === "no user" ? "USER?" : "OFFLN";
        schedule(retryMs);
        retryMs = Math.min(retryMs * 2, REFRESH_MS);
      })
      .then(() => {
        loading = false;
        render();
      });
  }

  function quit(): void {
    stopped = true;
    if (fetchTimer !== undefined) clearTimeout(fetchTimer);
    try {
      const z = fullYear ? "year" : "half";
      if ((localStorage.getItem("zoom") ?? "half") !== z) localStorage.setItem("zoom", z);
    } catch {
      // Not worth failing the quit over.
    }
    clear(APP).catch(report);
    setTimeout(unbind, 0);
  }

  const unbind = listen("input", (event) => {
    if (stopped) return;
    if (event.key === "encoder") {
      stat = (stat + event.delta + STATS.length) % STATS.length;
      render();
      return;
    }
    if (event.action !== "short") return;
    if (event.key === "back") quit();
    else if (event.key === "ok") {
      fullYear = !fullYear;
      render();
    } else if (event.key === "start") refresh();
  });

  render();
  loadSettings(APP)
    .then((v) => {
      if (typeof v.user === "string" && v.user.trim()) user = v.user.trim();
    })
    .catch(report)
    .then(() => {
      if (!stopped) refresh();
    });
}

main();
