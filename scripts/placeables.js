import { MODULE_ID } from "./constants.js";

/**
 * Selecting and editing tiles and ambient lights from the editor's Select tool,
 * so the GM does not have to switch to Foundry's Tile or Lighting controls.
 */

function onViewedLevel(doc) {
  const level = canvas.level;
  return !level || typeof doc.includedInLevel !== "function" || doc.includedInLevel(level);
}

/** Tiles on the viewed level, topmost first. */
export function tilesTopDown(scene = canvas.scene) {
  return scene.tiles.filter(onViewedLevel).sort((a, b) =>
    ((b.elevation ?? 0) - (a.elevation ?? 0)) || ((b.sort ?? 0) - (a.sort ?? 0)));
}

export function lightsOnLevel(scene = canvas.scene) {
  return scene.lights.filter(onViewedLevel);
}

/** The four corners of a tile in canvas space (v14: x/y is the anchor point, rotation pivots on it). */
export function tileCorners(doc) {
  const ax = doc.texture?.anchorX ?? 0.5;
  const ay = doc.texture?.anchorY ?? 0.5;
  const w = doc.width, h = doc.height;
  const rad = Math.toRadians(doc.rotation ?? 0);
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return [[-ax * w, -ay * h], [(1 - ax) * w, -ay * h], [(1 - ax) * w, (1 - ay) * h], [-ax * w, (1 - ay) * h]]
    .map(([x, y]) => [doc.x + x * cos - y * sin, doc.y + x * sin + y * cos]);
}

function insidePolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt.y) !== (yj > pt.y) && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Topmost tile under a canvas point (only tiles passing filter); transparent pixels do not count. */
export function tileAt(pos, filter = null) {
  for (const doc of tilesTopDown()) {
    if (filter && !filter(doc)) continue;
    const mesh = doc.object?.mesh;
    let hit;
    try {
      hit = mesh && !mesh.destroyed ? mesh.containsCanvasPoint(pos, 0.15) : insidePolygon(pos, tileCorners(doc));
    } catch (_) {
      hit = insidePolygon(pos, tileCorners(doc));
    }
    if (hit) return doc;
  }
  return null;
}

export function lightAt(pos, radius) {
  let best = null, bestD = radius;
  for (const doc of lightsOnLevel()) {
    const d = Math.hypot(doc.x - pos.x, doc.y - pos.y);
    if (d <= bestD) {
      best = doc;
      bestD = d;
    }
  }
  return best;
}

/** Lights the editor created for a tile. */
export function linkedLights(tile) {
  return tile.parent?.lights.filter(l => l.flags?.[MODULE_ID]?.tile === tile.id) ?? [];
}

export function isAlive(doc) {
  const coll = doc?.documentName === "Tile" ? doc.parent?.tiles : doc?.parent?.lights;
  return !!coll?.has(doc.id) && coll.get(doc.id) === doc;
}

/** Re-resolve a document by id (undo can recreate it as a new instance). */
export function resolve(scene, type, id) {
  return (type === "tile" ? scene.tiles : scene.lights).get(id) ?? null;
}

/** Short label for the palette. */
export function describe(doc) {
  if (doc.documentName === "AmbientLight") {
    const c = doc.config;
    return `Light (bright ${c.bright}, dim ${c.dim})`;
  }
  const file = decodeURIComponent(doc.texture?.src?.split("/").pop() ?? "tile").replace(/\.[^.]+$/, "").replace(/_/g, " ");
  return file;
}
