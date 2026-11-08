import { FLAG_MAP, MAP_VERSION, MASK_RES, MODULE_ID } from "./constants.js";

/**
 * @typedef {object} TerrainLayer
 * @property {string} id
 * @property {string} src        terrain texture
 * @property {string|null} mask  uploaded PNG of the painted mask (white = visible)
 * @property {number} v          cache-busting version of the mask file
 *
 * @typedef {object} PathEntry
 * @property {string} id
 * @property {string} src
 * @property {number[][]} points  scene-local px
 * @property {boolean} closed
 * @property {boolean} smooth
 * @property {boolean} flip
 * @property {number} width       thickness multiplier
 *
 * @typedef {object} Opening
 * @property {string} id
 * @property {"door"|"secret"|"window"} kind
 * @property {number} d0          start distance along the wall polyline
 * @property {number} d1          end distance
 * @property {string|null} src    door or window art
 *
 * @typedef {object} WallEntry
 * @property {string} id
 * @property {string|null} src    wall art (null = Foundry walls only)
 * @property {number[][]} points  scene-local px
 * @property {boolean} closed
 * @property {string} type        key of WALL_TYPES
 * @property {number} width       thickness multiplier
 * @property {Opening[]} openings
 * @property {string[]} wallIds   Foundry Wall documents generated from this entry
 *
 * @typedef {object} MapData
 * @property {number} version
 * @property {number} maskRes
 * @property {{src: string}|null} base
 * @property {TerrainLayer[]} layers
 * @property {PathEntry[]} paths
 * @property {WallEntry[]} walls
 * @property {object[]} flattened     tile data of objects painted into the bake (restorable as tiles)
 * @property {string|null} underlay   background that was there before the first bake
 * @property {{src: string, at: number}|null} baked
 * @property {boolean} dirty          changed since the last bake
 */

/** @returns {MapData} */
export function emptyMap() {
  return {
    version: MAP_VERSION, maskRes: MASK_RES, base: null, layers: [], paths: [], walls: [], flattened: [],
    underlay: null, baked: null, dirty: false
  };
}

export function uploadDir(scene) {
  const base = game.settings.get(MODULE_ID, "outputFolder").trim() || `worlds/${game.world.id}/battlemap-editor`;
  return `${base.replace(/\/+$/, "")}/${scene.id}`;
}

async function ensureDirectory(path) {
  const FP = foundry.applications.apps.FilePicker.implementation;
  const parts = path.split("/").filter(Boolean);
  for (let i = 1; i <= parts.length; i++) {
    try {
      await FP.createDirectory("data", parts.slice(0, i).join("/"), {});
    } catch (_) { /* usually "already exists" */ }
  }
}

const ensured = new Set();

export async function uploadBlob(blob, dir, fileName) {
  const FP = foundry.applications.apps.FilePicker.implementation;
  if (!ensured.has(dir)) {
    await ensureDirectory(dir);
    ensured.add(dir);
  }
  const file = new File([blob], fileName, { type: blob.type || "image/png" });
  const res = await FP.upload("data", dir, file, {}, { notify: false });
  if (!res?.path) throw new Error(`Upload of ${fileName} failed`);
  return res.path;
}

export function canvasToBlob(c, type = "image/png", quality) {
  return new Promise((resolve, reject) => {
    c.toBlob(b => (b ? resolve(b) : reject(new Error("Canvas export failed"))), type, quality);
  });
}

/**
 * The editable map of one scene: vector data in a scene flag, painted masks as uploaded PNGs.
 */
export class MapStore {
  /** @param {Scene} scene */
  constructor(scene) {
    this.scene = scene;
    /** @type {MapData} */
    this.data = foundry.utils.mergeObject(emptyMap(), foundry.utils.deepClone(scene.getFlag(MODULE_ID, FLAG_MAP) ?? {}));
    /** @type {Map<string, HTMLCanvasElement>} layer id -> mask canvas */
    this.masks = new Map();
    this.#dirtyMasks = new Set();
    this.#saveTimer = null;
    this.#saving = null;
  }

  #dirtyMasks;
  #saveTimer;
  #saving;

  get gridSize() {
    return this.scene.grid.size;
  }

  /** Mask canvas dimensions for the scene. */
  get maskSize() {
    const r = this.scene.dimensions.sceneRect;
    const k = this.data.maskRes / this.gridSize;
    return { w: Math.max(1, Math.ceil(r.width * k)), h: Math.max(1, Math.ceil(r.height * k)), k };
  }

  get isEmpty() {
    const d = this.data;
    return !d.base && !d.layers.length && !d.paths.length && !d.walls.length && !d.flattened.length;
  }

  /** Create a blank mask canvas. */
  newMask() {
    const { w, h } = this.maskSize;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }

  /** Load (or create) the mask canvas for a layer. */
  async loadMask(layer) {
    if (this.masks.has(layer.id)) return this.masks.get(layer.id);
    const c = this.newMask();
    this.masks.set(layer.id, c);
    if (layer.mask) {
      try {
        const img = await new Promise((resolve, reject) => {
          const i = new Image();
          i.onload = () => resolve(i);
          i.onerror = () => reject(new Error(`Could not load mask ${layer.mask}`));
          i.src = `${encodeURI(layer.mask)}?v=${layer.v ?? 0}`;
        });
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      } catch (err) {
        console.warn(`${MODULE_ID} |`, err);
      }
    }
    return c;
  }

  markMask(layerId) {
    this.#dirtyMasks.add(layerId);
    this.touch();
  }

  /** Flag the map as changed and schedule a save. */
  touch({ delay = 2500 } = {}) {
    this.data.dirty = true;
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => this.save().catch(err => {
      console.error(err);
      ui.notifications.error(`Battlemap Editor: saving failed: ${err.message}`);
    }), delay);
  }

  get hasPendingChanges() {
    return !!this.#saveTimer || this.#dirtyMasks.size > 0;
  }

  /** Upload changed masks and write the flag now. */
  async save() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
    if (this.#saving) await this.#saving;
    this.#saving = this.#doSave();
    try {
      await this.#saving;
    } finally {
      this.#saving = null;
    }
  }

  async #doSave() {
    const dir = uploadDir(this.scene);
    const pending = [...this.#dirtyMasks];
    this.#dirtyMasks.clear();
    for (const id of pending) {
      const layer = this.data.layers.find(l => l.id === id);
      const c = this.masks.get(id);
      if (!layer || !c) continue;
      const blob = await canvasToBlob(c, "image/png");
      layer.mask = await uploadBlob(blob, dir, `mask-${layer.id}.png`);
      layer.v = Date.now();
    }
    if (!this.scene.id || !game.scenes.has(this.scene.id)) return;
    await this.scene.update({ [`flags.${MODULE_ID}.${FLAG_MAP}`]: foundry.utils.deepClone(this.data) },
      { [MODULE_ID]: { fromEditor: true } });
  }
}
