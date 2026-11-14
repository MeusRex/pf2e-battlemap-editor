/**
 * Room geometry. A map's rooms are an ordered list of drawn pieces:
 *   - "merge":    adds floor; opens into everything it overlaps or touches (dungeons, open halls)
 *   - "separate": adds floor as its own room; keeps a wall where it meets other rooms (houses)
 *   - "erase":    cuts away floor
 * Walls are derived from the pieces: the outline of the combined floor, plus the outlines of separate rooms
 * inside it. Uses Foundry's bundled ClipperLib (Clipper 6) for the polygon operations.
 *
 * @typedef {object} RoomPiece
 * @property {string} id
 * @property {"merge"|"separate"|"erase"} mode
 * @property {number[][]} ring          outline in scene-local px (curves already tessellated)
 * @property {string|null} floor        terrain texture for the floor (null = no floor, terrain shows)
 * @property {{src: string|null, type: string, width: number}} wall   wall style
 */

const SCALE = 8;   // Clipper works in integers: 1/8 px precision
const CL = () => globalThis.ClipperLib;

const toPath = ring => ring.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }));
const fromPath = path => path.map(p => [p.X / SCALE, p.Y / SCALE]);

function run(type, subject, clip, { open = false, tree = false } = {}) {
  const L = CL();
  const c = new L.Clipper();
  if (subject.length) c.AddPaths(subject, L.PolyType.ptSubject, !open);
  if (clip.length) c.AddPaths(clip, L.PolyType.ptClip, true);
  const out = tree || open ? new L.PolyTree() : new L.Paths();
  c.Execute(type, out, L.PolyFillType.pftNonZero, L.PolyFillType.pftNonZero);
  return out;
}

const union = (a, b = []) => run(CL().ClipType.ctUnion, a, b);
const difference = (a, b) => (b.length ? run(CL().ClipType.ctDifference, a, b) : a);
const intersection = (a, b) => run(CL().ClipType.ctIntersection, a, b);

/** Grow (delta > 0) or shrink polygons by delta px. */
function offset(paths, delta) {
  if (!paths.length) return [];
  const L = CL();
  const co = new L.ClipperOffset(2, 0.25 * SCALE);
  co.AddPaths(paths, L.JoinType.jtMiter, L.EndType.etClosedPolygon);
  const out = new L.Paths();
  co.Execute(out, delta * SCALE);
  return out;
}

/** Parts of open polylines that lie inside the polygons. */
function clipLines(lines, polys) {
  if (!lines.length || !polys.length) return [];
  const L = CL();
  return L.Clipper.OpenPathsFromPolyTree(run(L.ClipType.ctIntersection, lines, polys, { open: true }));
}

function subtractLines(lines, polys) {
  if (!lines.length || !polys.length) return lines;
  const L = CL();
  return L.Clipper.OpenPathsFromPolyTree(run(L.ClipType.ctDifference, lines, polys, { open: true }));
}

const area = paths => paths.reduce((s, p) => s + Math.abs(CL().Clipper.Area(p)), 0) / (SCALE * SCALE);

/** Inside test with holes (nonzero over all rings). */
function inside(paths, [x, y]) {
  const L = CL();
  const pt = { X: Math.round(x * SCALE), Y: Math.round(y * SCALE) };
  let w = 0;
  for (const p of paths) {
    if (L.Clipper.PointInPolygon(pt, p) !== 0) w += L.Clipper.Orientation(p) ? 1 : -1;
  }
  return w !== 0;
}

/**
 * Connected regions of a polygon set: [{outer, holes}] in scene px.
 * @returns {{outer: number[][], holes: number[][][]}[]}
 */
export function components(paths) {
  const tree = run(CL().ClipType.ctUnion, paths, [], { tree: true });
  const out = [];
  const walk = node => {
    for (const child of node.Childs()) {
      if (child.IsHole()) { walk(child); continue; }
      out.push({ outer: fromPath(child.Contour()), holes: child.Childs().map(h => fromPath(h.Contour())) });
      for (const h of child.Childs()) walk(h);
    }
  };
  walk(tree);
  return out;
}

/* -------------------------------------------- */
/*  Shapes                                      */
/* -------------------------------------------- */

/** Circle through three points, or null if they are (nearly) collinear. */
function circle3(a, b, c) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-6) return null;
  const s = p => p[0] * p[0] + p[1] * p[1];
  const x = (s(a) * (b[1] - c[1]) + s(b) * (c[1] - a[1]) + s(c) * (a[1] - b[1])) / d;
  const y = (s(a) * (c[0] - b[0]) + s(b) * (a[0] - c[0]) + s(c) * (b[0] - a[0])) / d;
  return { x, y, r: Math.hypot(a[0] - x, a[1] - y) };
}

/** Points strictly between a and c on the circular arc a -> b -> c. */
export function arcPoints(a, b, c, step) {
  const k = circle3(a, b, c);
  if (!k || k.r > 1e5) return [b.slice()];
  const ang = p => Math.atan2(p[1] - k.y, p[0] - k.x);
  const norm = t => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const a0 = ang(a);
  const sweepB = norm(ang(b) - a0), sweepC = norm(ang(c) - a0);
  // Go the way round that passes through b.
  const sweep = sweepB <= sweepC ? sweepC : sweepC - 2 * Math.PI;
  const n = Math.max(4, Math.ceil((Math.abs(sweep) * k.r) / step));
  const out = [];
  for (let i = 1; i < n; i++) {
    const t = a0 + (sweep * i) / n;
    out.push([k.x + Math.cos(t) * k.r, k.y + Math.sin(t) * k.r]);
  }
  return out;
}

/**
 * Outline of a clicked polygon. A point marked as a curve point turns its two neighbours into the ends of a
 * circular arc through it (a curve point next to another curve point stays a corner).
 * @param {number[][]} points
 * @param {boolean[]} curves
 * @param {boolean} closed
 * @param {number} step  max arc segment length in px
 */
export function outline(points, curves, closed, step) {
  const n = points.length;
  const isCurve = i => !!curves[i];
  const out = [];
  for (let i = 0; i < n; i++) {
    const prevI = i > 0 ? i - 1 : (closed ? n - 1 : -1);
    const nextI = i < n - 1 ? i + 1 : (closed ? 0 : -1);
    if (isCurve(i) && prevI >= 0 && nextI >= 0 && !isCurve(prevI) && !isCurve(nextI) && n >= 3) {
      out.push(...arcPoints(points[prevI], points[i], points[nextI], step));
    } else out.push(points[i].slice());
  }
  return out;
}

export function circlePoints(cx, cy, r, step) {
  const n = Math.max(16, Math.ceil((2 * Math.PI * r) / step));
  return Array.from({ length: n }, (_, i) => [cx + Math.cos((i / n) * 2 * Math.PI) * r, cy + Math.sin((i / n) * 2 * Math.PI) * r]);
}

/* -------------------------------------------- */
/*  Derived floors and walls                    */
/* -------------------------------------------- */

/** The combined floor after all pieces, as Clipper paths. */
function finalRegion(pieces) {
  let F = [];
  for (const p of pieces) {
    const P = [toPath(p.ring)];
    F = p.mode === "erase" ? difference(F, P) : union(F, P);
  }
  return F;
}

/** Combined floor outline (for previews and hit tests). */
export function roomRegion(pieces) {
  return components(finalRegion(pieces));
}

/**
 * Floor polygons to draw, bottom to top: each added piece clipped to the final floor (later pieces draw over
 * earlier ones, erased parts are gone).
 * @returns {{floor: string, comps: {outer: number[][], holes: number[][][]}[]}[]}
 */
export function roomFloors(pieces) {
  if (!pieces.some(p => p.mode !== "erase" && p.floor)) return [];
  const F = finalRegion(pieces);
  const out = [];
  for (const p of pieces) {
    if (p.mode === "erase" || !p.floor) continue;
    const eff = intersection([toPath(p.ring)], F);
    if (area(eff) > 1) out.push({ floor: p.floor, comps: components(eff) });
  }
  return out;
}

/** The topmost added piece that contains a point (scene px), or null. */
export function pieceAt(pieces, pt) {
  const F = finalRegion(pieces);
  if (!inside(F, pt)) return null;
  for (let i = pieces.length - 1; i >= 0; i--) {
    const p = pieces[i];
    if (p.mode !== "erase" && inside([toPath(p.ring)], pt)) return p;
  }
  return null;
}

/** Whether a new outline overlaps or touches existing floor (for the "merge" hint). */
export function touchesFloor(pieces, ring) {
  return area(intersection(offset([toPath(ring)], 1), finalRegion(pieces))) > 1;
}

/**
 * Wall polylines for the rooms, grouped by style.
 * @param {RoomPiece[]} pieces
 * @returns {{points: number[][], closed: boolean, style: {src: string|null, type: string, width: number}, piece: string}[]}
 */
export function roomWalls(pieces) {
  const added = pieces.filter(p => p.mode !== "erase");
  if (!added.length) return [];
  const F = finalRegion(pieces);
  const lines = [];   // {pts (scene px, open), piece}

  // Outer walls: every ring of the combined floor. Each segment takes the style of the topmost piece on its inner side.
  // Break outline edges where a piece corner lies on them, so a long straight wall shared by two rooms
  // can change style where the rooms meet.
  const corners = added.flatMap(p => p.ring);
  const outerRings = F.map(ring => splitAtCorners(fromPath(ring), corners));
  for (const pts of outerRings) {
    const segs = pts.map((a, i) => [a, pts[(i + 1) % pts.length]]);
    const owners = segs.map(([a, b]) => ownerOf(pieces, F, a, b));
    pushRuns(lines, pts, owners, true);
  }

  // Inner walls of separate rooms: their outline inside the floor, except where a later room covers it.
  const shrunk = offset(F, -1);
  pieces.forEach((p, i) => {
    if (p.mode !== "separate") return;
    const later = pieces.slice(i + 1).filter(q => q.mode !== "erase").map(q => toPath(q.ring));
    const ring = toPath(p.ring);
    let parts = clipLines([[...ring, ring[0]]], shrunk);
    if (later.length) parts = subtractLines(parts, offset(union(later), -1));
    for (const part of parts) {
      if (part.length < 2) continue;
      const pts = fromPath(part);
      // The clip against the shrunk floor stops 1 px short of the outer wall; close that gap so no light leaks.
      snapToRings(pts[0], outerRings);
      snapToRings(pts[pts.length - 1], outerRings);
      lines.push({ pts, closed: false, piece: p.id });
    }
  });

  const byId = new Map(pieces.map(p => [p.id, p]));
  const merged = joinLines(dedupe(lines));
  return merged.map(l => ({ points: l.pts, closed: l.closed, piece: l.piece, style: { ...(byId.get(l.piece)?.wall ?? {}) } }));
}

/** Insert the given points into a closed ring wherever they lie on one of its edges. */
function splitAtCorners(pts, corners) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    out.push(a);
    const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
    if (len2 < 1) continue;
    const len = Math.sqrt(len2);
    const ts = [];
    for (const c of corners) {
      const t = ((c[0] - a[0]) * dx + (c[1] - a[1]) * dy) / len2;
      if (t * len < 0.5 || (1 - t) * len < 0.5) continue;
      const off = Math.abs((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / len;
      if (off < 0.75) ts.push(t);
    }
    ts.sort((x, y) => x - y);
    let last = -1;
    for (const t of ts) {
      if ((t - last) * len < 0.5) continue;
      out.push([a[0] + dx * t, a[1] + dy * t]);
      last = t;
    }
  }
  return out;
}

/** Move p onto the nearest ring edge if it is within 2 px of one. */
function snapToRings(p, rings) {
  let best = null, bd = 2;
  for (const pts of rings) {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
      const q = [a[0] + dx * t, a[1] + dy * t];
      const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
      if (d < bd) { bd = d; best = q; }
    }
  }
  if (best) { p[0] = best[0]; p[1] = best[1]; }
}

/** Topmost added piece on the inner side of segment ab of the floor outline. */
function ownerOf(pieces, F, a, b) {
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
  const nx = -dy / l * 1.5, ny = dx / l * 1.5;
  const inner = inside(F, [mx + nx, my + ny]) ? [mx + nx, my + ny] : [mx - nx, my - ny];
  for (let i = pieces.length - 1; i >= 0; i--) {
    const p = pieces[i];
    if (p.mode !== "erase" && inside([toPath(p.ring)], inner)) return p.id;
  }
  // On an erased edge the inner side belongs to whatever piece is under the eraser's outline; fall back to the
  // piece nearest to the point.
  let best = null, bd = Infinity;
  for (const p of pieces) {
    if (p.mode === "erase") continue;
    for (const q of p.ring) {
      const d = Math.hypot(q[0] - mx, q[1] - my);
      if (d < bd) { bd = d; best = p.id; }
    }
  }
  return best;
}

/** Split a ring into runs of the same owner; a ring with one owner stays closed. */
function pushRuns(lines, pts, owners, closed) {
  const n = pts.length;
  if (n < 2) return;
  if (owners.every(o => o === owners[0])) {
    lines.push({ pts: pts.map(p => p.slice()), closed, piece: owners[0] });
    return;
  }
  // Start at an owner change so no run wraps around the seam.
  let start = owners.findIndex((o, i) => o !== owners[(i - 1 + n) % n]);
  let run = null;
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    if (!run || run.piece !== owners[i]) {
      if (run) lines.push(run);
      run = { pts: [pts[i].slice()], closed: false, piece: owners[i] };
    }
    run.pts.push(pts[(i + 1) % n].slice());
  }
  if (run) lines.push(run);
}

/**
 * Remove segment parts that repeat an earlier line (two separate rooms sharing a wall), so each wall is
 * drawn and created once. Works on collinear overlaps, which covers grid-aligned rooms and shared arcs.
 */
function dedupe(lines) {
  const kept = [];   // segments already emitted: [a, b]
  const out = [];
  for (const line of lines) {
    const pts = line.closed ? [...line.pts, line.pts[0]] : line.pts;
    let cur = null;
    const flush = () => {
      if (cur && cur.pts.length >= 2) out.push(cur);
      cur = null;
    };
    let allKept = true;
    const pieces = [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const free = freeParts(a, b, kept);
      if (free.length !== 1 || free[0][0] > 1e-6 || free[0][1] < 1 - 1e-6) allKept = false;
      pieces.push({ a, b, free });
    }
    if (allKept) {
      out.push(line);
    } else {
      for (const { a, b, free } of pieces) {
        for (const [t0, t1] of free) {
          const p0 = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0];
          const p1 = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];
          if (cur && Math.hypot(cur.pts[cur.pts.length - 1][0] - p0[0], cur.pts[cur.pts.length - 1][1] - p0[1]) < 0.01) cur.pts.push(p1);
          else {
            flush();
            cur = { pts: [p0, p1], closed: false, piece: line.piece };
          }
        }
        if (!free.length || free[free.length - 1][1] < 1 - 1e-6) flush();
      }
      flush();
    }
    for (const { a, b } of pieces) kept.push([a, b]);
  }
  return out;
}

/** Sub-intervals [t0, t1] of segment ab not covered by a collinear kept segment. */
function freeParts(a, b, kept) {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
  if (len < 0.01) return [];
  const ux = dx / len, uy = dy / len;
  const covered = [];
  for (const [p, q] of kept) {
    const dp = Math.abs((p[0] - a[0]) * uy - (p[1] - a[1]) * ux);
    const dq = Math.abs((q[0] - a[0]) * uy - (q[1] - a[1]) * ux);
    if (dp > 0.75 || dq > 0.75) continue;
    const tp = ((p[0] - a[0]) * ux + (p[1] - a[1]) * uy) / len;
    const tq = ((q[0] - a[0]) * ux + (q[1] - a[1]) * uy) / len;
    const lo = Math.max(0, Math.min(tp, tq)), hi = Math.min(1, Math.max(tp, tq));
    if (hi - lo > 1e-6) covered.push([lo, hi]);
  }
  covered.sort((x, y) => x[0] - y[0]);
  const free = [];
  let t = 0;
  for (const [lo, hi] of covered) {
    if (lo > t + 0.5 / len) free.push([t, lo]);
    t = Math.max(t, hi);
  }
  if (t < 1 - 0.5 / len) free.push([t, 1]);
  return free;
}

/** Join open lines of the same piece that continue each other; drop collinear middle points. */
function joinLines(lines) {
  const close = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.01;
  const open = lines.filter(l => !l.closed);
  const result = lines.filter(l => l.closed);
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < open.length; i++) {
      for (let j = 0; j < open.length; j++) {
        if (i === j || open[i].piece !== open[j].piece) continue;
        const A = open[i], B = open[j];
        if (close(A.pts[A.pts.length - 1], B.pts[0])) {
          A.pts.push(...B.pts.slice(1));
          open.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
  }
  for (const l of open) {
    if (l.pts.length > 3 && close(l.pts[0], l.pts[l.pts.length - 1])) {
      l.pts.pop();
      l.closed = true;
    }
    result.push(l);
  }
  for (const l of result) l.pts = simplify(l.pts, l.closed);
  return result.filter(l => l.pts.length >= 2);
}

function simplify(pts, closed) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    if (out.length && Math.hypot(p[0] - out[out.length - 1][0], p[1] - out[out.length - 1][1]) < 0.5) continue;
    const prev = out[out.length - 1];
    const next = pts[i + 1] ?? (closed ? pts[0] : null);
    if (prev && next) {
      const cross = (p[0] - prev[0]) * (next[1] - p[1]) - (p[1] - prev[1]) * (next[0] - p[0]);
      const l = Math.hypot(p[0] - prev[0], p[1] - prev[1]) * Math.hypot(next[0] - p[0], next[1] - p[1]);
      const dot = (p[0] - prev[0]) * (next[0] - p[0]) + (p[1] - prev[1]) * (next[1] - p[1]);
      if (l > 0 && Math.abs(cross) / l < 1e-4 && dot > 0) continue;
    }
    out.push(p);
  }
  return out;
}
