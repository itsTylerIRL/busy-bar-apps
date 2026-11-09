// Serpent: snake on a 36×8 board of 2px cells, steered with the wheel. Clockwise turns right,
// counterclockwise turns left; turns queue up, so a quick double click makes a U-turn. Each
// apple grows the snake and speeds it up. Walls and your own tail end the game.
//
// Wheel: turn. OK: start / pause / play again. Back: quit.
//
// The bar draws a full frame in about 250 ms, so the next move is computed while the current
// frame is still being drawn, and the speed is capped at 4 moves a second.
import { clear, draw, loadSettings, playStock, text, type Element } from "@shared/bar";
import manifest from "./appmeta/manifest.json";

const APP = manifest.id;

const GW = 36;
const GH = 8;
const CELL = 2;
const START_SPEED = 3;
const SPEED_STEP = 0.1;
const MAX_SPEED = 4;

const WHITE = "#FFFFFFFF";
const GOLD = "#FFD84AFF";
const RED = "#FF4A4AFF";
const GRAY = "#8A8A8AFF";

const SOUND_EAT = "shared/sounds/volume_change.snd";
const SOUND_OVER = "shared/sounds/calendar_reminder_ends.snd";

/** Right, down, left, up: turning right is +1. */
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

type State = "title" | "play" | "paused" | "over";

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
  /** Cells as x + y * GW, head first. */
  let body: number[] = [];
  let dir = 0;
  const turns: number[] = [];
  let food = -1;
  let score = 0;
  let speed = START_SPEED;
  let stopped = false;
  let led: string | undefined;

  let moveTimer: ReturnType<typeof setTimeout> | undefined;
  let pending: Element[] | null = null;

  const shown: Record<string, string> = {};
  let drawing = false;
  let dirty = false;

  function placeFood(): void {
    const free: number[] = [];
    for (let i = 0; i < GW * GH; i++) if (body.indexOf(i) < 0) free.push(i);
    food = free.length ? free[Math.floor(Math.random() * free.length)] : -1;
  }

  function reset(): void {
    const y = Math.floor(GH / 2);
    body = [6 + y * GW, 5 + y * GW, 4 + y * GW];
    dir = 0;
    turns.length = 0;
    score = 0;
    speed = START_SPEED;
    placeFood();
  }

  /** One step. Returns false when the snake crashed. */
  function move(): boolean {
    const t = turns.shift();
    if (t !== undefined) dir = (dir + t + 4) % 4;
    const hx = (body[0] % GW) + DX[dir];
    const hy = Math.floor(body[0] / GW) + DY[dir];
    if (hx < 0 || hy < 0 || hx >= GW || hy >= GH) return false;
    const head = hx + hy * GW;
    const eating = head === food;
    // The tail moves out of the way this step unless the snake is growing.
    const hit = body.indexOf(head);
    if (hit >= 0 && (eating || hit !== body.length - 1)) return false;
    body.unshift(head);
    if (eating) {
      score++;
      speed = Math.min(MAX_SPEED, speed + SPEED_STEP);
      if (sound) playStock(APP, SOUND_EAT).catch(report);
      placeFood();
    } else body.pop();
    return true;
  }

  function boardXpm(): string {
    // Head bright, fading toward the tail in four shades.
    const cell: string[] = [];
    for (let i = 0; i < GW * GH; i++) cell.push(".");
    for (let k = body.length - 1; k >= 0; k--) {
      const f = k / Math.max(1, body.length - 1);
      cell[body[k]] = k === 0 ? "h" : f < 0.34 ? "a" : f < 0.67 ? "b" : "c";
    }
    if (food >= 0) cell[food] = "f";
    let out = `! XPM2\n${GW * CELL} ${GH * CELL} 7 1\n. c none\nh c #C8FFB0\na c #4AE05A\nb c #2AA040\nc c #1A6A2C\nf c #FF3A3A\nw c #1A1A1A\n`;
    for (let y = 0; y < GH; y++) {
      let row = "";
      for (let x = 0; x < GW; x++) {
        const c = cell[x + y * GW];
        row += c + c;
      }
      out += row + "\n" + row + (y < GH - 1 ? "\n" : "");
    }
    return out;
  }

  function frame(): Element[] {
    let msg = "";
    let msgColor = WHITE;
    if (state === "title") msg = best ? `OK TO PLAY  BEST ${best}` : "OK TO PLAY";
    else if (state === "paused") msg = "PAUSED";
    else if (state === "over") {
      msg = score > 0 && score === best ? `NEW BEST ${score}` : `SCORE ${score}`;
      msgColor = score > 0 && score === best ? GOLD : RED;
    }
    const board = state === "title" ? "! XPM2\n1 1 1 1\n. c none\n." : boardXpm();
    return [
      // Hidden behind the message once the game ends, so the score reads on a clear screen.
      { id: "board", type: "xpmbitmap", data: board, x: state === "over" ? -GW * CELL : 0, y: 0, align: "top_left" },
      text("msg", msg, "small", 36, 8, "center", msgColor),
      text("score", state === "play" || state === "paused" ? String(score) : "", "tiny", 72, 0, "top_right", GRAY),
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
    const flash = led;
    led = undefined;
    drawing = true;
    return draw(APP, changed, flash)
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
    if (stopped || state === "play") return;
    if (drawing) {
      dirty = true;
      return;
    }
    send(frame()).catch(report);
  }

  function gameOver(): void {
    state = "over";
    if (score > best) {
      best = score;
      try {
        localStorage.setItem("best", String(best));
      } catch {
        // The record just won't survive a restart.
      }
    }
    led = "#FF2020FF";
    if (sound) playStock(APP, SOUND_OVER).catch(report);
    pending = null;
    render();
  }

  /** One move per call. The next move is worked out while the bar draws this one. */
  function cycle(): void {
    moveTimer = undefined;
    if (stopped || state !== "play") return;
    if (drawing) {
      moveTimer = setTimeout(cycle, 30);
      return;
    }
    const els = pending ?? frame();
    pending = null;
    const t0 = Date.now();
    const sent = send(els);
    if (!move()) {
      sent.then(gameOver);
      return;
    }
    pending = frame();
    sent.then(() => {
      if (stopped || state !== "play") return;
      moveTimer = setTimeout(cycle, Math.max(0, Math.round(1000 / speed) - (Date.now() - t0)));
    });
  }

  function start(): void {
    state = "play";
    pending = null;
    cycle();
  }

  function quit(): void {
    stopped = true;
    if (moveTimer !== undefined) clearTimeout(moveTimer);
    clear(APP).catch(report);
    setTimeout(unbind, 0);
  }

  function handle(event: BusyInputEvent): void {
    if (stopped) return;
    if (event.key === "encoder") {
      // Two queued turns at most: enough for a U-turn, not enough to run away from the wheel.
      if (state === "play" && turns.length < 2) turns.push(event.delta);
      return;
    }
    if (event.action !== "short") return;
    if (event.key === "back") quit();
    else if (event.key === "ok" || event.key === "start") {
      if (state === "play") {
        state = "paused";
        if (moveTimer !== undefined) clearTimeout(moveTimer);
        moveTimer = undefined;
        render();
      } else if (state === "paused") start();
      else {
        reset();
        start();
      }
    }
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
