// Where things are in the sky: the sun, the moon, five planets and a catalog of bright stars,
// as altitude and azimuth for a place and a time. Low precision, good to a fraction of a degree,
// which is far below the 5° a pixel spans on the screen.
//
// Sun and moon: truncated series (Meeus, ch. 25 and 47). Planets: JPL's approximate Keplerian
// elements for 1800–2050 (Standish), with the mean longitude's rate; the other rates are small
// enough to leave out at this scale.

const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;
const OBLIQUITY = 23.43928 * RAD;

const sinD = (d: number) => Math.sin(d * RAD);
const norm = (d: number) => ((d % 360) + 360) % 360;

/** Days since J2000.0. */
export const daysSinceJ2000 = (ms: number) => ms / DAY_MS + 2440587.5 - 2451545.0;

export interface Equatorial {
  /** Right ascension and declination, degrees. */
  ra: number;
  dec: number;
}

export interface Horizontal {
  alt: number;
  az: number;
}

/** Ecliptic longitude/latitude (degrees) to right ascension/declination. */
function eclToEq(lon: number, lat: number): Equatorial {
  const l = lon * RAD;
  const b = lat * RAD;
  const x = Math.cos(b) * Math.cos(l);
  const y = Math.cos(b) * Math.sin(l) * Math.cos(OBLIQUITY) - Math.sin(b) * Math.sin(OBLIQUITY);
  const z = Math.cos(b) * Math.sin(l) * Math.sin(OBLIQUITY) + Math.sin(b) * Math.cos(OBLIQUITY);
  return { ra: norm(Math.atan2(y, x) / RAD), dec: Math.asin(z) / RAD };
}

/** Local sidereal time in degrees. */
export function siderealDeg(ms: number, lon: number): number {
  const d = daysSinceJ2000(ms);
  return norm(280.46061837 + 360.98564736629 * d + lon);
}

/** Altitude (above the horizon) and azimuth (from north, through east), degrees. */
export function toHorizontal(eq: Equatorial, lst: number, lat: number): Horizontal {
  const h = (lst - eq.ra) * RAD;
  const dec = eq.dec * RAD;
  const phi = lat * RAD;
  const sinAlt = Math.sin(dec) * Math.sin(phi) + Math.cos(dec) * Math.cos(phi) * Math.cos(h);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const az = Math.atan2(-Math.sin(h) * Math.cos(dec), Math.sin(dec) * Math.cos(phi) - Math.cos(dec) * Math.sin(phi) * Math.cos(h));
  return { alt: alt / RAD, az: norm(az / RAD) };
}

// ---------------------------------------------------------------- sun and moon

export function sunEcliptic(d: number): number {
  const g = 357.528 + 0.9856003 * d;
  return norm(280.46 + 0.9856474 * d + 1.915 * sinD(g) + 0.02 * sinD(2 * g));
}

export function sun(ms: number): Equatorial {
  return eclToEq(sunEcliptic(daysSinceJ2000(ms)), 0);
}

/** The moon's position and its elongation from the sun (0 new, 180 full). */
export function moon(ms: number): Equatorial & { elong: number } {
  const d = daysSinceJ2000(ms);
  const L = 218.316 + 13.176396 * d;
  const M = 134.963 + 13.064993 * d;
  const Ms = 357.529 + 0.98560028 * d;
  const D = 297.85 + 12.190749 * d;
  const F = 93.272 + 13.22935 * d;
  const lon = norm(
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
  const lat = 5.128 * sinD(F) + 0.281 * sinD(M + F) + 0.278 * sinD(M - F) + 0.173 * sinD(2 * D - F);
  const eq = eclToEq(lon, lat);
  return { ra: eq.ra, dec: eq.dec, elong: norm(lon - sunEcliptic(d)) };
}

// ---------------------------------------------------------------- planets

/** a (AU), e, i, mean longitude L, longitude of perihelion ϖ, ascending node Ω (degrees) at J2000; L's rate per century. */
type Elements = [number, number, number, number, number, number, number];

const EARTH: Elements = [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0, 35999.37244981];

export const PLANETS: { name: string; el: Elements; color: string }[] = [
  { name: "MERCURY", el: [0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593, 149472.67411175], color: "#C8B8A0" },
  { name: "VENUS", el: [0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255, 58517.81538729], color: "#FFF4C8" },
  { name: "MARS", el: [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891, 19140.30268499], color: "#FF6A3A" },
  { name: "JUPITER", el: [5.202887, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909, 3034.74612775], color: "#FFD8A0" },
  { name: "SATURN", el: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448, 1222.49362201], color: "#E8D088" },
];

/** Heliocentric ecliptic x, y, z (AU) from orbital elements, solving Kepler's equation. */
function helio(el: Elements, T: number): [number, number, number] {
  const [a, e, i, L0, w, node, rate] = el;
  const L = L0 + rate * T;
  const M = norm(L - w) * RAD;
  let E = M;
  for (let k = 0; k < 6; k++) E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const argPeri = (w - node) * RAD;
  const O = node * RAD;
  const I = i * RAD;
  const cw = Math.cos(argPeri);
  const sw = Math.sin(argPeri);
  const cO = Math.cos(O);
  const sO = Math.sin(O);
  const cI = Math.cos(I);
  const sI = Math.sin(I);
  return [
    (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
    (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
    sw * sI * xp + cw * sI * yp,
  ];
}

export function planet(index: number, ms: number): Equatorial {
  const T = daysSinceJ2000(ms) / 36525;
  const p = helio(PLANETS[index].el, T);
  const e = helio(EARTH, T);
  const x = p[0] - e[0];
  const y = p[1] - e[1];
  const z = p[2] - e[2];
  const lon = Math.atan2(y, x) / RAD;
  const lat = Math.atan2(z, Math.sqrt(x * x + y * y)) / RAD;
  return eclToEq(lon, lat);
}
