// Decider: an oracle, a coin and dice for the small decisions. Pick a mode with the wheel,
// press OK, and it shuffles for half a second before landing on an answer.
//
// Wheel: mode. OK: roll. Back: quit.
import { clear, draw, loadSettings, playStock, text, type Element } from "@shared/bar";
import manifest from "./appmeta/manifest.json";

const APP = manifest.id;

const TEXT_X = 18;
const TEXT_W = 72 - TEXT_X;
const SHUFFLES = 5;
const SHUFFLE_MS = 110;

const GRAY = "#8A8A8AFF";
const WHITE = "#FFFFFFFF";
const YES = "#2EE06AFF";
const MAYBE = "#FFD84AFF";
const NO = "#FF4A4AFF";

const SOUND_LAND = "shared/sounds/volume_change.snd";

type Mode = "oracle" | "coin" | "d6" | "d20";
const MODES: Mode[] = ["oracle", "coin", "d6", "d20"];
const LABELS: Record<Mode, string> = { oracle: "ORACLE", coin: "COIN", d6: "D6", d20: "D20" };
const PROMPTS: Record<Mode, string> = { oracle: "ASK...", coin: "FLIP", d6: "ROLL", d20: "ROLL" };

const ANSWERS: [string, string][] = [
  ["YES", YES],
  ["DO IT", YES],
  ["ABSOLUTELY", YES],
  ["GO FOR IT", YES],
  ["OBVIOUSLY", YES],
  ["ALL SIGNS: YES", YES],
  ["MAYBE", MAYBE],
  ["ASK LATER", MAYBE],
  ["UNCLEAR", MAYBE],
  ["HMM...", MAYBE],
  ["COIN FLIP", MAYBE],
  ["SLEEP ON IT", MAYBE],
  ["NO", NO],
  ["NOPE", NO],
  ["UNLIKELY", NO],
  ["NOT TODAY", NO],
  ["BAD IDEA", NO],
  ["DON'T", NO],
];

// ---------------------------------------------------------------- pictures

function xpm(rows: string[], colors: string): string {
  return `! XPM2\n${rows[0].length} ${rows.length} ${colors.split("\n").length - 1} 1\n${colors}` + rows.join("\n");
}

/** A 14×14 disc, `fill` inside and `rim` on the edge. */
function disc(fill: string, rim: string, extra?: (x: number, y: number) => string | null): string[] {
  const rows: string[] = [];
  for (let y = 0; y < 14; y++) {
    let row = "";
    for (let x = 0; x < 14; x++) {
      const r = Math.sqrt((x - 6.5) ** 2 + (y - 6.5) ** 2);
      const e = extra ? extra(x, y) : null;
      row += r > 6.9 ? "." : e ?? (r > 5.7 ? rim : fill);
    }
    rows.push(row);
  }
  return rows;
}

/** The crystal ball: a purple globe with a highlight, its color hinting at the answer once it lands. */
function ballXpm(tint: string, swirl: number): string {
  const rows = disc("b", "r", (x, y) => {
    if ((x === 4 && y === 3) || (x === 3 && y === 4) || (x === 4 && y === 4)) return "w";
    // A turning swirl while it shuffles.
    const a = Math.atan2(y - 6.5, x - 6.5) + swirl;
    const r = Math.sqrt((x - 6.5) ** 2 + (y - 6.5) ** 2);
    return r < 5 && Math.abs(Math.sin(a * 2 + r)) < 0.25 ? "s" : null;
  });
  return xpm(rows, `. c none\nb c #3A1A6A\nr c #7A4BEF\nw c #FFFFFF\ns c ${tint}\n`);
}

function coinXpm(face: "H" | "T" | "edge"): string {
  if (face === "edge") {
    const rows: string[] = [];
    for (let y = 0; y < 14; y++) rows.push(y >= 5 && y <= 8 ? "...gggggggg..." : "..............");
    return xpm(rows, ". c none\ng c #C8961E\n");
  }
  const H = ["x..x", "x..x", "xxxx", "x..x", "x..x"];
  const T = ["xxxx", ".xx.", ".xx.", ".xx.", ".xx."];
  const glyph = face === "H" ? H : T;
  const rows = disc("g", "d", (x, y) => (x >= 5 && x <= 8 && y >= 4 && y <= 8 && glyph[y - 4][x - 5] === "x" ? "d" : null));
  return xpm(rows, ". c none\ng c #FFC83A\nd c #A0700A\n");
}

/** A die face with 1–6 pips. */
function d6Xpm(n: number): string {
  const pips: Record<number, [number, number][]> = {
    1: [[1, 1]],
    2: [[0, 0], [2, 2]],
    3: [[0, 0], [1, 1], [2, 2]],
    4: [[0, 0], [2, 0], [0, 2], [2, 2]],
    5: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]],
    6: [[0, 0], [2, 0], [0, 1], [2, 1], [0, 2], [2, 2]],
  };
  const rows: string[] = [];
  for (let y = 0; y < 14; y++) {
    let row = "";
    for (let x = 0; x < 14; x++) {
      const corner = (x === 0 || x === 13) && (y === 0 || y === 13);
      let c = corner ? "." : "w";
      for (const [px, py] of pips[n]) {
        const cx = 3 + px * 4;
        const cy = 3 + py * 4;
        if (x >= cx && x <= cx + 1 && y >= cy && y <= cy + 1) c = "p";
      }
      row += c;
    }
    rows.push(row);
  }
  return xpm(rows, ". c none\nw c #F2F2F2\np c #D02030\n");
}

/** A d20 seen face-on: a hexagon outline with the inner triangle. */
function d20Xpm(hot: boolean): string {
  const rows = [
    "......ee......",
    "....ee..ee....",
    "..ee......ee..",
    "ee..........ee",
    "e....tttt....e",
    "e....t..t....e",
    "e...t....t...e",
    "e...t....t...e",
    "e..t......t..e",
    "e..tttttttt..e",
    "ee..........ee",
    "..ee......ee..",
    "....ee..ee....",
    "......ee......",
  ];
  return xpm(rows, `. c none\ne c ${hot ? "#FFD84A" : "#3AA8FF"}\nt c ${hot ? "#FF9A2A" : "#2A6BCF"}\n`);
}

// ---------------------------------------------------------------- app

function main(): void {
  const report = (err: unknown) => console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);

  let mode = 0;
  let sound = true;
  let stopped = false;
  /** The landed result for the current mode, or null before the first roll. */
  let result: { text: string; color: string; value: number } | null = null;
  let shuffling = 0;
  let shuffleValue = 1;
  let swirl = 0;

  try {
    const m = parseInt(localStorage.getItem("mode") ?? "", 10);
    if (m >= 0 && m < MODES.length) mode = m;
  } catch {
    // Start on the oracle.
  }

  let rollTimer: ReturnType<typeof setTimeout> | undefined;

  const shown: Record<string, string> = {};
  let drawing = false;
  let dirty = false;

  function frame(): Element[] {
    const m = MODES[mode];
    let pic: string;
    let value: string;
    let color = WHITE;
    const rolling = shuffling > 0;
    const v = rolling ? shuffleValue : result ? result.value : 1;

    if (m === "oracle") {
      pic = ballXpm(result && !rolling ? result.color.slice(0, 7) : "#C8A0FF", swirl);
      value = rolling ? "..." : result ? result.text : PROMPTS[m];
      color = rolling || !result ? GRAY : result.color;
    } else if (m === "coin") {
      pic = coinXpm(rolling ? (v % 2 ? "edge" : v % 4 ? "H" : "T") : result ? (result.value ? "H" : "T") : "H");
      value = rolling ? "" : result ? result.text : PROMPTS[m];
      color = result && !rolling ? MAYBE : GRAY;
    } else if (m === "d6") {
      pic = d6Xpm(v);
      value = rolling ? String(v) : result ? result.text : PROMPTS[m];
      color = result || rolling ? WHITE : GRAY;
    } else {
      pic = d20Xpm(!rolling && !!result && (result.value === 20 || result.value === 1));
      value = rolling ? String(v) : result ? result.text : PROMPTS[m];
      color = rolling ? GRAY : !result ? GRAY : result.value === 20 ? YES : result.value === 1 ? NO : WHITE;
    }

    // Bold holds about seven characters; longer answers drop to small and scroll if they must.
    const bold = value.length <= 7;
    return [
      { id: "pic", type: "xpmbitmap", data: pic, x: 1, y: 1, align: "top_left" },
      text("label", LABELS[m], "small", TEXT_X, -1, "top_left", GRAY),
      text("val", value, bold ? "bold" : "small", TEXT_X, 16, "bottom_left", color, {
        width: TEXT_W,
        scroll_rate: 1500,
        scroll_start_delay: 800,
        scroll_repeat_delay: 1500,
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

  const randInt = (n: number) => Math.floor(Math.random() * n);

  function land(): void {
    const m = MODES[mode];
    if (m === "oracle") {
      const [t, c] = ANSWERS[randInt(ANSWERS.length)];
      result = { text: t, color: c, value: 0 };
    } else if (m === "coin") {
      const heads = randInt(2) === 1;
      result = { text: heads ? "HEADS" : "TAILS", color: MAYBE, value: heads ? 1 : 0 };
    } else {
      const n = m === "d6" ? 6 : 20;
      const v = 1 + randInt(n);
      result = { text: String(v), color: WHITE, value: v };
    }
    if (sound) playStock(APP, SOUND_LAND).catch(report);
  }

  /** A few quick random frames, then the answer. */
  function shuffle(): void {
    rollTimer = undefined;
    if (stopped) return;
    if (shuffling === 0) {
      land();
      render();
      return;
    }
    shuffling--;
    const m = MODES[mode];
    shuffleValue = m === "d20" ? 1 + randInt(20) : m === "d6" ? 1 + randInt(6) : shuffleValue + 1;
    swirl += 0.9;
    render();
    rollTimer = setTimeout(shuffle, SHUFFLE_MS);
  }

  function roll(): void {
    if (rollTimer !== undefined) return;
    shuffling = SHUFFLES;
    shuffle();
  }

  function quit(): void {
    stopped = true;
    if (rollTimer !== undefined) clearTimeout(rollTimer);
    try {
      if (localStorage.getItem("mode") !== String(mode)) localStorage.setItem("mode", String(mode));
    } catch {
      // Not worth failing the quit over.
    }
    clear(APP).catch(report);
    setTimeout(unbind, 0);
  }

  function handle(event: BusyInputEvent): void {
    if (stopped) return;
    if (event.key === "encoder") {
      if (rollTimer !== undefined) return;
      mode = (mode + event.delta + MODES.length) % MODES.length;
      result = null;
      render();
      return;
    }
    if (event.action !== "short") return;
    if (event.key === "back") quit();
    else if (event.key === "ok" || event.key === "start") roll();
  }

  const unbind = listen("input", handle);

  render();
  loadSettings(APP)
    .then((v) => {
      sound = v.sound !== false;
    })
    .catch(report);
}

main();
