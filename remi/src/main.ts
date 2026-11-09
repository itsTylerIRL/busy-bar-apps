// Remilia: on-chain sales of Milady, Remilio, Radbro, SchizoPosters and YAYO.
//
// Polls Ethereum through a public RPC for Transfer events of the watched collections, reads the receipt of
// each tx and keeps the ones a marketplace event prices (see decode.ts). New sales chime and blink the LED.
//
// Wheel: browse recent sales. OK: jump to the newest. Back: quit.
import { clear, draw, loadSettings, playStock, text, type Element } from "@shared/bar";
import { COLLECTIONS, TRANSFER, salesIn, type Log, type Sale } from "./decode";
import manifest from "./appmeta/manifest.json";

const APP = manifest.id;
const RPC = "https://rpc.mevblocker.io";
const UA = "busybar-remilia/0.1";

const POLL_MS = 30_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const USD_MS = 5 * 60_000;
/** Wheel browsing returns to the newest sale after this long untouched. */
const IDLE_MS = 45_000;
const NEW_MS = 20_000;
const FLASH_MS = 1500;

/** Blocks per eth_getLogs: ~3.3h, ~20 KB of JSON at Remilia volumes. */
const CHUNK = 1000;
/** On a cold start, look back at most this far for history. */
const BACKFILL_CHUNKS = 10;
const BACKFILL_WANT = 6;
/** Resume from the stored block if it is at most this old, otherwise backfill afresh. */
const RESUME_MAX = 7200;
const KEEP = 12;
/** Receipts above this many characters (giant sweeps) are skipped rather than parsed. */
const MAX_RECEIPT = 120_000;
const BLOCK_S = 12;

const GRAY = "#8A8A8AFF";
const WHITE = "#FFFFFFFF";
const SOUND = "shared/sounds/calendar_event_starts.snd";

// ---------------------------------------------------------------- rpc

let rpcId = 0;

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (!res.ok) throw new Error(`rpc ${method} HTTP ${res.status}`);
  const body = await res.text();
  if (method === "eth_getTransactionReceipt" && body.length > MAX_RECEIPT) throw new Error("receipt too large");
  const j = JSON.parse(body) as { result?: T; error?: { message?: string } };
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message ?? "error"}`);
  return j.result as T;
}

const hex = (n: number) => "0x" + n.toString(16);

async function blockNumber(): Promise<number> {
  return parseInt(await rpc<string>("eth_blockNumber", []), 16);
}

/** Tx hashes with watched transfers in [from, to], newest first. Only the hash and block are kept. */
async function transferTxs(from: number, to: number, addrs: string[]): Promise<[string, number][]> {
  const logs = await rpc<{ transactionHash: string; blockNumber: string }[]>("eth_getLogs", [
    { fromBlock: hex(from), toBlock: hex(to), address: addrs, topics: [TRANSFER] },
  ]);
  const seen: Record<string, number> = {};
  const out: [string, number][] = [];
  for (const l of logs) {
    if (seen[l.transactionHash] !== undefined) continue;
    seen[l.transactionHash] = 1;
    out.push([l.transactionHash, parseInt(l.blockNumber, 16)]);
  }
  out.sort((a, b) => b[1] - a[1]);
  return out;
}

// ---------------------------------------------------------------- formatting

function formatEth(e: number): string {
  if (e >= 100) return e.toFixed(0);
  if (e >= 10) return e.toFixed(1);
  if (e >= 0.01) return e.toFixed(3);
  return e.toFixed(4);
}

function commas(n: number): string {
  const s = String(Math.round(n));
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ",";
    out += s[i];
  }
  return out;
}

function formatUsd(v: number): string {
  if (v >= 100_000) return "$" + (v / 1000).toFixed(0) + "k";
  if (v >= 1000) return "$" + commas(v);
  return "$" + v.toFixed(0);
}

function formatAge(s: number): string {
  if (s < 60) return "now";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}

/** Bold digits advance 7px, the point 4px. */
function boldWidth(s: string): number {
  let w = 0;
  for (let i = 0; i < s.length; i++) w += s[i] === "." ? 4 : 7;
  return w;
}

// ---------------------------------------------------------------- persistence

interface Stored {
  b: number;
  s: Sale[];
}

function loadStored(): Stored | null {
  try {
    const raw = localStorage.getItem("state");
    if (!raw) return null;
    const v = JSON.parse(raw) as Stored;
    return typeof v.b === "number" && v.s instanceof Array ? v : null;
  } catch {
    return null;
  }
}

function saveStored(block: number, sales: Sale[]): void {
  try {
    localStorage.setItem("state", JSON.stringify({ b: block, s: sales }));
  } catch {
    // Losing the history only costs a backfill next launch.
  }
}

// ---------------------------------------------------------------- app

function main(): void {
  const report = (err: unknown) => console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);

  let watched = COLLECTIONS.map(() => true);
  let sound = true;
  let showUsd = true;

  let sales: Sale[] = [];
  let last = 0; // last block scanned
  let view = 0;
  let status = "starting";
  let stopped = false;
  let backoff = POLL_MS;
  let ethUsd = 0;
  let usdAt = 0;
  let newUntil = 0;
  let flash = "";
  let lastFrame = "";

  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;

  const addrs = () => COLLECTIONS.filter((_, i) => watched[i]).map((c) => c.addr);

  function frame(): Element[] {
    const now = Date.now() / 1000;
    if (!sales.length) {
      return [
        text("name", "REMILIA", "tiny", 0, 0, "top_left", "#FF8FC7FF"),
        text("age", flash, "tiny", 72, 0, "top_right", GRAY),
        text("px", status, "small", 0, 16, "bottom_left", GRAY),
        text("eth", "", "tiny", 0, 16, "bottom_left"),
        text("usd", "", "tiny", 72, 16, "bottom_right"),
      ];
    }
    const s = sales[Math.min(view, sales.length - 1)];
    const c = COLLECTIONS[s.c];
    const label = s.n > 1 ? `${c.name} x${s.n}` : `${c.name} #${s.id}`;
    const isNew = view === 0 && Date.now() < newUntil;
    const corner = flash || (isNew ? "NEW" : formatAge(now - s.t));
    const price = formatEth(s.eth);
    const pw = boldWidth(price);
    const usd = showUsd && ethUsd > 0 ? formatUsd(s.eth * ethUsd) : s.v;
    return [
      text("name", label, "small", 0, 0, "top_left", c.color),
      text("age", corner, "small", 72, 0, "top_right", isNew && !flash ? WHITE : GRAY),
      // An accepted offer prices a little paler than a bought listing.
      text("px", price, "bold", 0, 16, "bottom_left", s.v === "OS offer" ? "#D8D8D8FF" : WHITE),
      text("eth", s.n > 1 ? "EA" : "ETH", "small", pw + 2, 16, "bottom_left", GRAY),
      text("usd", usd, "small", 72, 16, "bottom_right", GRAY),
    ];
  }

  function render(led?: string): void {
    if (stopped) return;
    const els = frame();
    const sig = JSON.stringify(els);
    if (sig === lastFrame && !led) return;
    lastFrame = sig;
    draw(APP, els, led).catch(report);
  }

  function showFlash(msg: string): void {
    flash = msg;
    if (flashTimer !== undefined) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashTimer = undefined;
      flash = "";
      render();
    }, FLASH_MS);
    render();
  }

  /** Reads receipts for txs (newest first) and returns their sales, stopping once `want` are found. */
  async function scanTxs(txs: [string, number][], head: number, want: number): Promise<Sale[]> {
    const found: Sale[] = [];
    const now = Math.floor(Date.now() / 1000);
    for (const [tx, block] of txs) {
      if (stopped || found.length >= want) break;
      if (sales.some((s) => s.tx === tx)) continue;
      try {
        const rc = await rpc<{ logs: Log[] }>("eth_getTransactionReceipt", [tx]);
        const t = now - (head - block) * BLOCK_S;
        for (const s of salesIn(rc.logs, tx, block, t, watched)) found.push(s);
      } catch (err) {
        report(`${tx.slice(0, 10)} ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return found;
  }

  function addSales(found: Sale[], alert: boolean): void {
    if (!found.length) return;
    sales = found.concat(sales);
    sales.sort((a, b) => b.block - a.block);
    if (sales.length > KEEP) sales.length = KEEP;
    if (alert) {
      view = 0;
      newUntil = Date.now() + NEW_MS;
      if (sound) playStock(APP, SOUND).catch(report);
      render(COLLECTIONS[sales[0].c].color);
    }
  }

  /** Cold start: walk back in chunks until a few sales turn up. */
  async function backfill(head: number): Promise<void> {
    let to = head;
    for (let k = 0; k < BACKFILL_CHUNKS && !stopped; k++) {
      status = `scan ${k + 1}/${BACKFILL_CHUNKS}`;
      render();
      const txs = await transferTxs(to - CHUNK + 1, to, addrs());
      addSales(await scanTxs(txs, head, KEEP), false);
      render();
      if (sales.length >= BACKFILL_WANT) break;
      to -= CHUNK;
    }
    if (!sales.length) status = "no sales";
  }

  /** Scans everything after `last` up to head, in chunks. New sales alert unless this is a catch-up after launch. */
  async function forward(head: number, alert: boolean): Promise<void> {
    while (last < head && !stopped) {
      const to = Math.min(head, last + CHUNK);
      const txs = await transferTxs(last + 1, to, addrs());
      addSales(await scanTxs(txs, head, KEEP), alert);
      last = to;
    }
  }

  async function refreshUsd(): Promise<void> {
    if (!showUsd || Date.now() - usdAt < USD_MS) return;
    usdAt = Date.now();
    try {
      const res = await fetch("https://api.exchange.coinbase.com/products/ETH-USD/ticker", { headers: { "User-Agent": UA } });
      if (res.ok) ethUsd = parseFloat(((await res.json()) as { price: string }).price) || ethUsd;
    } catch (err) {
      report(`usd ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function poll(first: boolean): Promise<void> {
    const head = await blockNumber();
    if (first) {
      const stored = loadStored();
      if (stored && head - stored.b <= RESUME_MAX) {
        sales = stored.s.filter((s) => watched[s.c]);
        last = stored.b;
        status = "catching up";
        render();
        await forward(head, false);
      } else {
        await backfill(head);
        last = head;
      }
    } else {
      await forward(head, true);
    }
    await refreshUsd();
    saveStored(last, sales);
  }

  function schedule(first: boolean, ms: number): void {
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      poll(first)
        .then(() => {
          backoff = POLL_MS;
          render();
          if (!stopped) schedule(false, POLL_MS);
        })
        .catch((err) => {
          report(err);
          if (!sales.length) status = "offline";
          render();
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
          // A failed cold start retries as a cold start.
          if (!stopped) schedule(first && last === 0, backoff);
        });
    }, ms);
  }

  function quit(): void {
    stopped = true;
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    if (tickTimer !== undefined) clearInterval(tickTimer);
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (flashTimer !== undefined) clearTimeout(flashTimer);
    clear(APP).catch(report);
    setTimeout(unbind, 0);
  }

  const unbind = listen("input", (event) => {
    if (stopped) return;
    if (event.key === "encoder") {
      if (!sales.length) return;
      view = Math.max(0, Math.min(sales.length - 1, view - event.delta));
      showFlash(`${view + 1}/${sales.length}`);
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimer = undefined;
        view = 0;
        render();
      }, IDLE_MS);
      return;
    }
    if (event.action !== "short") return;
    if (event.key === "back") quit();
    else if (event.key === "ok") {
      view = 0;
      render();
    }
  });

  render();
  // Ages and the NEW badge change with time, not data; render() skips identical frames.
  tickTimer = setInterval(() => render(), 10_000);

  loadSettings(APP)
    .then((values) => {
      watched = COLLECTIONS.map((c) => values[c.key] !== false);
      if (!watched.some((w) => w)) watched = COLLECTIONS.map(() => true);
      sound = values.sound !== false;
      showUsd = values.usd !== false;
    })
    .catch(report)
    .then(() => {
      if (!stopped) schedule(true, 0);
    });
}

main();
