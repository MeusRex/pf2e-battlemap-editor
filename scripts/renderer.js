import { MODULE_ID } from "./constants.js";
import { cumulative, pointAt, ringPoints, smooth, splitByRanges } from "./geometry.js";
import { makeRope } from "./rope.js";

/** Texture px -> scene px for Dungeondraft art (authored at 256 px per square). */
export function artScale(gridSize, ppi = 256) {
  return gridSize / ppi;
}

async function tex(src) {
  try {
    return await foundry.canvas.loadTexture(src);
  } catch (err) {
    console.warn(`${MODULE_ID} | could not load ${src}`, err);
    return null;
  }
}

const OPAQUE_CACHE = new Map();
const OPAQUE_VERT = `
attribute vec2 aVertexPosition;
attribute vec2 aTextureCoord;
uniform mat3 projectionMatrix;
uniform mat3 translationMatrix;
uniform mat3 uTextureMatrix;
varying vec2 vTextureCoord;
void main() {
  gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);
  vTextureCoord = (uTextureMatrix * vec3(aTextureCoord, 1.0)).xy;
}`;
const OPAQUE_FRAG = `
varying vec2 vTextureCoord;
uniform sampler2D uSampler;
void main() {
  gl_FragColor = vec4(texture2D(uSampler, vTextureCoord).rgb, 1.0);
}`;

/**
 * FA terrain textures carry a blend-weight alpha channel (Dungeondraft uses it for height blending), so drawn
 * as-is they come out as faint washes. Load them without premultiplication and redraw them fully opaque.
 * @returns {Promise<PIXI.Texture|null>}
 */
export function opaqueTexture(src) {
  if (OPAQUE_CACHE.has(src)) return OPAQUE_CACHE.get(src);
  const p = (async () => {
    const res = await fetch(encodeURI(src));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bmp = await createImageBitmap(await res.blob(), { premultiplyAlpha: "none" });
    const base = new PIXI.BaseTexture(bmp, { alphaMode: PIXI.ALPHA_MODES.NPM });
    const raw = new PIXI.Texture(base);
    const w = bmp.width, h = bmp.height;
    const geometry = new PIXI.MeshGeometry(
      new Float32Array([0, 0, w, 0, w, h, 0, h]), new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), new Uint16Array([0, 1, 2, 0, 2, 3]));
    const material = new PIXI.MeshMaterial(raw, { program: PIXI.Program.from(OPAQUE_VERT, OPAQUE_FRAG, "bme-opaque") });
    const mesh = new PIXI.Mesh(geometry, material);
    const rt = PIXI.RenderTexture.create({ width: w, height: h, resolution: 1 });
    canvas.app.renderer.render(mesh, { renderTexture: rt, clear: true });
    mesh.destroy();
    raw.destroy(true);
    bmp.close?.();
    rt.baseTexture.wrapMode = PIXI.WRAP_MODES.REPEAT;
    return rt;
  })().catch(err => {
    console.warn(`${MODULE_ID} | could not load ${src}`, err);
    OPAQUE_CACHE.delete(src);
    return null;
  });
  OPAQUE_CACHE.set(src, p);
  return p;
}

/**
 * Draws the editable map (terrain, paths, wall art, windows) as a PIXI container in the primary canvas group,
 * just above the level background and below tiles and tokens. Everything inside is in scene-local px.
 */
export class MapRenderer {
  /** @param {import("./store.js").MapStore} store */
  constructor(store) {
    this.store = store;
    this.root = new PIXI.Container();
    this.root.name = `${MODULE_ID}.map`;
    this.root.eventMode = "none";
    this.underlay = this.root.addChild(new PIXI.Container());
    this.terrain = this.root.addChild(new PIXI.Container());
    this.paths = this.root.addChild(new PIXI.Container());
    this.walls = this.root.addChild(new PIXI.Container());
    this.flat = this.root.addChild(new PIXI.Container());
    /** @type {Map<string, {container: PIXI.Container, tiling: PIXI.TilingSprite, mask: PIXI.Sprite, texture: PIXI.Texture}>} */
    this.layerViews = new Map();
    this.#pendingMaskUpdates = new Set();
    this.#raf = null;
  }

  #pendingMaskUpdates;
  #raf;
  #terrainBuild = 0;
  #vectorBuild = 0;
  #flatBuild = 0;

  get scene() {
    return this.store.scene;
  }

  /** Insert into canvas.primary just above the viewed level's background. */
  attach() {
    const r = canvas.dimensions.sceneRect;
    this.root.position.set(r.x, r.y);
    const bottom = canvas.level?.elevation?.bottom;
    this.root.elevation = Number.isFinite(bottom) ? bottom : 0;
    this.root.sortLayer = foundry.canvas.groups.PrimaryCanvasGroup.SORT_LAYERS.SCENE;
    this.root.sort = 1;
    this.root.zIndex = 1;
    canvas.primary.addChild(this.root);
    canvas.primary.sortDirty = true;
  }

  destroy() {
    if (this.#raf) cancelAnimationFrame(this.#raf);
    if (!this.root.destroyed) {
      this.root.parent?.removeChild(this.root);
      this.#destroyChildren(this.root);
      this.root.destroy();
    }
  }

  #destroyChildren(container) {
    if (container === this.terrain || container === this.root) {
      for (const view of this.layerViews.values()) view.texture.destroy(true);
      this.layerViews.clear();
    }
    for (const c of container.removeChildren()) c.destroy({ children: true });
  }

  set visible(v) {
    this.root.visible = v;
  }

  get visible() {
    return this.root.visible;
  }

  /* -------------------------------------------- */
  /*  Full builds                                 */
  /* -------------------------------------------- */

  async build() {
    await Promise.all([this.buildTerrain(), this.buildVectors(), this.buildFlat()]);
  }

  /** Objects that were flattened into a bake, drawn as sprites so the preview and later bakes keep them. */
  async buildFlat() {
    const id = ++this.#flatBuild;
    const container = await tileSprites(this.store.data.flattened ?? [], this.scene.dimensions.sceneRect);
    if (id !== this.#flatBuild || this.root.destroyed) {
      container.destroy({ children: true });
      return;
    }
    this.#destroyChildren(this.flat);
    for (const c of container.removeChildren()) this.flat.addChild(c);
    container.destroy();
  }

  /** Base texture plus one masked tiling sprite per painted layer. */
  async buildTerrain() {
    const id = ++this.#terrainBuild;
    const d = this.store.data;
    const r = this.scene.dimensions.sceneRect;
    const scale = artScale(this.store.gridSize);
    const base = d.base?.src ? await opaqueTexture(d.base.src) : null;
    const layers = [];
    for (const layer of d.layers) {
      const [t, mask] = await Promise.all([opaqueTexture(layer.src), this.store.loadMask(layer)]);
      layers.push({ layer, t, mask });
    }
    if (id !== this.#terrainBuild || this.root.destroyed) return;

    this.#destroyChildren(this.terrain);
    if (base) {
      const s = new PIXI.TilingSprite(base, r.width, r.height);
      s.tileScale.set(scale);
      this.terrain.addChild(s);
    }
    for (const { layer, t, mask } of layers) {
      if (!t) continue;
      const container = new PIXI.Container();
      const tiling = new PIXI.TilingSprite(t, r.width, r.height);
      tiling.tileScale.set(scale);
      // Offset each layer's pattern so stacked textures don't line up.
      const hsh = hash(layer.id);
      tiling.tilePosition.set(((hsh % 1000) / 1000) * t.width * scale, (((hsh >>> 10) % 1000) / 1000) * t.height * scale);
      const texture = PIXI.Texture.from(mask, { scaleMode: PIXI.SCALE_MODES.LINEAR });
      const maskSprite = new PIXI.Sprite(texture);
      maskSprite.width = r.width;
      maskSprite.height = r.height;
      container.addChild(tiling, maskSprite);
      tiling.mask = maskSprite;
      this.terrain.addChild(container);
      this.layerViews.set(layer.id, { container, tiling, mask: maskSprite, texture });
    }
  }

  /** Paths, wall art and window art. */
  async buildVectors() {
    const id = ++this.#vectorBuild;
    const d = this.store.data;
    const G = this.store.gridSize;
    const scale = artScale(G);
    const srcs = new Set([
      ...d.paths.map(p => p.src), ...d.walls.map(w => w.src),
      ...d.walls.flatMap(w => w.openings.filter(o => o.kind === "window").map(o => o.src))
    ].filter(Boolean));
    const textures = new Map();
    await Promise.all([...srcs].map(async s => textures.set(s, await tex(s))));
    if (id !== this.#vectorBuild || this.root.destroyed) return;

    this.#destroyChildren(this.paths);
    this.#destroyChildren(this.walls);

    for (const p of d.paths) {
      const t = textures.get(p.src);
      if (!t || p.points.length < 2) continue;
      const pts = p.smooth ? smooth(p.points, p.closed) : p.points;
      const mesh = makeRope(t, pts, { scale: scale * (p.width ?? 1), closed: p.closed, flip: p.flip });
      if (mesh) this.paths.addChild(mesh);
    }

    for (const w of d.walls) {
      const t = w.src ? textures.get(w.src) : null;
      if (w.points.length < 2) continue;
      const pts = ringPoints(w.points, w.closed);
      const cum = cumulative(pts);
      const total = cum[cum.length - 1];
      if (t) {
        const s = scale * (w.width ?? 1);
        const half = (t.height * s) / 2;
        const pieces = w.openings.length ? splitByRanges(pts, cum, w.openings) : [pts];
        const whole = !w.openings.length;
        for (const piece of pieces) {
          // Square caps only at the true ends of an open wall, so door frames meet the art cleanly.
          const atStart = !w.closed && dist2(piece[0], pts[0]) < 1;
          const atEnd = !w.closed && dist2(piece[piece.length - 1], pts[pts.length - 1]) < 1;
          const mesh = makeRope(t, piece, {
            scale: s, closed: whole && w.closed, extend: [atStart ? half : 0, atEnd ? half : 0]
          });
          if (mesh) this.walls.addChild(mesh);
        }
      }
      for (const o of w.openings) {
        if (o.kind !== "window" || !o.src) continue;
        const wt = textures.get(o.src);
        if (!wt) continue;
        const a = pointAt(pts, cum, Math.min(o.d0, o.d1)), b = pointAt(pts, cum, Math.min(Math.max(o.d0, o.d1), total));
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const sprite = new PIXI.Sprite(wt);
        sprite.anchor.set(0.5);
        sprite.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
        sprite.rotation = Math.atan2(b[1] - a[1], b[0] - a[0]);
        sprite.width = len;
        sprite.height = wt.height * scale;
        this.walls.addChild(sprite);
      }
    }
  }

  /** Optional background image to keep under the map (an existing scene background). */
  async setUnderlay(src) {
    this.#destroyChildren(this.underlay);
    if (!src) return;
    const t = await tex(src);
    if (!t) return;
    const r = this.scene.dimensions.sceneRect;
    const s = new PIXI.Sprite(t);
    s.width = r.width;
    s.height = r.height;
    this.underlay.addChild(s);
  }

  /* -------------------------------------------- */
  /*  Incremental updates                         */
  /* -------------------------------------------- */

  /** Re-upload a mask texture on the next animation frame. */
  updateMask(layerId) {
    this.#pendingMaskUpdates.add(layerId);
    if (this.#raf) return;
    this.#raf = requestAnimationFrame(() => {
      this.#raf = null;
      for (const id of this.#pendingMaskUpdates) this.layerViews.get(id)?.texture.baseTexture.update();
      this.#pendingMaskUpdates.clear();
    });
  }

  /** Make sure every texture used by the map is loaded and the build is current (before baking). */
  async ready() {
    await this.build();
  }
}

/**
 * Sprites for tile data (documents or plain objects), in scene-local px.
 * @param {object[]} tiles
 * @param {{x: number, y: number}} origin  scene rect origin
 */
export async function tileSprites(tiles, origin) {
  const container = new PIXI.Container();
  const sorted = [...tiles].sort((a, b) => ((a.elevation ?? 0) - (b.elevation ?? 0)) || ((a.sort ?? 0) - (b.sort ?? 0)));
  const textures = await Promise.all(sorted.map(t => tex(t.texture?.src)));
  sorted.forEach((tile, i) => {
    const t = textures[i];
    if (!t) return;
    const s = new PIXI.Sprite(t);
    // v14: tile x/y is the texture anchor point.
    s.anchor.set(tile.texture.anchorX ?? 0.5, tile.texture.anchorY ?? 0.5);
    s.position.set(tile.x - origin.x, tile.y - origin.y);
    s.width = tile.width;
    s.height = tile.height;
    s.scale.x *= Math.sign(tile.texture.scaleX || 1);
    s.scale.y *= Math.sign(tile.texture.scaleY || 1);
    s.angle = tile.rotation ?? 0;
    s.alpha = tile.alpha ?? 1;
    if (tile.texture.tint) s.tint = tile.texture.tint;
    container.addChild(s);
  });
  return container;
}

function dist2(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
