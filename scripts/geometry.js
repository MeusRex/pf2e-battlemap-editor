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

/** Distance from p to segment ab. */
export function segmentDistance(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
}
