/** Polyline helpers. Points are [x, y] arrays in canvas pixels. */

export function dist(a, b) {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** Points of a polyline, with the first point repeated at the end when closed. */
export function ringPoints(points, closed) {
  return closed && points.length > 2 ? [...points, points[0]] : points.slice();
}

/** Cumulative distance at each vertex. */
export function cumulative(pts) {
  const out = [0];
  for (let i = 1; i < pts.length; i++) out.push(out[i - 1] + dist(pts[i - 1], pts[i]));
  return out;
}

/** Point at distance d along the polyline. */
export function pointAt(pts, cum, d) {
  if (d <= 0) return pts[0].slice();
  for (let i = 1; i < pts.length; i++) {
    if (d <= cum[i]) {
      const seg = cum[i] - cum[i - 1] || 1;
      const t = (d - cum[i - 1]) / seg;
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
    }
  }
  return pts[pts.length - 1].slice();
}

/**
 * Closest point on the polyline to p.
 * @returns {{d: number, dist: number, seg: number, point: number[]}}
 */
export function project(pts, cum, p) {
  let best = { d: 0, dist: Infinity, seg: 0, point: pts[0] };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
    const q = [a[0] + dx * t, a[1] + dy * t];
    const dd = dist(p, q);
    if (dd < best.dist) best = { d: cum[i - 1] + Math.sqrt(len2) * t, dist: dd, seg: i - 1, point: q };
  }
  return best;
}

/**
 * Sub-polylines covering [0, total] minus the given ranges.
 * @param {number[][]} pts
 * @param {number[]} cum
 * @param {{d0: number, d1: number}[]} cuts
 * @returns {number[][][]}
 */
export function splitByRanges(pts, cum, cuts) {
  const total = cum[cum.length - 1];
  const sorted = cuts.map(c => [Math.min(c.d0, c.d1), Math.max(c.d0, c.d1)]).sort((a, b) => a[0] - b[0]);
  const keep = [];
  let start = 0;
  for (const [a, b] of sorted) {
    if (a > start) keep.push([start, a]);
    start = Math.max(start, b);
  }
  if (start < total) keep.push([start, total]);
  return keep.filter(([a, b]) => b - a > 0.5).map(([a, b]) => slice(pts, cum, a, b));
}

/** The part of the polyline between distances a and b. */
export function slice(pts, cum, a, b) {
  const out = [pointAt(pts, cum, a)];
  for (let i = 1; i < pts.length - 1; i++) if (cum[i] > a && cum[i] < b) out.push(pts[i].slice());
  out.push(pointAt(pts, cum, b));
  return out;
}

/** Catmull-Rom smoothing; keeps the original vertices. */
export function smooth(points, closed, steps = 6) {
  if (points.length < 3) return points.slice();
  const n = points.length;
  const get = i => (closed ? points[(i + n) % n] : points[Math.max(0, Math.min(n - 1, i))]);
  const out = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    for (let s = 0; s < steps; s++) {
      const t = s / steps, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map(k => 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * t
        + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)));
    }
  }
  out.push(closed ? points[0].slice() : points[n - 1].slice());
  return out;
}

/** Small deterministic PRNG (mulberry32), so a path looks the same on every render and in the bake. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable integer from a string (path id), used when an entry has no seed yet. */
export function hashSeed(str = "") {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Displace a polyline sideways with fractal value noise, for rough cliff edges and wobbly roads.
 * The noise runs along the line's length, so it doesn't depend on how many points were clicked. Closed rings
 * wrap seamlessly; open lines keep their end points where they were clicked.
 * @param {number[][]} pts   polyline (closed rings repeat the first point at the end)
 * @param {boolean} closed
 * @param {object} o
 * @param {number} o.amplitude  max sideways offset in px
 * @param {number} o.wavelength length of the largest bumps in px
 * @param {number} o.seed
 * @returns {number[][]}
 */
export function roughen(pts, closed, { amplitude, wavelength, seed }) {
  const cum = cumulative(pts);
  const total = cum[cum.length - 1];
  if (!(amplitude > 0) || total < 1) return pts;
  const step = Math.max(2, wavelength / 24);
  const count = Math.max(2, Math.ceil(total / step));
  const ring = closed && pts.length > 3;

  // Octaves of value noise with their own lattices; ring lattices have a whole number of cells so they wrap.
  const rand = rng(seed);
  const octaves = [1, 0.55, 0.35, 0.2].map((amp, k) => {
    const wl = wavelength / 2 ** k;
    const cells = Math.max(1, Math.round(total / wl));
    const values = Array.from({ length: cells + 1 }, () => rand() * 2 - 1);
    if (ring) values[cells] = values[0];
    return { amp, cells, values };
  });
  const norm = octaves.reduce((s, o) => s + o.amp, 0);
  const noise = d => {
    let v = 0;
    for (const o of octaves) {
      const x = (d / total) * o.cells;
      const i = Math.min(o.cells - 1, Math.floor(x));
      const t = x - i, s = t * t * (3 - 2 * t);
      v += o.amp * (o.values[i] + (o.values[i + 1] - o.values[i]) * s);
    }
    return v / norm;
  };

  const samples = [];
  for (let i = 0; i <= count; i++) samples.push(pointAt(pts, cum, (i / count) * total));
  const taper = Math.min(wavelength * 0.5, total / 4);
  const out = samples.map((p, i) => {
    const prev = samples[i > 0 ? i - 1 : (ring ? count - 1 : 0)];
    const next = samples[i < count ? i + 1 : (ring ? 1 : count)];
    const dx = next[0] - prev[0], dy = next[1] - prev[1], l = Math.hypot(dx, dy) || 1;
    const d = (i / count) * total;
    let k = 1;
    if (!ring) {
      const e = Math.min(d, total - d) / (taper || 1);
      k = e >= 1 ? 1 : e * e * (3 - 2 * e);
    }
    const off = noise(d) * amplitude * k;
    return [p[0] - (dy / l) * off, p[1] + (dx / l) * off];
  });
  if (ring) out[count] = out[0].slice();
  return out;
}

/**
 * The polyline an editor path is drawn along: smoothed if set, closed as a ring if closed, roughened if set.
 * Renderer, hit testing and outlines all use this so they agree.
 * @param {{points: number[][], closed: boolean, smooth?: boolean, rough?: number, seed?: number, id?: string}} p
 * @param {number} G  grid size in px; roughness scales with it
 */
export function pathPoints(p, G) {
  const raw = p.smooth ? smooth(p.points, p.closed) : p.points;
  let pts = ringPoints(raw, p.closed && !(p.smooth && p.points.length >= 3));
  if (p.rough > 0 && pts.length >= 2) {
    pts = roughen(pts, p.closed, { amplitude: p.rough * G * 0.6, wavelength: G * 2.5, seed: p.seed ?? hashSeed(p.id) });
  }
  return pts;
}

/** Distance from p to segment ab. */
export function segmentDistance(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
}
