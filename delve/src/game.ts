// Delve's rules: dungeon generation, line of sight, monsters, items, combat and levels.
// No I/O here, so the whole game can be played and tested off the device.

export const MAP_W = 48;
export const MAP_H = 24;
export const MAX_DEPTH = 10;
const SIGHT = 5;
const MAX_POTIONS = 9;
const REGEN_TURNS = 8;

export const WALL = 0;
export const FLOOR = 1;
export const STAIRS = 2;

export interface MonsterKind {
  name: string;
  hp: number;
  dmg: [number, number];
  xp: number;
  color: string;
  /** Chance of a random move instead of a purposeful one. */
  erratic: number;
}

export const MONSTERS: Record<string, MonsterKind> = {
  rat: { name: "RAT", hp: 3, dmg: [1, 2], xp: 1, color: "#B07A4A", erratic: 0.2 },
  bat: { name: "BAT", hp: 2, dmg: [1, 2], xp: 1, color: "#9A7AE0", erratic: 0.5 },
  goblin: { name: "GOBLIN", hp: 6, dmg: [1, 3], xp: 3, color: "#4AC04A", erratic: 0.1 },
  orc: { name: "ORC", hp: 10, dmg: [2, 4], xp: 5, color: "#D05A3A", erratic: 0.1 },
  skeleton: { name: "SKELETON", hp: 13, dmg: [2, 5], xp: 7, color: "#E8E8E8", erratic: 0 },
  troll: { name: "TROLL", hp: 20, dmg: [3, 6], xp: 11, color: "#3AA0A0", erratic: 0 },
  dragon: { name: "DRAGON", hp: 40, dmg: [4, 9], xp: 40, color: "#FF3AE0", erratic: 0 },
};

/** Which monsters each depth draws from. */
function pool(depth: number): string[] {
  if (depth <= 1) return ["rat", "rat", "bat"];
  if (depth === 2) return ["rat", "bat", "goblin"];
  if (depth <= 4) return ["bat", "goblin", "goblin", "orc"];
  if (depth <= 6) return ["goblin", "orc", "orc", "skeleton"];
  if (depth <= 8) return ["orc", "skeleton", "skeleton", "troll"];
  return ["skeleton", "troll", "troll"];
}

export type ItemKind = "potion" | "gold" | "sword" | "armor" | "crown";

export interface Monster {
  x: number;
  y: number;
  kind: string;
  hp: number;
  /** Has it seen the player? Then it keeps chasing. */
  awake: boolean;
}

export interface Item {
  x: number;
  y: number;
  kind: ItemKind;
  amount: number;
}

export interface Player {
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  atk: number;
  def: number;
  level: number;
  xp: number;
  gold: number;
  potions: number;
}

export interface Game {
  depth: number;
  turn: number;
  tiles: number[];
  seen: boolean[];
  visible: boolean[];
  monsters: Monster[];
  items: Item[];
  player: Player;
  /** "" while playing, else "dead" or "won". */
  over: "" | "dead" | "won";
  killedBy: string;
}

/** What happened on a turn, for the screen: messages, plus cues for sound and light. */
export interface Events {
  msgs: string[];
  hurt: boolean;
  levelUp: boolean;
  descended: boolean;
  pickup: boolean;
}

// ---------------------------------------------------------------- randomness

/** A small seedable generator (mulberry32), so a run can be replayed in tests. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let random: () => number = Math.random;
export function setRandom(r: () => number): void {
  random = r;
}
const roll = (a: number, b: number) => a + Math.floor(random() * (b - a + 1));
const pick = <T>(xs: T[]) => xs[Math.floor(random() * xs.length)];

const idx = (x: number, y: number) => y * MAP_W + x;
const inMap = (x: number, y: number) => x >= 0 && y >= 0 && x < MAP_W && y < MAP_H;

// ---------------------------------------------------------------- generation

interface Room {
  x: number;
  y: number;
  w: number;
  h: number;
}

const center = (r: Room): [number, number] => [r.x + (r.w >> 1), r.y + (r.h >> 1)];

function carveRooms(tiles: number[]): Room[] {
  const rooms: Room[] = [];
  for (let tries = 0; tries < 60 && rooms.length < 9; tries++) {
    const w = roll(4, 9);
    const h = roll(3, 5);
    const r = { x: roll(1, MAP_W - w - 2), y: roll(1, MAP_H - h - 2), w, h };
    // Keep a wall between rooms.
    if (rooms.some((o) => r.x <= o.x + o.w && o.x <= r.x + r.w && r.y <= o.y + o.h && o.y <= r.y + r.h)) continue;
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) tiles[idx(x, y)] = FLOOR;
    rooms.push(r);
  }
  // Left to right, so consecutive rooms are near each other and corridors stay short.
  rooms.sort((a, b) => a.x - b.x);
  for (let i = 1; i < rooms.length; i++) {
    const [ax, ay] = center(rooms[i - 1]);
    const [bx, by] = center(rooms[i]);
    // An L-shaped corridor, bending one way or the other.
    const bendX = random() < 0.5;
    for (let x = Math.min(ax, bx); x <= Math.max(ax, bx); x++) tiles[idx(x, bendX ? ay : by)] = FLOOR;
    for (let y = Math.min(ay, by); y <= Math.max(ay, by); y++) tiles[idx(bendX ? bx : ax, y)] = FLOOR;
  }
  return rooms;
}

function freeSpot(g: Game, room: Room): [number, number] | null {
  for (let tries = 0; tries < 20; tries++) {
    const x = roll(room.x, room.x + room.w - 1);
    const y = roll(room.y, room.y + room.h - 1);
    if (g.tiles[idx(x, y)] !== FLOOR) continue;
    if (x === g.player.x && y === g.player.y) continue;
    if (g.monsters.some((m) => m.x === x && m.y === y) || g.items.some((i) => i.x === x && i.y === y)) continue;
    return [x, y];
  }
  return null;
}

export function newPlayer(): Player {
  return { x: 0, y: 0, hp: 20, maxHp: 20, atk: 3, def: 0, level: 1, xp: 0, gold: 0, potions: 1 };
}

/** Builds a level and puts the player in its first room. */
export function enterLevel(g: Game, depth: number): void {
  g.depth = depth;
  g.tiles = [];
  g.seen = [];
  g.visible = [];
  for (let i = 0; i < MAP_W * MAP_H; i++) {
    g.tiles.push(WALL);
    g.seen.push(false);
    g.visible.push(false);
  }
  g.monsters = [];
  g.items = [];
  let rooms = carveRooms(g.tiles);
  // A rare unlucky layout: try again.
  while (rooms.length < 4) {
    for (let i = 0; i < g.tiles.length; i++) g.tiles[i] = WALL;
    rooms = carveRooms(g.tiles);
  }
  const [px, py] = center(rooms[0]);
  g.player.x = px;
  g.player.y = py;
  const last = rooms[rooms.length - 1];
  const [sx, sy] = center(last);
  if (depth < MAX_DEPTH) g.tiles[idx(sx, sy)] = STAIRS;
  else {
    // The bottom: the crown, and the dragon on it.
    g.items.push({ x: sx, y: sy, kind: "crown", amount: 1 });
    g.monsters.push({ x: sx, y: sy - 1 >= last.y ? sy - 1 : sy + 1, kind: "dragon", hp: MONSTERS.dragon.hp, awake: false });
  }

  const others = rooms.slice(1);
  const kinds = pool(depth);
  for (let i = 0; i < 3 + depth; i++) {
    const spot = freeSpot(g, pick(others));
    if (!spot) continue;
    const kind = pick(kinds);
    g.monsters.push({ x: spot[0], y: spot[1], kind, hp: MONSTERS[kind].hp, awake: false });
  }
  const loot: ItemKind[] = ["gold", "gold", "gold", "potion"];
  if (random() < 0.5) loot.push("potion");
  if (random() < 0.35) loot.push(random() < 0.5 ? "sword" : "armor");
  for (const kind of loot) {
    const spot = freeSpot(g, pick(rooms));
    if (!spot) continue;
    g.items.push({ x: spot[0], y: spot[1], kind, amount: kind === "gold" ? roll(3, 8) * depth : 1 });
  }
  computeFov(g);
}

export function newGame(): Game {
  const g: Game = {
    depth: 1,
    turn: 0,
    tiles: [],
    seen: [],
    visible: [],
    monsters: [],
    items: [],
    player: newPlayer(),
    over: "",
    killedBy: "",
  };
  enterLevel(g, 1);
  return g;
}

// ---------------------------------------------------------------- sight

/** Is there a clear line from (x0, y0) to (x1, y1)? The end tile itself may be a wall. */
function clearLine(g: Game, x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  while (x !== x1 || y !== y1) {
    if ((x !== x0 || y !== y0) && g.tiles[idx(x, y)] === WALL) return false;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return true;
}

export function computeFov(g: Game): void {
  for (let i = 0; i < g.visible.length; i++) g.visible[i] = false;
  const { x: px, y: py } = g.player;
  for (let dy = -SIGHT; dy <= SIGHT; dy++) {
    for (let dx = -SIGHT; dx <= SIGHT; dx++) {
      if (dx * dx + dy * dy > SIGHT * SIGHT + SIGHT) continue;
      const x = px + dx;
      const y = py + dy;
      if (!inMap(x, y) || !clearLine(g, px, py, x, y)) continue;
      g.visible[idx(x, y)] = true;
      g.seen[idx(x, y)] = true;
    }
  }
}

// ---------------------------------------------------------------- turns

const monsterAt = (g: Game, x: number, y: number) => g.monsters.find((m) => m.x === x && m.y === y);
const walkable = (g: Game, x: number, y: number) => inMap(x, y) && g.tiles[idx(x, y)] !== WALL;

const xpToNext = (level: number) => level * 6;

function gainXp(g: Game, n: number, ev: Events): void {
  const p = g.player;
  p.xp += n;
  while (p.xp >= xpToNext(p.level)) {
    p.xp -= xpToNext(p.level);
    p.level++;
    p.maxHp += 4;
    p.hp = Math.min(p.maxHp, p.hp + 6);
    p.atk++;
    ev.levelUp = true;
    ev.msgs.push(`LEVEL ${p.level}!`);
  }
}

function attack(g: Game, m: Monster, ev: Events): void {
  const kind = MONSTERS[m.kind];
  m.awake = true;
  if (random() < 0.15) {
    ev.msgs.push(`MISS ${kind.name}`);
    return;
  }
  const dmg = roll(Math.max(1, g.player.atk - 1), g.player.atk + 1);
  m.hp -= dmg;
  if (m.hp <= 0) {
    g.monsters.splice(g.monsters.indexOf(m), 1);
    ev.msgs.push(`${kind.name} DIES`);
    gainXp(g, kind.xp, ev);
  } else ev.msgs.push(`HIT ${kind.name} ${dmg}`);
}

function pickUp(g: Game, ev: Events): void {
  const p = g.player;
  for (let i = g.items.length - 1; i >= 0; i--) {
    const it = g.items[i];
    if (it.x !== p.x || it.y !== p.y) continue;
    if (it.kind === "potion" && p.potions >= MAX_POTIONS) {
      ev.msgs.push("POTIONS FULL");
      continue;
    }
    g.items.splice(i, 1);
    ev.pickup = true;
    if (it.kind === "gold") {
      p.gold += it.amount;
      ev.msgs.push(`+${it.amount} GOLD`);
    } else if (it.kind === "potion") {
      p.potions++;
      ev.msgs.push("POTION");
    } else if (it.kind === "sword") {
      p.atk++;
      ev.msgs.push("SWORD! ATK+1");
    } else if (it.kind === "armor") {
      p.def++;
      ev.msgs.push("ARMOR! DEF+1");
    } else {
      g.over = "won";
      ev.msgs.push("THE CROWN!");
    }
  }
}

function monstersAct(g: Game, ev: Events): void {
  const p = g.player;
  for (const m of g.monsters.slice()) {
    if (g.over) return;
    const kind = MONSTERS[m.kind];
    if (g.visible[idx(m.x, m.y)]) m.awake = true;
    if (!m.awake) continue;
    const dist = Math.abs(m.x - p.x) + Math.abs(m.y - p.y);
    if (dist === 1 && random() >= kind.erratic) {
      if (random() < 0.2) continue; // it misses
      const dmg = Math.max(1, roll(kind.dmg[0], kind.dmg[1]) - p.def);
      p.hp -= dmg;
      ev.hurt = true;
      ev.msgs.push(`${kind.name} HITS ${dmg}`);
      if (p.hp <= 0) {
        p.hp = 0;
        g.over = "dead";
        g.killedBy = kind.name;
      }
      continue;
    }
    // Step toward the player (or at random, for erratic ones), never onto another monster.
    const steps: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let best: [number, number] | null = null;
    if (random() < kind.erratic) best = pick(steps);
    else {
      let bestD = dist;
      for (const [dx, dy] of steps) {
        const d = Math.abs(m.x + dx - p.x) + Math.abs(m.y + dy - p.y);
        if (d < bestD && walkable(g, m.x + dx, m.y + dy) && !monsterAt(g, m.x + dx, m.y + dy)) {
          bestD = d;
          best = [dx, dy];
        }
      }
    }
    if (!best) continue;
    const nx = m.x + best[0];
    const ny = m.y + best[1];
    if (walkable(g, nx, ny) && !monsterAt(g, nx, ny) && !(nx === p.x && ny === p.y)) {
      m.x = nx;
      m.y = ny;
    }
  }
}

function endTurn(g: Game, ev: Events): void {
  if (!g.over) monstersAct(g, ev);
  g.turn++;
  const p = g.player;
  if (!g.over && g.turn % REGEN_TURNS === 0 && p.hp < p.maxHp) p.hp++;
  computeFov(g);
}

const noEvents = (): Events => ({ msgs: [], hurt: false, levelUp: false, descended: false, pickup: false });

/** The player steps (or attacks) one tile. A step into a wall costs nothing. */
export function step(g: Game, dx: number, dy: number): Events {
  const ev = noEvents();
  if (g.over) return ev;
  const p = g.player;
  const nx = p.x + dx;
  const ny = p.y + dy;
  const m = monsterAt(g, nx, ny);
  if (m) attack(g, m, ev);
  else if (walkable(g, nx, ny)) {
    p.x = nx;
    p.y = ny;
    pickUp(g, ev);
    if (!g.over && g.tiles[idx(nx, ny)] === STAIRS) {
      enterLevel(g, g.depth + 1);
      ev.descended = true;
      ev.msgs.push(g.depth === MAX_DEPTH ? `DEPTH ${g.depth}: THE LAIR` : `DEPTH ${g.depth}`);
      return ev;
    }
  } else return ev;
  endTurn(g, ev);
  return ev;
}

export function drink(g: Game): Events {
  const ev = noEvents();
  if (g.over) return ev;
  const p = g.player;
  if (!p.potions) {
    ev.msgs.push("NO POTIONS");
    return ev;
  }
  p.potions--;
  const heal = Math.min(p.maxHp - p.hp, 10 + p.level * 2);
  p.hp += heal;
  ev.msgs.push(`HEALED ${heal}`);
  endTurn(g, ev);
  return ev;
}

export function rest(g: Game): Events {
  const ev = noEvents();
  if (g.over) return ev;
  endTurn(g, ev);
  return ev;
}

// ---------------------------------------------------------------- saving

/** A compact save: the map as a string, seen tiles as a string, and the rest as is. */
export function save(g: Game): string {
  return JSON.stringify({
    d: g.depth,
    t: g.turn,
    m: g.tiles.join(""),
    s: g.seen.map((v) => (v ? "1" : "0")).join(""),
    mo: g.monsters.map((m) => [m.x, m.y, m.kind, m.hp, m.awake ? 1 : 0]),
    it: g.items.map((i) => [i.x, i.y, i.kind, i.amount]),
    p: g.player,
  });
}

export function load(s: string): Game | null {
  try {
    const j = JSON.parse(s);
    if (typeof j.m !== "string" || j.m.length !== MAP_W * MAP_H) return null;
    const g: Game = {
      depth: j.d,
      turn: j.t,
      tiles: j.m.split("").map(Number),
      seen: j.s.split("").map((c: string) => c === "1"),
      visible: [],
      monsters: j.mo.map((m: [number, number, string, number, number]) => ({ x: m[0], y: m[1], kind: m[2], hp: m[3], awake: !!m[4] })),
      items: j.it.map((i: [number, number, ItemKind, number]) => ({ x: i[0], y: i[1], kind: i[2], amount: i[3] })),
      player: j.p,
      over: "",
      killedBy: "",
    };
    for (let i = 0; i < MAP_W * MAP_H; i++) g.visible.push(false);
    computeFov(g);
    return g;
  } catch {
    return null;
  }
}
