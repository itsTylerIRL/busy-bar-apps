// 12×12 weather icons as XPM2, composed from a few sprites.

const SIZE = 12;

const PALETTE: Record<string, string> = {
  y: "#FFC020", // sun
  m: "#E8DFA8", // moon
  w: "#E6E9EE", // cloud
  g: "#7C8490", // dark cloud, fog
  b: "#3C8CFF", // rain
  s: "#FFFFFF", // snow
  z: "#FFE14A", // lightning
};

const SUN = [
  ".....yy.....",
  ".y...yy...y.",
  "..y......y..",
  "....yyyy....",
  "...yyyyyy...",
  "yy.yyyyyy.yy",
  "yy.yyyyyy.yy",
  "...yyyyyy...",
  "....yyyy....",
  "..y......y..",
  ".y...yy...y.",
  ".....yy.....",
];

const MOON = [
  "....mmm.....",
  "..mmmm......",
  ".mmmm.....m.",
  ".mmm.....mmm",
  "mmmm......m.",
  "mmmm........",
  "mmmm........",
  "mmmmm.......",
  ".mmmmm....mm",
  ".mmmmmmmmmm.",
  "..mmmmmmmm..",
  "....mmmm....",
];

const CLOUD = [
  ".....www..",
  "..ww.wwww.",
  ".wwwwwwwww",
  "wwwwwwwwww",
  "wwwwwwwwww",
  ".wwwwwwww.",
];

const FOG = [
  "............",
  "............",
  "gggggggg....",
  "............",
  "..gggggggggg",
  "............",
  "gggggggggg..",
  "............",
  "...ggggggggg",
  "............",
  "............",
  "............",
];

const RAIN = ["..b...b...b.", ".b...b...b..", "b...b...b..."];
const DRIZZLE = ["..b.....b...", "......b....b", "...b........"];
const SNOW = [".s...s...s..", "...s...s...s", ".s...s...s.."];
const BOLT = ["....zz", "...zz.", "..zzzz", "...zz.", "...z.."];

type Grid = string[][];

function blank(): Grid {
  const g: Grid = [];
  for (let y = 0; y < SIZE; y++) {
    const row: string[] = [];
    for (let x = 0; x < SIZE; x++) row.push(".");
    g.push(row);
  }
  return g;
}

/** Paints a sprite at (ox, oy); `recolor` swaps every opaque pixel to one color. */
function stamp(g: Grid, sprite: string[], ox: number, oy: number, recolor?: string): void {
  for (let y = 0; y < sprite.length; y++) {
    for (let x = 0; x < sprite[y].length; x++) {
      const c = sprite[y][x];
      const gx = ox + x;
      const gy = oy + y;
      if (c === "." || gx < 0 || gy < 0 || gx >= SIZE || gy >= SIZE) continue;
      g[gy][gx] = recolor ?? c;
    }
  }
}

/** Clears a 1px ring around a sprite so it reads on top of whatever is behind it. */
function cutout(g: Grid, sprite: string[], ox: number, oy: number): void {
  for (let y = -1; y <= sprite.length; y++) {
    for (let x = -1; x <= sprite[0].length; x++) {
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy++)
        for (let dx = -1; dx <= 1 && !near; dx++) {
          const sy = y + dy;
          const sx = x + dx;
          if (sy >= 0 && sy < sprite.length && sx >= 0 && sx < sprite[sy].length && sprite[sy][sx] !== ".") near = true;
        }
      const gx = ox + x;
      const gy = oy + y;
      if (near && gx >= 0 && gy >= 0 && gx < SIZE && gy < SIZE) g[gy][gx] = ".";
    }
  }
}

/** Icon kinds: what the WMO weather code looks like, before day/night. */
type Kind = "clear" | "partly" | "cloudy" | "fog" | "drizzle" | "rain" | "snow" | "storm";

export function kindOf(code: number): Kind {
  if (code <= 1) return "clear";
  if (code === 2) return "partly";
  if (code === 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95) return "storm";
  return "rain"; // 61–67, 80–82
}

/** A short word for the code, at most 5 letters. */
export function wordOf(code: number): string {
  switch (kindOf(code)) {
    case "clear":
      return "CLEAR";
    case "partly":
      return "PARTLY";
    case "cloudy":
      return "CLOUDY";
    case "fog":
      return "FOG";
    case "drizzle":
      return "DRIZL";
    case "snow":
      return "SNOW";
    case "storm":
      return "STORM";
    default:
      return "RAIN";
  }
}

const memo: Record<string, string> = {};

export function iconXpm(code: number, day: boolean): string {
  const kind = kindOf(code);
  const key = kind + (day ? "d" : "n");
  if (memo[key]) return memo[key];

  const g = blank();
  const body = day ? SUN : MOON;
  if (kind === "clear") stamp(g, body, 0, 0);
  else if (kind === "partly") {
    stamp(g, body, -2, -2);
    cutout(g, CLOUD, 2, 6);
    stamp(g, CLOUD, 2, 6);
  } else if (kind === "cloudy") {
    stamp(g, CLOUD, 2, 1, "g");
    cutout(g, CLOUD, 0, 5);
    stamp(g, CLOUD, 0, 5);
  } else if (kind === "fog") stamp(g, FOG, 0, 0);
  else {
    // Precipitation: a cloud up top and what falls from it below.
    stamp(g, CLOUD, 1, 1, kind === "drizzle" ? "w" : "g");
    if (kind === "rain") stamp(g, RAIN, 0, 8);
    else if (kind === "drizzle") stamp(g, DRIZZLE, 0, 8);
    else if (kind === "snow") stamp(g, SNOW, 0, 8);
    else {
      stamp(g, RAIN, 0, 8);
      stamp(g, BOLT, 4, 6);
    }
  }

  const used: string[] = [];
  for (const row of g) for (const c of row) if (c !== "." && used.indexOf(c) < 0) used.push(c);
  let out = `! XPM2\n${SIZE} ${SIZE} ${used.length + 1} 1\n. c none\n`;
  for (const c of used) out += `${c} c ${PALETTE[c]}\n`;
  out += g.map((row) => row.join("")).join("\n");
  memo[key] = out;
  return out;
}
