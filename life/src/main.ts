// Life: Conway's Game of Life on the 72×16 screen. Cells are colored by age, from a bright
// newborn cyan to deep purple, and a cell that just died leaves a faint trace.
//
// The world is the screen plus a hidden margin whose outer band is cleared every generation,
// so gliders fly off and die out of sight instead of piling up as debris at the edges.
//
// Wheel: pick a pattern. OK: restart it. Start: pause / resume. Back: quit.
import { clear, draw, loadSettings, text, type Element } from "@shared/bar";
import manifest from "./appmeta/manifest.json";

const APP = manifest.id;

const SW = 72;
const SH = 16;
/**
 * The world is bit-sliced: each row is WORDS 24-bit numbers, bit 23 the leftmost pixel of a
 * word. Word 0 and the last word are a hidden 24-column margin on each side, and MR hidden
 * rows sit above and below. One generation is a few thousand bitwise operations; the
 * cell-by-cell version took over two seconds a generation on the bar.
 */
const BITS = 24;
const FULL = 0xffffff;
const WORDS = 5;
const MR = 4;
const ROWS = SH + 2 * MR;
const N = ROWS * WORDS;
/** Columns and rows at the world's edge that are cleared every generation. */
const KILL_LEFT = 0x3 << (BITS - 2);
const KILL_RIGHT = 0x3;

const NAME_MS = 1500;
/** A world that repeats with period 1 or 2 for this many generations is done. */
const STALE_GENS = 12;
/** Soup is reseeded after this many generations even if it never settles. */
const SOUP_MAX_GENS = 900;

// Age colors: newborn, young (2–3), adult (4–6), old (7+); then the trace of a cell that just died.
const PALETTE = ". c none\na c #A8FFF0\nb c #3AD6FF\nc c #3A7BFF\nd c #7A4BEF\nf c #1C1640\n";
/** Character for each age 0–7, and for a dead cell with a trace. */
const AGE_CH = ".abbcccd";
const TRACE_CH = "f";

/** Two pixels at a time: index = (a0 pair) | (a1 pair) << 2 | (a2 pair) << 4 | (trace pair) << 6. */
const PAIR: string[] = [];
for (let i = 0; i < 256; i++) {
  let pair = "";
  for (let k = 1; k >= 0; k--) {
    const age = ((i >> k) & 1) | (((i >> (2 + k)) & 1) << 1) | (((i >> (4 + k)) & 1) << 2);
    pair += age ? AGE_CH[age] : (i >> (6 + k)) & 1 ? TRACE_CH : ".";
  }
  PAIR.push(pair);
}

type Cells = [number, number][];

/** Bill Gosper's glider gun, 36×9. */
const GUN: Cells = [
  [24, 0], [22, 1], [24, 1], [12, 2], [13, 2], [20, 2], [21, 2], [34, 2], [35, 2], [11, 3], [15, 3], [20, 3],
  [21, 3], [34, 3], [35, 3], [0, 4], [1, 4], [10, 4], [16, 4], [20, 4], [21, 4], [0, 5], [1, 5], [10, 5],
  [14, 5], [16, 5], [17, 5], [22, 5], [24, 5], [10, 6], [16, 6], [24, 6], [11, 7], [15, 7], [12, 8], [13, 8],
];
const ACORN: Cells = [[1, 0], [3, 1], [0, 2], [1, 2], [4, 2], [5, 2], [6, 2]];
const R_PENTOMINO: Cells = [[1, 0], [2, 0], [0, 1], [1, 1], [1, 2]];

/** The pulsar, a period-3 oscillator, built from one quadrant mirrored four ways. */
function pulsar(): Cells {
  const q: Cells = [[2, 0], [3, 0], [4, 0], [0, 2], [5, 2], [0, 3], [5, 3], [0, 4], [5, 4], [2, 5], [3, 5], [4, 5]];
  const out: Cells = [];
  for (const [x, y] of q) {
    out.push([x, y], [12 - x, y], [x, 12 - y], [12 - x, 12 - y]);
  }
  return out;
}

interface Pattern {
  name: string;
  /** Cells and where to put the pattern's top-left corner on screen; null for random soup. */
  cells: Cells | null;
  at: [number, number];
}

const PATTERNS: Pattern[] = [
  { name: "SOUP", cells: null, at: [0, 0] },
  { name: "GLIDER GUN", cells: GUN, at: [2, 1] },
  { name: "ACORN", cells: ACORN, at: [40, 6] },
  { name: "R-PENTOMINO", cells: R_PENTOMINO, at: [40, 6] },
  { name: "PULSAR", cells: pulsar(), at: [29, 1] },
];

function main(): void {
  const report = (err: unknown) => console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);

  const zeros = () => {
    const z: number[] = [];
    for (let i = 0; i < N; i++) z.push(0);
    return z;
  };
  /** Live cells, and each cell's age (1–7, saturating) as three bit planes; trace = died last generation. */
  let cur = zeros();
  let nxt = zeros();
  const a0 = zeros();
  const a1 = zeros();
  const a2 = zeros();
  const trace = zeros();

  let pattern = 0;
  let gens = 0;
  let stale = 0;
  /** Hashes of the last two generations, to spot period-1 and period-2 repeats. */
  let h1 = -1;
  let h2 = -2;
  let paused = false;
  let nameUntil = 0;
  let restartAt = 0;
  let stopped = false;
  let speed = 3;

  let stepTimer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  /** The next frame, computed ahead while the current one is being drawn. */
  let pending: Element[] | null = null;
  let nameTimer: ReturnType<typeof setTimeout> | undefined;

  const shown: Record<string, string> = {};
  let drawing = false;
  let dirty = false;

  function setCell(x: number, y: number): void {
    const i = (y + MR) * WORDS + 1 + Math.floor(x / BITS);
    cur[i] |= 1 << (BITS - 1 - (x % BITS));
  }

  /** Brings the age planes in line with `cur`: alive cells age by one up to 7, dead ones reset. */
  function age(): void {
    for (let i = 0; i < N; i++) {
      const alive = cur[i];
      const m = alive & ~(a0[i] & a1[i] & a2[i]);
      const c0 = a0[i] & m;
      const c1 = a1[i] & c0;
      a0[i] = (a0[i] ^ m) & alive;
      a1[i] = (a1[i] ^ c0) & alive;
      a2[i] = (a2[i] ^ c1) & alive;
    }
  }

  function seed(): void {
    for (let i = 0; i < N; i++) {
      cur[i] = 0;
      a0[i] = 0;
      a1[i] = 0;
      a2[i] = 0;
      trace[i] = 0;
    }
    const p = PATTERNS[pattern];
    if (!p.cells) {
      for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) if (Math.random() < 0.33) setCell(x, y);
    } else {
      for (const [x, y] of p.cells) setCell(x + p.at[0], y + p.at[1]);
    }
    age();
    gens = 0;
    stale = 0;
    pending = null;
    h1 = -1;
    h2 = -2;
    restartAt = 0;
  }

  function step(): void {
    let hash = 0;
    let alive = 0;
    for (let r = 0; r < ROWS; r++) {
      for (let w = 0; w < WORDS; w++) {
        const i = r * WORDS + w;
        const was = cur[i];
        let v = 0;
        if (r >= 2 && r < ROWS - 2) {
          const up = cur[i - WORDS];
          const dn = cur[i + WORDS];
          const hasL = w > 0;
          const hasR = w < WORDS - 1;
          const upL = hasL ? cur[i - WORDS - 1] : 0;
          const lf = hasL ? cur[i - 1] : 0;
          const dnL = hasL ? cur[i + WORDS - 1] : 0;
          const upR = hasR ? cur[i - WORDS + 1] : 0;
          const rt = hasR ? cur[i + 1] : 0;
          const dnR = hasR ? cur[i + WORDS + 1] : 0;
          // Nothing within reach: stays empty.
          if (up | was | dn | (upL & 1) | (lf & 1) | (dnL & 1) | ((upR | rt | dnR) >>> (BITS - 1))) {
            // The eight neighbour planes, then a 3-bit ripple counter (s2 s1 s0) over them.
            const hi = BITS - 1;
            const n1 = (up >>> 1) | ((upL & 1) << hi);
            const n2 = ((up << 1) & FULL) | (upR >>> hi);
            const n3 = (was >>> 1) | ((lf & 1) << hi);
            const n4 = ((was << 1) & FULL) | (rt >>> hi);
            const n5 = (dn >>> 1) | ((dnL & 1) << hi);
            const n6 = ((dn << 1) & FULL) | (dnR >>> hi);
            let s0 = up;
            let s1 = 0;
            let s2 = 0;
            let c0 = s0 & dn; s0 ^= dn; let c1 = s1 & c0; s1 ^= c0; s2 ^= c1;
            c0 = s0 & n1; s0 ^= n1; c1 = s1 & c0; s1 ^= c0; s2 ^= c1;
            c0 = s0 & n2; s0 ^= n2; c1 = s1 & c0; s1 ^= c0; s2 ^= c1;
            c0 = s0 & n3; s0 ^= n3; c1 = s1 & c0; s1 ^= c0; s2 ^= c1;
            c0 = s0 & n4; s0 ^= n4; c1 = s1 & c0; s1 ^= c0; s2 ^= c1;
            c0 = s0 & n5; s0 ^= n5; c1 = s1 & c0; s1 ^= c0; s2 ^= c1;
            c0 = s0 & n6; s0 ^= n6; c1 = s1 & c0; s1 ^= c0; s2 ^= c1;
            // Born with exactly 3, survives with 2 or 3. (Eight wraps the counter to 0, which is neither.)
            v = s1 & ~s2 & (s0 | was) & FULL;
            if (w === 0) v &= ~KILL_LEFT;
            else if (w === WORDS - 1) v &= ~KILL_RIGHT;
          }
        }
        nxt[i] = v;
        trace[i] = was & ~v;
        // Age the survivors by one (saturating at 7); the newborn start at 1, the dead at 0.
        if (v | was) {
          const b0 = a0[i];
          const b1 = a1[i];
          const b2 = a2[i];
          const m = v & ~(b0 & b1 & b2);
          const k0 = b0 & m;
          const k1 = b1 & k0;
          a0[i] = (b0 ^ m) & v;
          a1[i] = (b1 ^ k0) & v;
          a2[i] = (b2 ^ k1) & v;
        }
        if (v) {
          alive++;
          hash = (hash * 31 + v + i) | 0;
        }
      }
    }
    const t = cur;
    cur = nxt;
    nxt = t;
    gens++;

    // Done when nothing is left, when it has settled into still lifes and blinkers, or
    // when a soup has simply gone on long enough. Restart after a moment to look at it.
    if (hash === h1 || hash === h2) stale++;
    else stale = 0;
    h2 = h1;
    h1 = hash;
    const done = alive === 0 || stale >= STALE_GENS || (!PATTERNS[pattern].cells && gens >= SOUP_MAX_GENS);
    if (done && !restartAt) restartAt = Date.now() + 2500;
    if (restartAt && Date.now() >= restartAt) seed();
  }

  function boardXpm(): string {
    let out = `! XPM2\n${SW} ${SH} 6 1\n${PALETTE}`;
    for (let y = 0; y < SH; y++) {
      let row = "";
      for (let w = 1; w < WORDS - 1; w++) {
        const i = (y + MR) * WORDS + w;
        const p0 = a0[i];
        const p1 = a1[i];
        const p2 = a2[i];
        const pt = trace[i];
        for (let s = BITS - 2; s >= 0; s -= 2) {
          row += PAIR[((p0 >> s) & 3) | (((p1 >> s) & 3) << 2) | (((p2 >> s) & 3) << 4) | (((pt >> s) & 3) << 6)];
        }
      }
      out += row + (y < SH - 1 ? "\n" : "");
    }
    return out;
  }

  function frame(): Element[] {
    const label = Date.now() < nameUntil ? PATTERNS[pattern].name : paused ? "PAUSED" : "";
    return [
      { id: "board", type: "xpmbitmap", data: boardXpm(), x: 0, y: 0, align: "top_left" },
      text("name", label, "small", 36, 8, "center", "#FFFFFFFF"),
    ];
  }

  /** Sends what differs from the screen; resolves once the bar has answered. One draw at a time. */
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

  /** A one-off redraw for when the generations aren't running (paused, or a label changed). */
  function render(): void {
    if (stopped || running) return;
    if (drawing) {
      dirty = true;
      return;
    }
    send(frame()).catch(report);
  }

  /**
   * One generation per call, paced to the speed setting. The next generation is computed while
   * the bar is still drawing this one, so the rate is set by the slower of the two, not their sum.
   */
  function cycle(): void {
    stepTimer = undefined;
    if (stopped || paused) {
      running = false;
      return;
    }
    // A one-off redraw is still on its way: one draw at a time.
    if (drawing) {
      stepTimer = setTimeout(cycle, 50);
      return;
    }
    const els = pending ?? frame();
    pending = null;
    const t0 = Date.now();
    const sent = send(els);
    step();
    pending = frame();
    sent.then(() => {
      if (stopped || paused) {
        running = false;
        return;
      }
      stepTimer = setTimeout(cycle, Math.max(0, Math.round(1000 / speed) - (Date.now() - t0)));
    });
  }

  function startSteps(): void {
    if (running) return;
    running = true;
    cycle();
  }

  function stopSteps(): void {
    if (stepTimer !== undefined) clearTimeout(stepTimer);
    stepTimer = undefined;
    running = false;
  }

  function showName(): void {
    nameUntil = Date.now() + NAME_MS;
    if (nameTimer !== undefined) clearTimeout(nameTimer);
    nameTimer = setTimeout(() => {
      nameTimer = undefined;
      render();
    }, NAME_MS + 20);
    render();
  }

  function quit(): void {
    stopped = true;
    stopSteps();
    if (nameTimer !== undefined) clearTimeout(nameTimer);
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
      pattern = (pattern + event.delta + PATTERNS.length) % PATTERNS.length;
      seed();
      showName();
      return;
    }
    if (event.action !== "short") return;
    if (event.key === "back") quit();
    else if (event.key === "ok") {
      seed();
      showName();
    } else if (event.key === "start") {
      paused = !paused;
      if (paused) stopSteps();
      else startSteps();
      render();
    }
  }

  const unbind = listen("input", handle);

  try {
    const p = parseInt(localStorage.getItem("pattern") ?? "", 10);
    if (p >= 0 && p < PATTERNS.length) pattern = p;
  } catch {
    // Start with the soup.
  }
  seed();
  showName();
  loadSettings(APP)
    .then((v) => {
      if (typeof v.speed === "number" && v.speed >= 1) speed = Math.min(4, Math.floor(v.speed));
    })
    .catch(report)
    .then(() => {
      if (!stopped && !paused) startSteps();
    });
}

main();
