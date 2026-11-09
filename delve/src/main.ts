// Delve: a turn-based dungeon crawler. Ten levels down, a dragon guards the Crown.
//
// Wheel: step left / right. OK: step up. Start: step down. Walk into a monster to fight it;
// walk onto the stairs to go deeper. Hold OK: drink a potion. Hold Start: rest a turn.
// Back: quit (the run is saved and resumes next time).
//
// Nothing moves until you do, so the bar's slow drawing never matters: one frame per turn.
import { clear, draw, loadSettings, playStock, text, type Element } from "@shared/bar";
import manifest from "./appmeta/manifest.json";
import {
  drink,
  load,
  MAP_H,
  MAP_W,
  MAX_DEPTH,
  MONSTERS,
  newGame,
  rest,
  save,
  STAIRS,
  step,
  WALL,
  type Events,
  type Game,
} from "./game";

const APP = manifest.id;

const CELL = 2;
const VIEW_W = 29;
const VIEW_H = 8;
const HUD_X = VIEW_W * CELL;
const MSG_MS = 1800;

const GRAY = "#8A8A8AFF";
const WHITE = "#FFFFFFFF";
const GOLD = "#FFD84AFF";
const PINK = "#FF6AB0FF";
const RED = "#FF4A4AFF";

const SOUND_STEP = "shared/sounds/volume_change.snd";
const SOUND_LEVEL = "shared/sounds/calendar_event_starts.snd";
const SOUND_DEATH = "shared/sounds/calendar_reminder_ends.snd";

/** Map colors: visible and remembered walls and floor, stairs, and the things on them. */
const BASE_COLORS =
  ". c none\n" +
  "W c #6A6A8E\n" + // wall, in sight
  "w c #2A2A3C\n" + // wall, remembered
  "F c #262630\n" + // floor, in sight
  "f c #0E0E14\n" + // floor, remembered
  "S c #FFD84A\n" + // stairs, in sight
  "s c #6A5A20\n" + // stairs, remembered
  "@ c #FFFFFF\n" + // you
  "p c #FF6AB0\n" + // potion
  "g c #FFD84A\n" + // gold
  "x c #9AD8FF\n" + // sword
  "a c #A0A0B8\n" + // armor
  "C c #FFE84A\n"; // the crown
const MONSTER_KEYS: Record<string, string> = { rat: "1", bat: "2", goblin: "3", orc: "4", skeleton: "5", troll: "6", dragon: "7" };
let colorTable = BASE_COLORS;
for (const k in MONSTER_KEYS) colorTable += `${MONSTER_KEYS[k]} c ${MONSTERS[k].color}\n`;
const COLOR_COUNT = colorTable.split("\n").length - 1;
const ITEM_KEYS: Record<string, string> = { potion: "p", gold: "g", sword: "x", armor: "a", crown: "C" };

function main(): void {
  const report = (err: unknown) => console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);

  let sound = true;
  let best = 0;
  let game: Game | null = null;
  let msg = "";
  let msgColor = WHITE;
  let msgUntil = 0;
  let led: string | undefined;
  let stopped = false;

  try {
    best = parseInt(localStorage.getItem("best") ?? "", 10) || 0;
    const saved = localStorage.getItem("save");
    if (saved) {
      game = load(saved);
      if (game) {
        msg = `DEPTH ${game.depth}: WELCOME BACK`;
        msgUntil = Date.now() + 2500;
      }
    }
  } catch {
    // A fresh start.
  }

  let msgTimer: ReturnType<typeof setTimeout> | undefined;

  const shown: Record<string, string> = {};
  let drawing = false;
  let dirty = false;

  /** The viewport: the map around you in 2px tiles, scrolled to keep you in view. */
  function viewXpm(g: Game): string {
    const p = g.player;
    const vx = Math.max(0, Math.min(MAP_W - VIEW_W, p.x - (VIEW_W >> 1)));
    const vy = Math.max(0, Math.min(MAP_H - VIEW_H, p.y - (VIEW_H >> 1)));
    const cell: string[] = [];
    for (let y = 0; y < VIEW_H; y++) {
      for (let x = 0; x < VIEW_W; x++) {
        const i = (vy + y) * MAP_W + vx + x;
        const t = g.tiles[i];
        const vis = g.visible[i];
        if (!g.seen[i]) cell.push("..");
        else if (t === WALL) cell.push(vis ? "W" : "w");
        else if (t === STAIRS) cell.push(vis ? "S" : "s");
        else cell.push(vis ? "F" : "f");
      }
    }
    // Things on top: items as a diagonal pair, monsters and you as a full tile.
    const thing = new Array<string>(VIEW_W * VIEW_H);
    for (const it of g.items) {
      const x = it.x - vx;
      const y = it.y - vy;
      if (x >= 0 && y >= 0 && x < VIEW_W && y < VIEW_H && g.visible[it.y * MAP_W + it.x]) thing[y * VIEW_W + x] = "i" + ITEM_KEYS[it.kind];
    }
    for (const m of g.monsters) {
      const x = m.x - vx;
      const y = m.y - vy;
      if (x >= 0 && y >= 0 && x < VIEW_W && y < VIEW_H && g.visible[m.y * MAP_W + m.x]) thing[y * VIEW_W + x] = "m" + MONSTER_KEYS[m.kind];
    }
    thing[(p.y - vy) * VIEW_W + (p.x - vx)] = "m@";

    let out = `! XPM2\n${VIEW_W * CELL} ${VIEW_H * CELL} ${COLOR_COUNT} 1\n${colorTable}`;
    for (let y = 0; y < VIEW_H; y++) {
      let top = "";
      let bottom = "";
      for (let x = 0; x < VIEW_W; x++) {
        const k = y * VIEW_W + x;
        const c = cell[k] === ".." ? "." : cell[k];
        const t = thing[k];
        if (t && t[0] === "m") {
          top += t[1] + t[1];
          bottom += t[1] + t[1];
        } else if (t) {
          top += t[1] + c;
          bottom += c + t[1];
        } else {
          top += c + c;
          bottom += c + c;
        }
      }
      out += top + "\n" + bottom + (y < VIEW_H - 1 ? "\n" : "");
    }
    return out;
  }

  /** The health bar: two pixels wide, filling from the bottom, green to yellow to red. */
  function hpXpm(g: Game | null): string {
    const p = g ? g.player : null;
    const frac = p ? p.hp / p.maxHp : 0;
    const fill = Math.round(frac * 16);
    const col = frac > 0.5 ? "#2EE06A" : frac > 0.25 ? "#FFC83A" : "#FF3A3A";
    const rows: string[] = [];
    for (let y = 0; y < 16; y++) rows.push(16 - y <= fill ? "hh" : "dd");
    return `! XPM2\n2 16 2 1\nh c ${col}\nd c #2A1414\n` + rows.join("\n");
  }

  function frame(): Element[] {
    const g = game;
    const showMsg = Date.now() < msgUntil ? msg : "";
    let title = "";
    if (!g) title = best ? `DELVE  BEST D${best}` : "DELVE";
    else if (g.over === "dead") title = `SLAIN BY ${g.killedBy} ON D${g.depth}`;
    else if (g.over === "won") title = `YOU WIN! ${g.player.gold} GOLD`;
    const playing = !!g && !g.over;
    // Messages go to whichever edge is further from you.
    const top = g ? g.player.y - Math.max(0, Math.min(MAP_H - VIEW_H, g.player.y - (VIEW_H >> 1))) >= VIEW_H / 2 : true;
    return [
      {
        id: "view",
        type: "xpmbitmap",
        data: g ? viewXpm(g) : "! XPM2\n1 1 1 1\n. c none\n.",
        x: playing ? 0 : -HUD_X,
        y: 0,
        align: "top_left",
      },
      { id: "hp", type: "xpmbitmap", data: hpXpm(g), x: HUD_X + 1, y: 0, align: "top_left" },
      text("depth", g ? "D" + g.depth : "", "tiny", 72, 0, "top_right", GRAY),
      text("potions", g ? "+" + g.player.potions : "", "tiny", 72, 8, "mid_right", PINK),
      text("gold", g ? String(g.player.gold) : "", "tiny", 72, 16, "bottom_right", GOLD),
      text("title", title, "small", HUD_X / 2, 4, "center", g && g.over === "dead" ? RED : g && g.over === "won" ? GOLD : WHITE, {
        width: HUD_X,
        scroll_rate: 1500,
        scroll_start_delay: 800,
        scroll_repeat_delay: 1500,
      }),
      text("hint", g ? (g.over ? "OK: AGAIN" : "") : "OK TO START", "tiny", HUD_X / 2, 13, "center", GRAY),
      text("msg", playing ? showMsg : "", "small", 0, top ? -1 : 16, top ? "top_left" : "bottom_left", msgColor, {
        width: HUD_X,
        scroll_rate: 1500,
        scroll_start_delay: 600,
        scroll_repeat_delay: 1000,
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

  function play(path: string): void {
    if (sound) playStock(APP, path).catch(report);
  }

  function say(text: string, color: string): void {
    msg = text;
    msgColor = color;
    msgUntil = Date.now() + MSG_MS;
    if (msgTimer !== undefined) clearTimeout(msgTimer);
    msgTimer = setTimeout(() => {
      msgTimer = undefined;
      render();
    }, MSG_MS + 50);
  }

  /** Shows what a turn did: the last message, and light and sound for the big moments. */
  function after(ev: Events): void {
    const g = game!;
    // The last two things that happened, colored by the most important.
    if (ev.msgs.length) say(ev.msgs.slice(-2).join("  "), ev.hurt ? RED : ev.levelUp || ev.pickup ? GOLD : WHITE);
    if (g.over) {
      const reached = g.over === "won" ? MAX_DEPTH + 1 : g.depth;
      if (reached > best) {
        best = reached;
        try {
          localStorage.setItem("best", String(best));
        } catch {
          // The record just won't survive a restart.
        }
      }
      try {
        localStorage.removeItem("save");
      } catch {
        // Nothing to resume anyway.
      }
      led = g.over === "won" ? "#FFD84AFF" : "#FF2020FF";
      play(g.over === "won" ? SOUND_LEVEL : SOUND_DEATH);
    } else if (ev.descended || ev.levelUp) {
      led = ev.descended ? "#4A9BFFFF" : "#FFD84AFF";
      play(SOUND_LEVEL);
    } else if (ev.hurt) led = "#FF2020FF";
    else if (ev.pickup) play(SOUND_STEP);
    render();
  }

  function saveGame(): void {
    if (!game || game.over) return;
    try {
      localStorage.setItem("save", save(game));
    } catch (err) {
      report(err);
    }
  }

  function quit(): void {
    stopped = true;
    if (msgTimer !== undefined) clearTimeout(msgTimer);
    saveGame();
    clear(APP).catch(report);
    setTimeout(unbind, 0);
  }

  function handle(event: BusyInputEvent): void {
    if (stopped) return;
    const g = game;
    const playing = !!g && !g.over;
    if (event.key === "encoder") {
      if (playing) after(step(g!, event.delta, 0));
      return;
    }
    if (event.key === "back") {
      if (event.action === "short") quit();
      return;
    }
    if (!playing) {
      if (event.action === "short" && event.key === "ok") {
        game = newGame();
        say("DEPTH 1", WHITE);
        render();
      }
      return;
    }
    if (event.action === "short") after(step(g!, 0, event.key === "ok" ? -1 : 1));
    else if (event.action === "long") after(event.key === "ok" ? drink(g!) : rest(g!));
  }

  const unbind = listen("input", handle);

  if (msgUntil) {
    msgTimer = setTimeout(() => {
      msgTimer = undefined;
      render();
    }, msgUntil - Date.now() + 50);
  }
  render();
  loadSettings(APP)
    .then((v) => {
      sound = v.sound !== false;
    })
    .catch(report);
}

main();
