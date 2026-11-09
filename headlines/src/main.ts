// Headlines: a Hacker News ticker. Each story's title scrolls across the bottom row with the
// bar's native text scrolling (no per-frame draws); the top row shows its rank, points,
// comments and age. Stories advance on their own once the title has scrolled past.
//
// Wheel: previous / next story. OK: pause / resume. Start: back to #1 and refresh. Back: quit.
import { clear, draw, loadSettings, text, type Element } from "@shared/bar";
import manifest from "./appmeta/manifest.json";

const APP = manifest.id;
const HN = "https://hacker-news.firebaseio.com/v0";

const LIST_MS = 10 * 60_000;
const ITEM_MS = 5 * 60_000;
const RETRY_MIN_MS = 30_000;
/** Pixels per minute; ~30 px/s reads comfortably on the bar. */
const SCROLL_RATE = 1800;
const SCROLL_START_MS = 1200;
/** The `normal` font advances 6px a character. */
const CHAR_W = 6;
const MIN_DWELL_MS = 7000;
const TAIL_MS = 1500;

const ORANGE = "#FF6600FF";
const WHITE = "#FFFFFFFF";
const GRAY = "#8A8A8AFF";
const RED = "#FF4444FF";

interface Story {
  title: string;
  score: number;
  comments: number;
  time: number;
  at: number;
}

const FEEDS: Record<string, string> = {
  top: "topstories",
  best: "beststories",
  new: "newstories",
  ask: "askstories",
  show: "showstories",
};

/** The bar's fonts are printable ASCII only. */
const SWAP: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "–": "-",
  "—": "-",
  "…": "...",
  " ": " ",
  "×": "x",
  "→": "->",
};
const ACCENTS = "àáâãäåèéêëìíîïòóôõöùúûüñçýÀÁÂÃÄÅÈÉÊËÌÍÎÏÒÓÔÕÖÙÚÛÜÑÇÝ";
const PLAIN = "aaaaaaeeeeiiiiooooouuuuncyAAAAAAEEEEIIIIOOOOOUUUUNCY";

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
      else if (code >= 0xd800 && code <= 0xdbff) i++; // drop an emoji's other half too
    }
  }
  return out.replace(/\s+/g, " ").trim();
}

function age(sec: number): string {
  const m = Math.max(0, Math.floor((Date.now() / 1000 - sec) / 60));
  if (m < 60) return m + "M";
  if (m < 48 * 60) return Math.floor(m / 60) + "H";
  return Math.floor(m / 1440) + "D";
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

async function fetchStory(id: number): Promise<Story> {
  const j = (await getJson(`${HN}/item/${id}.json`)) as Record<string, unknown> | null;
  if (!j || typeof j.title !== "string") throw new Error(`item ${id}: no title`);
  return {
    title: ascii(j.title),
    score: typeof j.score === "number" ? j.score : 0,
    comments: typeof j.descendants === "number" ? j.descendants : 0,
    time: typeof j.time === "number" ? j.time : 0,
    at: Date.now(),
  };
}

function main(): void {
  const report = (err: unknown) => console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);

  let feed = "topstories";
  let count = 30;
  let ids: number[] = [];
  let listAt = 0;
  /** Stories by id; pruned to the ids in the current list. */
  let stories: Record<number, Story> = {};
  const loading: Record<number, boolean> = {};
  let index = 0;
  let paused = false;
  let status = "LOADING";
  let stopped = false;
  let retryMs = RETRY_MIN_MS;

  let dwellTimer: ReturnType<typeof setTimeout> | undefined;
  let listTimer: ReturnType<typeof setTimeout> | undefined;

  const shown: Record<string, string> = {};
  let drawing = false;
  let dirty = false;

  function frame(): Element[] {
    const s = ids.length ? stories[ids[index]] : undefined;
    const rank = ids.length ? "#" + (index + 1) : "HN";
    const stats = s ? `${s.score}P ${s.comments}C ${age(s.time)}` : "";
    const title = s ? s.title : ids.length ? "..." : status;
    return [
      text("rank", rank, "tiny", 0, 0, "top_left", paused ? WHITE : ORANGE),
      text("stats", stats, "tiny", 72, 0, "top_right", GRAY),
      text("title", title, "normal", 0, 16, "bottom_left", s ? WHITE : status === "LOADING" || ids.length ? GRAY : RED, {
        width: 72,
        scroll_rate: SCROLL_RATE,
        scroll_start_delay: SCROLL_START_MS,
        scroll_repeat_delay: 2000,
      }),
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

  /** Fetches a story if it is missing or stale; renders when the one on screen arrives. */
  function ensure(i: number): void {
    const id = ids[i];
    if (id === undefined || loading[id]) return;
    const s = stories[id];
    if (s && Date.now() - s.at < ITEM_MS) return;
    loading[id] = true;
    fetchStory(id)
      .then((story) => {
        stories[id] = story;
      })
      .catch(report)
      .then(() => {
        delete loading[id];
        if (stopped) return;
        if (ids[index] === id) {
          render();
          schedule();
        }
      });
  }

  /** How long to stay on the current story: until its title has scrolled past once. */
  function dwell(): number {
    const s = stories[ids[index]];
    if (!s) return MIN_DWELL_MS;
    const over = s.title.length * CHAR_W - 72;
    if (over <= 0) return MIN_DWELL_MS;
    return Math.max(MIN_DWELL_MS, SCROLL_START_MS + ((over + 72) / SCROLL_RATE) * 60_000 + TAIL_MS);
  }

  function schedule(): void {
    if (dwellTimer !== undefined) clearTimeout(dwellTimer);
    dwellTimer = undefined;
    if (paused || stopped || !ids.length) return;
    dwellTimer = setTimeout(() => {
      dwellTimer = undefined;
      go(1);
    }, dwell());
  }

  function go(delta: number): void {
    if (!ids.length) return;
    index = (index + delta + ids.length) % ids.length;
    ensure(index);
    // Have the next one ready before it is needed.
    ensure((index + 1) % ids.length);
    render();
    schedule();
  }

  function loadList(): void {
    if (listTimer !== undefined) clearTimeout(listTimer);
    listTimer = undefined;
    getJson(`${HN}/${feed}.json`)
      .then((list) => {
        if (stopped) return;
        const fresh = (Array.isArray(list) ? list : []).filter((n) => typeof n === "number").slice(0, count) as number[];
        if (!fresh.length) throw new Error("empty list");
        // Keep showing the same story if it is still in the list.
        const current = ids[index];
        ids = fresh;
        const at = ids.indexOf(current);
        index = at >= 0 ? at : 0;
        const keep: Record<number, Story> = {};
        for (const id of ids) if (stories[id]) keep[id] = stories[id];
        stories = keep;
        listAt = Date.now();
        retryMs = RETRY_MIN_MS;
        status = "";
        listTimer = setTimeout(loadList, LIST_MS);
        go(0);
      })
      .catch((err) => {
        report(err);
        if (stopped) return;
        status = "OFFLINE";
        render();
        listTimer = setTimeout(loadList, retryMs);
        retryMs = Math.min(retryMs * 2, LIST_MS);
      });
  }

  function quit(): void {
    stopped = true;
    if (dwellTimer !== undefined) clearTimeout(dwellTimer);
    if (listTimer !== undefined) clearTimeout(listTimer);
    clear(APP).catch(report);
    setTimeout(unbind, 0);
  }

  function handle(event: BusyInputEvent): void {
    if (stopped) return;
    if (event.key === "encoder") {
      go(event.delta);
      return;
    }
    if (event.action !== "short") return;
    if (event.key === "back") quit();
    else if (event.key === "ok") {
      paused = !paused;
      render();
      schedule();
    } else if (event.key === "start") {
      index = 0;
      if (Date.now() - listAt > 60_000) loadList();
      else go(0);
    }
  }

  const unbind = listen("input", handle);

  render();
  loadSettings(APP)
    .then((v) => {
      if (typeof v.feed === "string" && FEEDS[v.feed]) feed = FEEDS[v.feed];
      if (typeof v.count === "number" && v.count >= 1) count = Math.min(50, Math.floor(v.count));
    })
    .catch(report)
    .then(() => {
      if (!stopped) loadList();
    });
}

main();
