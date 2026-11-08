import { cumulative } from "./geometry.js";

/**
 * A textured strip along a polyline, with mitred joints. Unlike PIXI.SimpleRope, the texture keeps its own
 * aspect ratio: it repeats every (texture width * scale) pixels along the line and is
 * (texture height * scale) thick. Used for walls and paths, so preview and bake look the same.
 *
 * @param {PIXI.Texture} texture
 * @param {number[][]} pts      polyline in canvas px, at least 2 points
 * @param {object} [o]
 * @param {number} [o.scale=1]  texture px -> canvas px
 * @param {boolean} [o.closed=false]  join last segment back to the first point
 * @param {boolean} [o.flip=false]    mirror across the line
 * @param {number|number[]} [o.extend=0]  extend open ends by this many px (square caps); [start, end] or both
 * @returns {PIXI.Mesh|null}
 */
export function makeRope(texture, pts, { scale = 1, closed = false, flip = false, extend = 0 } = {}) {
  let points = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 0.01);
  if (closed && points.length > 2) {
    const f = points[0], l = points[points.length - 1];
    if (Math.hypot(f[0] - l[0], f[1] - l[1]) > 0.01) points.push(f.slice());
  }
  if (points.length < 2) return null;
  const isRing = closed && points.length > 3;

  const [extStart, extEnd] = Array.isArray(extend) ? extend : [extend, extend];
  if ((extStart > 0 || extEnd > 0) && !isRing) {
    points = points.map(p => p.slice());
    const ext = (p, q, by) => {
      if (!(by > 0)) return;
      const dx = p[0] - q[0], dy = p[1] - q[1], l = Math.hypot(dx, dy) || 1;
      p[0] += (dx / l) * by;
      p[1] += (dy / l) * by;
    };
    ext(points[0], points[1], extStart);
    ext(points[points.length - 1], points[points.length - 2], extEnd);
  }

  const n = points.length;
  const half = (texture.height * scale) / 2;
  const repeat = texture.width * scale;
  const cum = cumulative(points);
  const verts = new Float32Array(n * 4);
  const uvs = new Float32Array(n * 4);
  const idx = new Uint16Array((n - 1) * 6);
  const side = flip ? -1 : 1;

  const normal = (a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    return [-dy / l, dx / l];
  };

  for (let i = 0; i < n; i++) {
    let nx, ny, miter = 1;
    const prev = i > 0 ? points[i - 1] : (isRing ? points[n - 2] : null);
    const next = i < n - 1 ? points[i + 1] : (isRing ? points[1] : null);
    const p = points[i];
    if (prev && next) {
      const n1 = normal(prev, p), n2 = normal(p, next);
      nx = n1[0] + n2[0];
      ny = n1[1] + n2[1];
      const l = Math.hypot(nx, ny);
      if (l < 1e-4) { [nx, ny] = n1; } else {
        nx /= l;
        ny /= l;
        const cos = nx * n1[0] + ny * n1[1];
        miter = Math.min(1 / Math.max(cos, 1e-3), 3);
      }
    } else {
      [nx, ny] = prev ? normal(prev, p) : normal(p, next);
    }
    const ox = nx * half * miter * side, oy = ny * half * miter * side;
    verts.set([p[0] + ox, p[1] + oy, p[0] - ox, p[1] - oy], i * 4);
    const u = cum[i] / repeat;
    uvs.set([u, 0, u, 1], i * 4);
  }
  for (let i = 0; i < n - 1; i++) {
    const k = i * 2;
    idx.set([k, k + 1, k + 2, k + 2, k + 1, k + 3], i * 6);
  }

  texture.baseTexture.wrapMode = PIXI.WRAP_MODES.REPEAT;
  const geometry = new PIXI.MeshGeometry(verts, uvs, idx);
  const material = new PIXI.MeshMaterial(texture);
  return new PIXI.Mesh(geometry, material);
}
