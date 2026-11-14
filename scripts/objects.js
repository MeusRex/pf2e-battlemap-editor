import { LIGHT_PRESETS, MODULE_ID } from "./constants.js";
import { layerTileFields, nextSortInLayer } from "./tilelayers.js";

/** Grid squares an asset covers at scale 1. */
export function footprint(asset, ppi = 256) {
  return { w: asset.w / ppi, h: asset.h / ppi };
}

/**
 * Snap the centre of an object so that its footprint lines up with the grid:
 * odd sizes centre on a square, even sizes on a grid line.
 */
export function snapCenter(point, asset, scale, ppi = 256) {
  const G = canvas.grid.size;
  const { w, h } = footprint(asset, ppi);
  const snapAxis = (v, size, offset) => {
    const n = Math.max(1, Math.round(size * scale));
    const half = n % 2 ? G / 2 : 0;
    return Math.round((v - offset - half) / G) * G + offset + half;
  };
  const r = canvas.dimensions.sceneRect;
  return { x: snapAxis(point.x, w, r.x), y: snapAxis(point.y, h, r.y) };
}

/** Tile data for placing an asset centred on a canvas point (v14: x/y is the anchor point). */
export function tileData(asset, { x, y, rotation = 0, scale = 1, mirror = false, sort = 0, ppi = 256 }) {
  const G = canvas.grid.size;
  const width = Math.max(1, Math.round((asset.w / ppi) * G * scale));
  const height = Math.max(1, Math.round((asset.h / ppi) * G * scale));
  const data = {
    // In v14 a tile's x/y is its texture anchor; with the default 0.5/0.5 anchor that is the centre.
    texture: { src: asset.src, scaleX: mirror ? -1 : 1, anchorX: 0.5, anchorY: 0.5 },
    width, height,
    x: Math.round(x),
    y: Math.round(y),
    rotation: ((rotation % 360) + 360) % 360,
    sort,
    flags: { [MODULE_ID]: { editor: true } }
  };
  const level = canvas.level;
  if (canvas.scene.levels?.size > 1 && level) {
    data.levels = [level.id];
    if (Number.isFinite(level.elevation?.bottom)) data.elevation = level.elevation.bottom;
  }
  return data;
}

export function nextTileSort(scene) {
  let max = 0;
  for (const t of scene.tiles) max = Math.max(max, t.sort ?? 0);
  return max + 1;
}

/** Light preset for an asset, if it looks like a light source. */
export function lightPreset(asset) {
  const isLightFolder = /(^|\/)Lightsources\//i.test(asset.rel) || asset.tags.some(t => /light/i.test(t));
  const preset = LIGHT_PRESETS.find(p => p.match.test(asset.name));
  if (preset) return preset;
  if (isLightFolder) return { bright: 1, dim: 3, color: "#ffc27a", animation: "torch", intensity: 2 };
  return null;
}

export function lightData(preset, { x, y }) {
  const dist = canvas.scene.grid.distance || 5;
  const data = {
    x: Math.round(x), y: Math.round(y),
    config: {
      bright: preset.bright * dist, dim: preset.dim * dist, color: preset.color, alpha: 0.4,
      animation: { type: preset.animation ?? null, speed: 3, intensity: preset.intensity ?? 3 }
    },
    flags: { [MODULE_ID]: { editor: true } }
  };
  const level = canvas.level;
  if (canvas.scene.levels?.size > 1 && level) {
    data.levels = [level.id];
    if (Number.isFinite(level.elevation?.bottom)) data.elevation = level.elevation.bottom;
  }
  return data;
}

/**
 * Create tiles (and lights for light-source assets).
 * @param {Scene} scene
 * @param {{asset: object, x: number, y: number, rotation?: number, scale?: number, mirror?: boolean}[]} items
 * @param {{autoLight?: boolean, ppi?: number, layer?: import("./tilelayers.js").TileLayer, mapData?: object}} [o]
 *   layer + mapData: put the tiles on that tile layer (its sort band, elevation and occlusion)
 * @returns {Promise<{tiles: TileDocument[], lights: AmbientLightDocument[]}>}
 */
export async function placeObjects(scene, items, { autoLight = true, ppi = 256, layer = null, mapData = null } = {}) {
  const onLayer = layer && mapData;
  let sort = onLayer ? nextSortInLayer(scene, mapData, layer) : nextTileSort(scene);
  const extra = onLayer ? foundry.utils.expandObject(layerTileFields(layer)) : null;
  const tiles = await scene.createEmbeddedDocuments("Tile", items.map(i => {
    const data = tileData(i.asset, { ...i, sort: sort++, ppi });
    return extra ? foundry.utils.mergeObject(data, foundry.utils.deepClone(extra)) : data;
  }));
  const lights = [];
  if (autoLight) {
    const data = [];
    tiles.forEach((tile, k) => {
      const preset = lightPreset(items[k].asset);
      if (!preset) return;
      const d = lightData(preset, items[k]);
      d.flags[MODULE_ID].tile = tile.id;
      data.push(d);
    });
    if (data.length) lights.push(...await scene.createEmbeddedDocuments("AmbientLight", data));
  }
  return { tiles, lights };
}

/** When an editor tile is deleted, delete the light it created. */
export function registerLightCleanup() {
  Hooks.on("deleteTile", (tile, options, userId) => {
    if (userId !== game.user.id || options?.[MODULE_ID]?.keepLights) return;
    const scene = tile.parent;
    const ids = scene?.lights.filter(l => l.flags?.[MODULE_ID]?.tile === tile.id).map(l => l.id) ?? [];
    if (ids.length) scene.deleteEmbeddedDocuments("AmbientLight", ids);
  });
}
