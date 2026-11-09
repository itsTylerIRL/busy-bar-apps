// Low-precision sun and moon positions, good to a few arcminutes: enough for phase times
// within the hour and sunrise/sunset within a minute or two.
// Moon: the main periodic terms of its longitude (Meeus, ch. 47, truncated).
// Sun: the sunrise equation (NOAA / Wikipedia form).

const RAD = Math.PI / 180;
const J2000 = 2451545.0;
const DAY_MS = 86_400_000;

const sinD = (deg: number) => Math.sin(deg * RAD);
const norm = (deg: number) => ((deg % 360) + 360) % 360;

/** Days since J2000.0 for a Unix time in ms. */
export function daysSinceJ2000(ms: number): number {
  return ms / DAY_MS + 2440587.5 - J2000;
}

function sunLongitude(d: number): number {
  const g = 357.528 + 0.9856003 * d;
  return norm(280.46 + 0.9856474 * d + 1.915 * sinD(g) + 0.02 * sinD(2 * g));
}

function moonLongitude(d: number): number {
  const L = 218.316 + 13.176396 * d;
  const M = 134.963 + 13.064993 * d;
  const Ms = 357.529 + 0.98560028 * d;
  const D = 297.85 + 12.190749 * d;
  const F = 93.272 + 13.22935 * d;
  return norm(
    L +
      6.289 * sinD(M) -
      1.274 * sinD(M - 2 * D) +
      0.658 * sinD(2 * D) -
      0.186 * sinD(Ms) -
      0.059 * sinD(2 * M - 2 * D) -
      0.057 * sinD(M - 2 * D + Ms) +
      0.053 * sinD(M + 2 * D) +
      0.046 * sinD(2 * D - Ms) +
      0.041 * sinD(M - Ms) -
      0.035 * sinD(D) -
      0.031 * sinD(M + Ms) -
      0.015 * sinD(2 * F - 2 * D) +
      0.011 * sinD(M - 4 * D),
  );
}

/** The moon's elongation from the sun, 0–360°: 0 new, 90 first quarter, 180 full, 270 last quarter. */
export function elongation(ms: number): number {
  const d = daysSinceJ2000(ms);
  return norm(moonLongitude(d) - sunLongitude(d));
}

/** Fraction of the disc lit, 0–1. */
export function illumination(elong: number): number {
  return (1 - Math.cos(elong * RAD)) / 2;
}

/** The next time after `ms` the elongation reaches `target` degrees (180 = full, 0 = new). */
export function nextPhase(ms: number, target: number): number {
  const off = (t: number) => norm(elongation(t) - target + 180) - 180; // −180..180, rises through 0
  const step = DAY_MS / 4;
  let a = ms;
  let fa = off(a);
  for (let i = 0; i < 31 * 4; i++) {
    const b = a + step;
    const fb = off(b);
    // A rise through zero, not the wrap from +180 back to −180.
    if (fa < 0 && fb >= 0 && fb - fa < 90) {
      let lo = a;
      let hi = b;
      for (let k = 0; k < 24; k++) {
        const mid = (lo + hi) / 2;
        if (off(mid) < 0) lo = mid;
        else hi = mid;
      }
      return (lo + hi) / 2;
    }
    a = b;
    fa = fb;
  }
  return NaN;
}

export interface SunDay {
  /** Unix ms; NaN when the sun does not rise or set that day. */
  rise: number;
  set: number;
  noon: number;
  /** "day" or "night" when the sun stays up or down all day. */
  polar: "" | "day" | "night";
}

/** Sunrise, solar noon and sunset for the day containing `noonMs` (any time near local noon). */
export function sunDay(noonMs: number, lat: number, lon: number): SunDay {
  // J*: days since J2000 of the approximate solar noon, the whole day nearest local noon shifted by longitude.
  const jStar = Math.round(daysSinceJ2000(noonMs) + lon / 360) - lon / 360;
  const M = norm(357.5291 + 0.98560028 * jStar);
  const C = 1.9148 * sinD(M) + 0.02 * sinD(2 * M) + 0.0003 * sinD(3 * M);
  const lambda = norm(M + C + 180 + 102.9372);
  // Equation of time.
  const transit = jStar + 0.0053 * sinD(M) - 0.0069 * sinD(2 * lambda);
  const sinDec = sinD(lambda) * sinD(23.4397);
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosW = (sinD(-0.833) - sinD(lat) * sinDec) / (Math.cos(lat * RAD) * cosDec);
  const toMs = (j: number) => (j + J2000 - 2440587.5) * DAY_MS;
  const noon = toMs(transit);
  if (cosW > 1) return { rise: NaN, set: NaN, noon, polar: "night" };
  if (cosW < -1) return { rise: NaN, set: NaN, noon, polar: "day" };
  const w = Math.acos(cosW) / RAD / 360;
  return { rise: toMs(transit - w), set: toMs(transit + w), noon, polar: "" };
}
