// Sale decoding for Remilia collections, ported from %chibi.
//
// A tx is a sale when it moves a watched NFT and a marketplace event in the same receipt prices it:
//   Seaport OrderFulfilled: NFT in the offer means a listing was bought, NFT in the consideration means an offer was accepted.
//   Blur v2 Execution721*Packed: price packed into word 2, token id into word 1.

export interface Collection {
  key: string;
  name: string;
  addr: string;
  color: string;
}

export const COLLECTIONS: Collection[] = [
  { key: "milady", name: "MILADY", addr: "0x5af0d9827e0c53e4799bb226655a1de152a425a5", color: "#FF8FC7FF" },
  { key: "remilio", name: "REMILIO", addr: "0xd3d9ddd0cf0a5f0bfb8f7fceae075df687eaebab", color: "#8FD3FFFF" },
  { key: "radbro", name: "RADBRO", addr: "0xabcdb5710b88f456fed1e99025379e2969f29610", color: "#FFB45AFF" },
  { key: "schizo", name: "SCHIZO", addr: "0xbfe47d6d4090940d1c7a0066b63d23875e3e2ac5", color: "#C59BFFFF" },
  { key: "yayo", name: "YAYO", addr: "0x09f66a094a0070ebddefa192a33fa5d75b59d46b", color: "#FFE45AFF" },
];

export const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const SEAPORTS = ["0x0000000000000068f116a894984e2db1123eb395", "0x00000000000000adc04c56bf30ac9d3c0aaf14dc"];
const SIG_FULFILLED = "0x9d9af8e3";
const BLUR = "0xb2ecfe4e4d61f8790bbb9de2d1259b9e2410cea5";
const SIG_BLUR = ["0x1d5e12b5", "0x0fcf17fa", "0x7dc5c069"];
/** WETH and Blur Pool count as ETH. */
const COINS = ["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", "0x0000000000a39bb272e79075ade125fd351887ac"];
const ZERO = "0x0000000000000000000000000000000000000000";

export interface Log {
  address: string;
  topics: string[];
  data: string;
}

/** One sale in a tx, collapsed: a sweep of n tokens is one entry priced per token. */
export interface Sale {
  /** Index into COLLECTIONS. */
  c: number;
  /** Token id, or the first one of a sweep. */
  id: number;
  /** Tokens sold in the tx. */
  n: number;
  /** Price per token in ETH. */
  eth: number;
  /** "OS", "OS offer" or "Blur". */
  v: string;
  block: number;
  /** Unix seconds, estimated from the block height. */
  t: number;
  tx: string;
}

function word(data: string, i: number): string {
  const s = data.slice(2 + i * 64, 2 + (i + 1) * 64);
  return s.length === 64 ? s : "0".repeat(64);
}

const num = (hex: string) => parseInt(hex, 16) || 0;
const addrOf = (w: string) => "0x" + w.slice(24);
const wei = (n: number) => n / 1e18;

/** ABI array of n-word structs whose length word sits at word p. */
function items(data: string, p: number, n: number): string[][] {
  const k = num(word(data, p));
  if (k > 64) return [];
  const out: string[][] = [];
  for (let j = 0; j < k; j++) {
    const base = p + 1 + j * n;
    const it: string[] = [];
    for (let q = 0; q < n; q++) it.push(word(data, base + q));
    out.push(it);
  }
  return out;
}

/** token id -> [venue, price in ETH] for one collection, from the marketplace events in a receipt. */
function prices(addr: string, logs: Log[]): Record<string, [string, number]> {
  const m: Record<string, [string, number]> = {};
  for (const l of logs) {
    const a = l.address.toLowerCase();
    const sig = (l.topics[0] || "").slice(0, 10).toLowerCase();

    if (SEAPORTS.indexOf(a) >= 0 && sig === SIG_FULFILLED) {
      const d = l.data;
      const offer = items(d, num(word(d, 2)) / 32, 4);
      const cons = items(d, num(word(d, 3)) / 32, 5);
      const isNft = (i: string[]) => {
        const t = num(i[0]);
        return (t === 2 || t === 4) && addrOf(i[1]) === addr;
      };
      const inOffer = offer.filter(isNft);
      const ids = inOffer.concat(cons.filter(isNft)).map((i) => String(num(i[2])));
      if (!ids.length) continue;
      const pay = inOffer.length ? cons : offer;
      let amt = 0;
      for (const i of pay) {
        const t = num(i[0]);
        if (t === 0 || (t === 1 && COINS.indexOf(addrOf(i[1])) >= 0)) amt += num(i[3]);
      }
      if (!amt) continue;
      const venue = inOffer.length ? "OS" : "OS offer";
      for (const id of ids) if (!m[id]) m[id] = [venue, wei(amt / ids.length)];
    } else if (a === BLUR && SIG_BLUR.indexOf(sig) >= 0) {
      // tokenIdListingIndexTrader: id in the top 11 bytes. collectionPriceSide: price in bytes 20..30, collection in the low 20.
      const tid = String(num(word(l.data, 1).slice(0, 22)));
      const cps = word(l.data, 2);
      if (addrOf(cps) !== addr) continue;
      if (!m[tid]) m[tid] = ["Blur", wei(num(cps.slice(2, 24)))];
    }
  }
  return m;
}

/** The sales of watched collections in one receipt; empty when the tx only moved tokens. */
export function salesIn(logs: Log[], tx: string, block: number, t: number, watched: boolean[]): Sale[] {
  const out: Sale[] = [];
  for (let c = 0; c < COLLECTIONS.length; c++) {
    if (!watched[c]) continue;
    const addr = COLLECTIONS[c].addr;
    let m: Record<string, [string, number]> | null = null;
    let first = -1;
    let n = 0;
    let total = 0;
    let venue = "";
    const seen: Record<string, boolean> = {};
    for (const l of logs) {
      if (l.address.toLowerCase() !== addr || l.topics.length !== 4 || l.topics[0].toLowerCase() !== TRANSFER) continue;
      const from = addrOf(l.topics[1].slice(2));
      if (from === ZERO) continue;
      const id = String(num(l.topics[3].slice(2)));
      if (seen[id]) continue; // a sale prices only the first transfer of a token in the tx
      seen[id] = true;
      if (!m) m = prices(addr, logs);
      const p = m[id];
      if (!p) continue;
      if (first < 0) first = Number(id);
      n++;
      total += p[1];
      venue = p[0];
    }
    if (n > 0) out.push({ c, id: first, n, eth: total / n, v: venue, block, t, tx });
  }
  return out;
}
