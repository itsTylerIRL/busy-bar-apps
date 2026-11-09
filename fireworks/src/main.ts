// Fireworks: rockets climb from the bottom with a sparkling trail and burst into peonies, rings
// and drooping gold willows. Sparks fall under gravity and fade from bright to dim.
//
// Wheel: how busy the sky is (1–5). OK: a finale volley. Start: pause / resume. Back: quit.
//
// Motion follows the clock, and the next frame is worked out while the bar is still drawing
// the current one, the same as Life.
import { clear, draw, loadSettings, playStock, text, type Element } from "@shared/bar";
import manifest from "./appmeta/manifest.json";

const APP = manifest.id;

const W = 72;
const H = 16;
const GRAVITY = 9; // px/s²
const FRAME_MS = 200;
const MAX_SPARKS = 160;
const LABEL_MS = 1500;

const SOUND_POP = "shared/sounds/volume_change.snd";

/** Hues, each in three shades from bright to dim: chars hue*3 + shade. */
const HUES = [
  ["#FF6A6A", "#B03A3A", "#4A1818"],
  ["#FFD84A", "#B08A20", "#4A3A0A"],
  ["#7CFF7A", "#3AA03A", "#164A16"],
  ["#7AE8FF", "#3A90B0", "#163A4A"],
  ["#9A8AFF", "#5A4AC0", "#241A50"],
  ["#FF7AE0", "#B03A9A", "#4A1840"],
];
const KEYS = "abcdefghijklmnopqr";
const GOLD = 1;

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  hue: number;
  /** Drag per second: willows hang, peonies fly. */
  drag: number;
}

interface Rocket {
  x: number;
  y: number;
  vy: number;
  burstY: number;
  hue: number;
  kind: number;
}

function main(): void {
  const report = (err: unknown) => console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);

  let sound = true;
  let busy = 3;
  let paused = false;
  let stopped = false;
  let labelUntil = 0;
  let led: string | undefined;

  let sparks: Spark[] = [];
  let rockets: Rocket[] = [];
  let nextLaunch = 0;
  let last = Date.now();

  let frameTimer: ReturnType<typeof setTimeout> | undefined;
  let pending: Element[] | null = null;

  const shown: Record<string, string> = {};
  let drawing = false;

  try {
    const b = parseInt(localStorage.getItem("busy") ?? "", 10);
    if (b >= 1 && b <= 5) busy = b;
  } catch {
    // Middle of the road.
  }

  const rand = (a: number, b: number) => a + Math.random() * (b - a);

  function launch(): void {
    rockets.push({
      x: rand(6, W - 6),
      y: H,
      vy: rand(-17, -13),
      burstY: rand(2, 7),
      hue: Math.floor(Math.random() * HUES.length),
      kind: Math.floor(Math.random() * 3),
    });
  }

  function burst(r: Rocket): void {
    const n = r.kind === 1 ? 20 : 26;
    for (let i = 0; i < n && sparks.length < MAX_SPARKS; i++) {
      const a = (i / n) * Math.PI * 2 + rand(-0.15, 0.15);
      // Ring: one speed. Peony: a spread of speeds. Willow: slow gold that droops.
      const speed = r.kind === 1 ? 12 : r.kind === 2 ? rand(5, 9) : rand(6, 14);
      sparks.push({
        x: r.x,
        y: r.y,
        // The screen's pixels are square but the sky is wide: stretch bursts a little sideways.
        vx: Math.cos(a) * speed * 1.4,
        vy: Math.sin(a) * speed,
        age: 0,
        life: r.kind === 2 ? rand(2.0, 2.8) : rand(1.2, 1.8),
        hue: r.kind === 2 ? GOLD : r.hue,
        drag: r.kind === 2 ? 1.1 : 0.7,
      });
    }
  }

  function advance(dt: number): void {
    const now = Date.now();
    if (now >= nextLaunch) {
      launch();
      // Busier skies launch more often.
      nextLaunch = now + rand(1600, 2600) / busy;
    }
    const keepRockets: Rocket[] = [];
    for (const r of rockets) {
      r.y += r.vy * dt;
      r.vy += GRAVITY * 0.3 * dt;
      if (r.y <= r.burstY || r.vy >= 0) burst(r);
      else keepRockets.push(r);
    }
    rockets = keepRockets;
    const keep: Spark[] = [];
    for (const s of sparks) {
      s.age += dt;
      if (s.age >= s.life) continue;
      const k = Math.max(0, 1 - s.drag * dt);
      s.vx *= k;
      s.vy = s.vy * k + GRAVITY * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      if (s.y < H + 1 && s.x > -2 && s.x < W + 2) keep.push(s);
    }
    sparks = keep;
  }

  function skyXpm(): string {
    const g: string[] = [];
    for (let i = 0; i < W * H; i++) g.push(".");
    const put = (x: number, y: number, c: string) => {
      const xi = Math.round(x);
      const yi = Math.round(y);
      if (xi >= 0 && yi >= 0 && xi < W && yi < H) g[yi * W + xi] = c;
    };
    for (const r of rockets) {
      put(r.x, r.y, "w");
      // A short flickering trail.
      put(r.x, r.y + 1, Math.random() < 0.6 ? "t" : ".");
      put(r.x, r.y + 2, Math.random() < 0.3 ? "t" : ".");
    }
    // Dimmest first, so bright sparks win where they overlap.
    for (let shade = 2; shade >= 0; shade--) {
      for (const s of sparks) {
        const f = s.age / s.life;
        const sh = f < 0.4 ? 0 : f < 0.75 ? 1 : 2;
        if (sh === shade) put(s.x, s.y, KEYS[s.hue * 3 + sh]);
      }
    }
    let colors = ". c none\nw c #FFFFFF\nt c #FFB04A\n";
    for (let h = 0; h < HUES.length; h++) for (let s = 0; s < 3; s++) colors += `${KEYS[h * 3 + s]} c ${HUES[h][s]}\n`;
    let out = `! XPM2\n${W} ${H} ${HUES.length * 3 + 3} 1\n${colors}`;
    for (let y = 0; y < H; y++) out += g.slice(y * W, y * W + W).join("") + (y < H - 1 ? "\n" : "");
    return out;
  }

  function frame(): Element[] {
    const label = paused ? "PAUSED" : Date.now() < labelUntil ? "BUSY " + "*****".slice(0, busy) : "";
    return [
      { id: "sky", type: "xpmbitmap", data: skyXpm(), x: 0, y: 0, align: "top_left" },
      text("label", label, "small", 36, 8, "center", "#FFFFFFFF"),
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
      });
  }

  /** One frame per call; the next is worked out while the bar draws this one. */
  function loop(): void {
    frameTimer = undefined;
    if (stopped) return;
    if (drawing) {
      frameTimer = setTimeout(loop, 30);
      return;
    }
    const els = pending ?? frame();
    pending = null;
    const t0 = Date.now();
    const sent = send(els);
    if (!paused) {
      const now = Date.now();
      advance(Math.min(0.5, (now - last) / 1000));
      last = now;
      pending = frame();
    }
    sent.then(() => {
      if (stopped || paused) return;
      frameTimer = setTimeout(loop, Math.max(0, FRAME_MS - (Date.now() - t0)));
    });
  }

  function finale(): void {
    for (let i = 0; i < 4; i++) launch();
    led = "#FFD84AFF";
    if (sound) playStock(APP, SOUND_POP).catch(report);
  }

  function quit(): void {
    stopped = true;
    if (frameTimer !== undefined) clearTimeout(frameTimer);
    try {
      if (localStorage.getItem("busy") !== String(busy)) localStorage.setItem("busy", String(busy));
    } catch {
      // Not worth failing the quit over.
    }
    clear(APP).catch(report);
    setTimeout(unbind, 0);
  }

  function handle(event: BusyInputEvent): void {
    if (stopped) return;
    if (event.key === "encoder") {
      busy = Math.max(1, Math.min(5, busy + event.delta));
      labelUntil = Date.now() + LABEL_MS;
      pending = null;
      return;
    }
    if (event.action !== "short") return;
    if (event.key === "back") quit();
    else if (event.key === "ok") {
      finale();
      pending = null;
    } else if (event.key === "start") {
      paused = !paused;
      pending = null;
      if (!paused) {
        last = Date.now();
        if (frameTimer === undefined) loop();
      } else if (!drawing) send(frame()).catch(report);
    }
  }

  const unbind = listen("input", handle);

  loadSettings(APP)
    .then((v) => {
      sound = v.sound !== false;
    })
    .catch(report);
  // Open with a volley.
  for (let i = 0; i < 2; i++) launch();
  nextLaunch = Date.now() + 800;
  loop();
}

main();
