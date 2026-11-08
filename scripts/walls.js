import { MODULE_ID } from "./constants.js";
import { cumulative, ringPoints } from "./geometry.js";

const S = () => CONST.EDGE_SENSE_TYPES;

/** Foundry wall restriction values for each editor wall type. */
function restrictions(type) {
  const { NONE, LIMITED, NORMAL } = S();
  const M = CONST.WALL_MOVEMENT_TYPES;
  switch (type) {
    case "terrain": return { move: M.NORMAL, sight: LIMITED, light: LIMITED, sound: LIMITED };
    case "invisible": return { move: M.NORMAL, sight: NONE, light: NONE, sound: NONE };
    case "ethereal": return { move: M.NONE, sight: NORMAL, light: NORMAL, sound: NORMAL };
    default: return { move: M.NORMAL, sight: NORMAL, light: NORMAL, sound: NORMAL };
  }
}

function openingData(opening, wallType, ppi) {
  const base = restrictions(wallType);
  const { NONE } = S();
  if (opening.kind === "window") {
    return { ...base, sight: NONE, light: NONE };
  }
  const data = {
    ...base,
    door: opening.kind === "secret" ? CONST.WALL_DOOR_TYPES.SECRET : CONST.WALL_DOOR_TYPES.DOOR,
    ds: CONST.WALL_DOOR_STATES.CLOSED
  };
  if (opening.src) {
    data.animation = { type: "swing", texture: opening.src, direction: 1, double: false, duration: 750, flip: false, strength: 1 };
    data.flags = { core: { textureGridSize: ppi } };
  }
  return data;
}

/**
 * Foundry Wall data for an editor wall: one document per polyline segment, split around openings.
 * @param {import("./store.js").WallEntry} entry
 * @param {{x: number, y: number}} origin  scene rect origin (scene-local -> canvas px)
 * @param {object} [o]
 * @param {number} [o.ppi=256]
 * @param {string[]} [o.levels]
 */
export function wallDocuments(entry, origin, { ppi = 256, levels = [] } = {}) {
  if (entry.type === "none" || entry.points.length < 2) return [];
  const pts = ringPoints(entry.points, entry.closed);
  const cum = cumulative(pts);
  const docs = [];
  const toCanvas = p => [Math.round(p[0] + origin.x), Math.round(p[1] + origin.y)];
  const push = (a, b, extra) => {
    const c = [...toCanvas(a), ...toCanvas(b)];
    if (c[0] === c[2] && c[1] === c[3]) return;
    docs.push(foundry.utils.mergeObject({
      c, levels, ...restrictions(entry.type),
      flags: { [MODULE_ID]: { wall: entry.id } }
    }, extra ?? {}, { inplace: false }));
  };

  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const s0 = cum[i - 1], s1 = cum[i], len = s1 - s0;
    if (len <= 0) continue;
    const at = d => [a[0] + ((b[0] - a[0]) * (d - s0)) / len, a[1] + ((b[1] - a[1]) * (d - s0)) / len];
    // Openings overlapping this segment, clipped to it.
    const parts = entry.openings
      .map(o => ({ o, d0: Math.max(s0, Math.min(o.d0, o.d1)), d1: Math.min(s1, Math.max(o.d0, o.d1)) }))
      .filter(p => p.d1 - p.d0 > 0.5)
      .sort((x, y) => x.d0 - y.d0);
    let cursor = s0;
    for (const p of parts) {
      if (p.d0 > cursor + 0.5) push(at(cursor), at(p.d0));
      push(at(p.d0), at(p.d1), {
        ...openingData(p.o, entry.type, ppi),
        flags: { [MODULE_ID]: { wall: entry.id, opening: p.o.id }, ...(openingData(p.o, entry.type, ppi).flags ?? {}) }
      });
      cursor = Math.max(cursor, p.d1);
    }
    if (s1 > cursor + 0.5) push(at(cursor), b);
  }
  return docs;
}

/**
 * Replace the Foundry walls generated for an editor wall. Returns the new ids.
 * @param {Scene} scene
 * @param {import("./store.js").WallEntry} entry
 */
export async function syncWalls(scene, entry, { ppi = 256 } = {}) {
  const existing = (entry.wallIds ?? []).filter(id => scene.walls.has(id));
  // Also catch walls tagged with this entry whose ids were lost (e.g. after an undo).
  for (const w of scene.walls) {
    if (w.flags?.[MODULE_ID]?.wall === entry.id && !existing.includes(w.id)) existing.push(w.id);
  }
  if (existing.length) await scene.deleteEmbeddedDocuments("Wall", existing);
  const levels = scene.levels?.size > 1 && canvas.level ? [canvas.level.id] : [];
  const docs = wallDocuments(entry, scene.dimensions.sceneRect, { ppi, levels });
  const created = docs.length ? await scene.createEmbeddedDocuments("Wall", docs) : [];
  entry.wallIds = created.map(w => w.id);
  return entry.wallIds;
}

/** Delete the Foundry walls of an editor wall. */
export async function removeWalls(scene, entry) {
  const ids = scene.walls.filter(w => w.flags?.[MODULE_ID]?.wall === entry.id || entry.wallIds?.includes(w.id)).map(w => w.id);
  if (ids.length) await scene.deleteEmbeddedDocuments("Wall", ids);
  entry.wallIds = [];
}
