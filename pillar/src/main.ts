// Pillar: a one-button timing game. The tower grows sideways, one 2px column per layer.
// A block slides up and down beside it; OK drops it, and whatever overhangs the layer
// below is cut off. A perfect drop keeps its size, and three in a row grow it back a pixel.
// Miss entirely and the game is over.
//
// OK: start / drop / play again. Back: quit.
//
// The block's position is a function of the clock, not of frames: a drop lands where the
// block was at the moment of the press even if the screen missed a frame. Frames run only
// while a block is moving, and each one sends just the block's position.
import { clear, draw, loadSettings, playStock, text, type Element } from "@shared/bar";
import manifest from "./appmeta/manifest.json";

const APP = manifest.id;

const H = 16;
const COL = 3; // 2px of layer and a 1px gap
const VISIBLE = 18;
const FIELD_W = VISIBLE * COL;
const START_H = 12;
const FRAME_MS = 70;
/**
 * Pixels per second at the first layer, growing 4% a layer up to the cap. The bar manages
 * about 5 frames a second, so the cap keeps the block within ~4px of where it was last seen.
 */
const SPEED = 7;
const SPEED_MAX = 20;
const SPEED_GROWTH = 1.04;

const WHITE = "#FFFFFFFF";
const GRAY = "#8A8A8AFF";
const RED = "#FF4040FF";
const GOLD = "#FFD84AFF";

/** Layer colors, cycling around the hue wheel. */
const HUES = ["#FF5A5A", "#FF9A3A", "#FFD84A", "#7BE05A", "#3AD6B0", "#3AA8FF", "#7A6BFF", "#D46BFF"];
const HUE_KEYS = "abcdefgh";

const SOUND_PERFECT = "shared/sounds/volume_change.snd";
const SOUND_OVER = "shared/sounds/calendar_reminder_ends.snd";

interface Layer {
  y: number;
  h: number;
}

type State = "title" | "play" | "over";

/** Bounces 0 → span → 0: a triangle wave over distance travelled. */
function bounce(dist: number, span: number): number {
  if (span <= 0) return 0;
  const p = dist % (2 * span);
  return p <= span ? p : 2 * span - p;
}

function main(): void {
  const report = (err: unknown) => console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);

  let sound = true;
  let best = 0;
  try {
    best = parseInt(localStorage.getItem("best") ?? "", 10) || 0;
  } catch {
    // No record yet.
  }

  let state: State = "title";
  let layers: Layer[] = [{ y: (H - START_H) / 2, h: START_H }];
  let moverH = START_H;
  let moverFrom = 0; // which end the block starts from: alternates so it's not always the same
  let layerAt = 0;
  let streak = 0;
  let stopped = false;
  let led: string | undefined;
  /** A drop happens on the press; its release must not also count as "play again". */
  let swallowShort = false;

  let frameTimer: ReturnType<typeof setInterval> | undefined;

  const shown: Record<string, string> = {};
  let drawing = false;
  let dirty = false;

  const score = () => layers.length - 1;
  const speed = () => Math.min(SPEED_MAX, SPEED * Math.pow(SPEED_GROWTH, score()));

  /** The block's top edge at time `t`. */
  function moverY(t: number): number {
    const span = H - moverH;
    const d = bounce(((t - layerAt) / 1000) * speed(), span);
    return Math.round(moverFrom ? span - d : d);
  }

  /** Which layer sits in the leftmost visible column; the view scrolls once the tower fills it. */
  const firstVisible = () => Math.max(0, layers.length + 1 - VISIBLE);

  function towerXpm(): string {
    const rows: string[][] = [];
    for (let y = 0; y < H; y++) {
      const row: string[] = [];
      for (let x = 0; x < FIELD_W; x++) row.push(".");
      rows.push(row);
    }
    const first = firstVisible();
    for (let i = first; i < layers.length; i++) {
      const L = layers[i];
      const c = state === "over" && i === layers.length - 1 ? "x" : HUE_KEYS[i % HUES.length];
      const x0 = (i - first) * COL;
      for (let y = L.y; y < L.y + L.h; y++) {
        rows[y][x0] = c;
        rows[y][x0 + 1] = c;
      }
    }
    let colors = "";
    for (let i = 0; i < HUES.length; i++) colors += `${HUE_KEYS[i]} c ${HUES[i]}\n`;
    return `! XPM2\n${FIELD_W} ${H} ${HUES.length + 2} 1\n. c none\nx c #FFFFFF\n${colors}` + rows.map((r) => r.join("")).join("\n");
  }

  function moverXpm(): string {
    const c = HUES[layers.length % HUES.length];
    let out = `! XPM2\n2 ${moverH} 1 1\nm c ${c}\n`;
    for (let y = 0; y < moverH; y++) out += "mm" + (y < moverH - 1 ? "\n" : "");
    return out;
  }

  function frame(): Element[] {
    const now = Date.now();
    const col = layers.length - firstVisible();
    const playing = state === "play";
    let msg = "";
    let msgColor = WHITE;
    if (state === "title") msg = "OK TO PLAY";
    else if (state === "over") {
      msg = score() > 0 && score() === best ? "NEW BEST" : "MISSED";
      msgColor = score() === best && score() > 0 ? GOLD : RED;
    }
    return [
      // Hidden once the game ends, so the result reads on a clear screen.
      { id: "tower", type: "xpmbitmap", data: towerXpm(), x: state === "over" ? -FIELD_W : 0, y: 0, align: "top_left" },
      {
        id: "mover",
        type: "xpmbitmap",
        // Off-screen rather than removed, so the element keeps its type.
        data: moverXpm(),
        x: playing ? col * COL : -10,
        y: playing ? moverY(now) : 0,
        align: "top_left",
      },
      text("msg", msg, "small", FIELD_W / 2 + 6, 8, "center", msgColor),
      text("score", String(score()), "bold", 72, -1, "top_right", state === "over" ? WHITE : GRAY),
      text("best", best ? "B" + best : "", "tiny", 72, 16, "bottom_right", GRAY),
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
          // A breath between frames, so the bar's web server isn't kept saturated.
          setTimeout(render, 30);
        }
      });
  }

  function startFrames(): void {
    if (frameTimer === undefined) frameTimer = setInterval(render, FRAME_MS);
  }

  function stopFrames(): void {
    if (frameTimer !== undefined) clearInterval(frameTimer);
    frameTimer = undefined;
  }

  function play(path: string): void {
    if (sound) playStock(APP, path).catch(report);
  }

  function nextLayer(): void {
    layerAt = Date.now();
    moverFrom = layers.length % 2;
  }

  function newGame(): void {
    layers = [{ y: (H - START_H) / 2, h: START_H }];
    moverH = START_H;
    streak = 0;
    state = "play";
    nextLayer();
    startFrames();
    render();
  }

  function dropBlock(): void {
    const now = Date.now();
    const y = moverY(now);
    const prev = layers[layers.length - 1];
    const top = Math.max(y, prev.y);
    const bottom = Math.min(y + moverH, prev.y + prev.h);
    if (bottom <= top) {
      // Missed: the block lands nowhere.
      state = "over";
      stopFrames();
      if (score() > best) {
        best = score();
        try {
          localStorage.setItem("best", String(best));
        } catch {
          // The record just won't survive a restart.
        }
      }
      led = "#FF2020FF";
      play(SOUND_OVER);
      render();
      return;
    }
    if (y === prev.y) {
      streak++;
      led = "#FFD84AFF";
      play(SOUND_PERFECT);
      // Three perfect drops in a row win back a pixel, up to the starting size.
      let h = moverH;
      let ly = prev.y;
      if (streak % 3 === 0 && h < START_H) {
        h++;
        if (ly + h > H) ly = H - h;
      }
      layers.push({ y: ly, h });
      moverH = h;
    } else {
      streak = 0;
      layers.push({ y: top, h: bottom - top });
      moverH = bottom - top;
    }
    nextLayer();
    render();
  }

  function quit(): void {
    stopped = true;
    stopFrames();
    clear(APP).catch(report);
    setTimeout(unbind, 0);
  }

  function handle(event: BusyInputEvent): void {
    if (stopped) return;
    if (event.key === "encoder") return;
    // A drop is a timing call: act on the key going down, not on its release.
    if (event.key === "ok" && event.action === "press" && state === "play") {
      swallowShort = true;
      dropBlock();
      return;
    }
    if (event.action !== "short") return;
    if (event.key === "ok" && swallowShort) {
      swallowShort = false;
      return;
    }
    if (event.key === "back") quit();
    else if ((event.key === "ok" || event.key === "start") && state !== "play") newGame();
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
