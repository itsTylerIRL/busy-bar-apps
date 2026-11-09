// Breathe: guided breathing. A bar swells as you breathe in, holds, and shrinks as you breathe
// out, with the step and its seconds above it. Box (4-4-4-4), relaxing (4-7-8) or coherent
// (5.5 in, 5.5 out) breathing; the session ends after a few minutes with a chime.
//
// Wheel: pattern (while stopped). OK: start / pause. Back: quit.
//
// The bar's size is worked out from the clock, so a slow frame never throws the rhythm off.
import { clear, draw, loadSettings, playStock, text, type Element } from "@shared/bar";
import manifest from "./appmeta/manifest.json";

const APP = manifest.id;

const BAR_Y = 8;
const BAR_H = 7;
const MIN_W = 4;
const MAX_W = 72;
const FRAME_MS = 250;

const GRAY = "#8A8A8AFF";
const SOFT = "#7FE0D0FF";
const WHITE = "#FFFFFFFF";

const SOUND_END = "shared/sounds/calendar_event_starts.snd";

/** A step: what to do, how long, and where the bar goes (0 empty, 1 full). */
interface Step {
  word: string;
  ms: number;
  to: number;
}

interface Pattern {
  name: string;
  steps: Step[];
}

const PATTERNS: Pattern[] = [
  {
    name: "BOX 4-4-4-4",
    steps: [
      { word: "IN", ms: 4000, to: 1 },
      { word: "HOLD", ms: 4000, to: 1 },
      { word: "OUT", ms: 4000, to: 0 },
      { word: "HOLD", ms: 4000, to: 0 },
    ],
  },
  {
    name: "RELAX 4-7-8",
    steps: [
      { word: "IN", ms: 4000, to: 1 },
      { word: "HOLD", ms: 7000, to: 1 },
      { word: "OUT", ms: 8000, to: 0 },
    ],
  },
  {
    name: "COHERENT 5.5",
    steps: [
      { word: "IN", ms: 5500, to: 1 },
      { word: "OUT", ms: 5500, to: 0 },
    ],
  },
];

type State = "ready" | "run" | "paused" | "done";

/** Eases in and out, so the bar starts and ends each breath gently. */
const ease = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * t);

function barXpm(w: number, glow: number): string {
  // Teal brightening with the breath: a dim edge pixel either side softens the ends.
  const c = Math.round(80 + 100 * glow);
  const hex = (n: number) => (n < 16 ? "0" : "") + n.toString(16);
  const fill = `#${hex(Math.round(c * 0.35))}${hex(c + 40)}${hex(c + 20)}`;
  const edge = `#${hex(Math.round(c * 0.15))}${hex(Math.round((c + 40) * 0.45))}${hex(Math.round((c + 20) * 0.45))}`;
  const x0 = Math.round((MAX_W - w) / 2);
  let row = "";
  for (let x = 0; x < MAX_W; x++) row += x < x0 || x >= x0 + w ? "." : x === x0 || x === x0 + w - 1 ? "e" : "f";
  const rows: string[] = [];
  for (let y = 0; y < BAR_H; y++) rows.push(y === 0 || y === BAR_H - 1 ? row.replace(/f/g, "e") : row);
  return `! XPM2\n${MAX_W} ${BAR_H} 3 1\n. c none\nf c ${fill}\ne c ${edge}\n` + rows.join("\n");
}

function main(): void {
  const report = (err: unknown) => console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);

  let pattern = 0;
  let minutes = 3;
  let sound = true;
  let state: State = "ready";
  /** When the session started, shifted forward by any time spent paused. */
  let startAt = 0;
  let pausedAt = 0;
  let breaths = 0;
  let stopped = false;

  try {
    const p = parseInt(localStorage.getItem("pattern") ?? "", 10);
    if (p >= 0 && p < PATTERNS.length) pattern = p;
  } catch {
    // Start on box breathing.
  }

  let frameTimer: ReturnType<typeof setTimeout> | undefined;

  const shown: Record<string, string> = {};
  let drawing = false;
  let dirty = false;

  const cycleMs = () => PATTERNS[pattern].steps.reduce((a, s) => a + s.ms, 0);

  /** Where in the pattern `elapsed` falls: the step, its index, and how far through it. */
  function at(elapsed: number): { step: Step; i: number; t: number; left: number } {
    const steps = PATTERNS[pattern].steps;
    let ms = elapsed % cycleMs();
    for (let i = 0; i < steps.length; i++) {
      if (ms < steps[i].ms) return { step: steps[i], i, t: ms / steps[i].ms, left: steps[i].ms - ms };
      ms -= steps[i].ms;
    }
    return { step: steps[0], i: 0, t: 0, left: steps[0].ms };
  }

  function frame(): Element[] {
    const p = PATTERNS[pattern];
    let label = p.name;
    let right = "";
    let fill = 0.15;
    let labelColor = GRAY;
    if (state === "ready") right = "OK";
    else if (state === "done") {
      label = "WELL DONE";
      labelColor = SOFT;
      right = breaths + " BREATHS";
      fill = 0.5;
    } else {
      const now = state === "paused" ? pausedAt : Date.now();
      const { step, i, t, left } = at(now - startAt);
      const prev = p.steps[(i - 1 + p.steps.length) % p.steps.length].to;
      fill = prev + (step.to - prev) * ease(t);
      label = state === "paused" ? "PAUSED" : step.word;
      labelColor = state === "paused" ? GRAY : WHITE;
      right = String(Math.ceil(left / 1000));
    }
    const w = Math.round(MIN_W + (MAX_W - MIN_W) * fill);
    return [
      text("label", label, "small", 0, -1, "top_left", labelColor),
      text("right", right, state === "run" ? "small" : "tiny", 72, state === "run" ? -1 : 0, "top_right", state === "run" ? SOFT : GRAY),
      { id: "bar", type: "xpmbitmap", data: barXpm(w, fill), x: 0, y: BAR_Y, align: "top_left" },
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

  /** While running: a frame every quarter second or as soon as the last one is drawn. */
  function loop(): void {
    frameTimer = undefined;
    if (stopped || state !== "run") return;
    // The session ends at the end of a whole breath, at or after the chosen length.
    const breathsDue = Math.ceil((minutes * 60_000) / cycleMs());
    if (Date.now() - startAt >= breathsDue * cycleMs()) {
      breaths = breathsDue;
      state = "done";
      if (sound) playStock(APP, SOUND_END).catch(report);
      render();
      return;
    }
    const t0 = Date.now();
    render();
    frameTimer = setTimeout(loop, Math.max(FRAME_MS - (Date.now() - t0), 20));
  }

  function quit(): void {
    stopped = true;
    if (frameTimer !== undefined) clearTimeout(frameTimer);
    try {
      if (localStorage.getItem("pattern") !== String(pattern)) localStorage.setItem("pattern", String(pattern));
    } catch {
      // Not worth failing the quit over.
    }
    clear(APP).catch(report);
    setTimeout(unbind, 0);
  }

  function handle(event: BusyInputEvent): void {
    if (stopped) return;
    if (event.key === "encoder") {
      if (state === "run") return;
      pattern = (pattern + event.delta + PATTERNS.length) % PATTERNS.length;
      state = "ready";
      render();
      return;
    }
    if (event.action !== "short") return;
    if (event.key === "back") quit();
    else if (event.key === "ok" || event.key === "start") {
      if (state === "run") {
        state = "paused";
        pausedAt = Date.now();
        if (frameTimer !== undefined) clearTimeout(frameTimer);
        frameTimer = undefined;
        render();
      } else if (state === "paused") {
        startAt += Date.now() - pausedAt;
        state = "run";
        loop();
      } else {
        startAt = Date.now();
        state = "run";
        loop();
      }
    }
  }

  const unbind = listen("input", handle);

  render();
  loadSettings(APP)
    .then((v) => {
      if (typeof v.minutes === "number" && v.minutes >= 1) minutes = Math.min(20, v.minutes);
      sound = v.sound !== false;
    })
    .catch(report);
}

main();
