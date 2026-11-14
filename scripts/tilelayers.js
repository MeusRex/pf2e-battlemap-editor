import { LAYER_NAME, MODULE_ID } from "./constants.js";

/**
 * Layers for the editor's tiles. Each layer is a band of Tile `sort` values (so its tiles always stay above the
 * layers below it) plus an elevation above the level floor and Foundry occlusion settings. A roof is a layer whose
 * tiles sit above token height and fade when a token is under them: plain Foundry v14 behaviour, so it keeps
 * working without the editor.
 *
 * @typedef {object} TileLayer
 * @property {string} id
 * @property {string} name
 * @property {number} height      elevation above the level floor, in scene units (0 = ground)
 * @property {"none"|"fade"|"radial"|"vision"} occlusion
 * @property {number} fade        opacity while occluded (0 = invisible)
 * @property {boolean} flatten    painted into the image by "Flatten objects"
 * @property {boolean} hidden     hidden while the editor is active (editor only, players unaffected)
 * @property {boolean} locked     the Select tool ignores its tiles
 */

export const BAND = 100000;

export const OCCLUSION_CHOICES = {
  none: "None (always visible)",
  fade: "Fade when a token is under it",
  radial: "Reveal around the token",
  vision: "Reveal what the token can see"
};

export function defaultTileLayers() {
  const base = { occlusion: "none", fade: 0, flatten: true, hidden: false, locked: false };
  return [
    { ...base, id: "floor", name: "Floor details", height: 0 },
    { ...base, id: "objects", name: "Objects", height: 0 },
    { ...base, id: "roof", name: "Roof", height: 10, occlusion: "fade", fade: 0, flatten: false },
    { ...base, id: "canopy", name: "Canopy", height: 20, occlusion: "fade", fade: 0.25, flatten: false }
  ];
}

/** The map's tile layers, creating the defaults on first use. */
export function tileLayers(data) {
  if (!Array.isArray(data.tileLayers) || !data.tileLayers.length) data.tileLayers = defaultTileLayers();
  return data.tileLayers;
}

/** Layer a tile belongs to (tiles without a layer count as "Objects", or the first layer). */
export function layerOfTile(data, doc) {
  const layers = tileLayers(data);
  const id = doc.flags?.[MODULE_ID]?.layer;
  return layers.find(l => l.id === id) ?? layers.find(l => l.id === "objects") ?? layers[0];
}

export function bandBase(data, layer) {
  return (tileLayers(data).indexOf(layer) + 1) * BAND;
}

function floorElevation() {
  const b = canvas.level?.elevation?.bottom;
  return Number.isFinite(b) ? b : 0;
}

/** Elevation and occlusion fields for a tile on a layer. */
export function layerTileFields(layer) {
  const M = CONST.OCCLUSION_MODES;
  const mode = { fade: M.FADE, radial: M.RADIAL, vision: M.VISION }[layer.occlusion];
  return {
    elevation: floorElevation() + (Number(layer.height) || 0),
    occlusion: { modes: mode ? [mode] : [], alpha: Math.min(1, Math.max(0, Number(layer.fade) || 0)) },
    [`flags.${MODULE_ID}.layer`]: layer.id
  };
}

/** Next free sort value at the top of a layer's band. */
export function nextSortInLayer(scene, data, layer) {
  const base = bandBase(data, layer);
  let max = base;
  for (const t of scene.tiles) {
    if (t.flags?.[MODULE_ID]?.editor && layerOfTile(data, t) === layer) max = Math.max(max, t.sort ?? 0);
  }
  return max + 1;
}

/**
 * Updates that put every editor tile in its layer's band with the layer's elevation and occlusion
 * (after layers were reordered or edited, or to adopt tiles placed before layers existed).
 * @returns {object[]} Tile updates (only for tiles that change)
 */
export function layerTileUpdates(scene, data, { only = null } = {}) {
  const layers = tileLayers(data);
  const updates = [];
  const byLayer = new Map(layers.map(l => [l, []]));
  for (const t of scene.tiles) {
    if (!t.flags?.[MODULE_ID]?.editor) continue;
    const layer = layerOfTile(data, t);
    if (only && layer !== only) continue;
    byLayer.get(layer)?.push(t);
  }
  for (const [layer, tiles] of byLayer) {
    const base = bandBase(data, layer);
    const fields = layerTileFields(layer);
    tiles.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
    tiles.forEach((t, i) => {
      const inBand = (t.sort ?? 0) > base && (t.sort ?? 0) < base + BAND;
      const sort = inBand ? t.sort : base + 1 + i;
      const modes = [...(t.occlusion?.modes ?? [])].sort().join();
      const same = sort === t.sort && t.elevation === fields.elevation && modes === [...fields.occlusion.modes].sort().join()
        && t.occlusion?.alpha === fields.occlusion.alpha && t.flags?.[MODULE_ID]?.layer === layer.id;
      if (!same) updates.push({ _id: t.id, sort, ...fields });
    });
  }
  return updates;
}

/** Re-base all editor tiles after a layer order change: each tile keeps its offset inside its band. */
export function rebandUpdates(scene, data, oldIndex) {
  const layers = tileLayers(data);
  const updates = [];
  for (const t of scene.tiles) {
    if (!t.flags?.[MODULE_ID]?.editor) continue;
    const layer = layerOfTile(data, t);
    const before = oldIndex.get(layer.id);
    if (before === undefined) continue;
    const offset = (t.sort ?? 0) - (before + 1) * BAND;
    const sort = (layers.indexOf(layer) + 1) * BAND + (offset > 0 && offset < BAND ? offset : 1);
    if (sort !== t.sort) updates.push({ _id: t.id, sort });
  }
  return updates;
}

/** Hide tiles of hidden layers while the editor is active (local display only). */
export function registerTileLayerHooks() {
  Hooks.on("refreshTile", tile => {
    const layer = canvas[LAYER_NAME];
    if (!layer?.active || !layer.store || !tile.document.flags?.[MODULE_ID]?.editor) return;
    if (layerOfTile(layer.store.data, tile.document)?.hidden && tile.mesh) {
      tile.mesh.visible = false;
      tile.visible = false;
    }
  });
}

/** Re-run tile visibility (after hiding/showing a layer or entering/leaving the editor). */
export function refreshTileVisibility() {
  for (const t of canvas.tiles?.placeables ?? []) t.renderFlags.set({ refreshVisibility: true });
}
