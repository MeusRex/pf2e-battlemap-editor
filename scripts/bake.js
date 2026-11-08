import { MODULE_ID } from "./constants.js";
import { canvasToBlob, uploadBlob, uploadDir } from "./store.js";

const CHUNK = 4096;
const MAX_SIDE = 16384;
const MAX_AREA = 268_000_000;

function progress(label) {
  let note = null;
  try {
    note = ui.notifications.info(label, { progress: true });
  } catch (_) { /* older API */ }
  return {
    update(pct, message) {
      try { note?.update?.({ pct, message }); } catch (_) { /* ignore */ }
    },
    done(message) {
      try { note?.update?.({ pct: 1, message }); } catch (_) { /* ignore */ }
      if (!note?.update) ui.notifications.info(message);
    }
  };
}

/** The level background currently shown, unless it is one of our own bakes. */
export function currentUnderlay(store) {
  const src = canvas.level?.background?.src || null;
  if (!src) return null;
  if (store.data.baked?.src && src === store.data.baked.src) return store.data.underlay ?? null;
  if (src.includes(uploadDir(store.scene))) return store.data.underlay ?? null;
  return src;
}

/**
 * Render the map into one image, upload it and make it the viewed level's background.
 * @param {import("./layer.js").BattlemapLayer} layer
 * @param {{flatten?: boolean, quality?: number}} [o]
 */
export async function bakeMap(layer, { flatten = false, quality = 0.9 } = {}) {
  const { store, renderer } = layer;
  const scene = store.scene;
  const r = scene.dimensions.sceneRect;
  const W = Math.round(r.width), H = Math.round(r.height);
  if (W > MAX_SIDE || H > MAX_SIDE || W * H > MAX_AREA) {
    throw new Error(`The scene is ${W}×${H} px, too large for one image. Lower the grid size or split the map.`);
  }

  const bar = progress("Baking battlemap…");
  await store.save();
  if (!store.data.base && !store.data.underlay) store.data.underlay = currentUnderlay(store);
  await renderer.setUnderlay(store.data.base ? null : store.data.underlay);
  await renderer.ready();

  // Flattened objects are kept in the map data, so every later bake still contains them.
  const tiles = flatten ? scene.tiles.filter(t => t.flags?.[MODULE_ID]?.editor && !t.hidden) : [];
  const flattenedBefore = store.data.flattened.length;
  if (tiles.length) {
    store.data.flattened.push(...tiles.map(t => {
      const o = t.toObject();
      delete o._id;
      return o;
    }));
  }
  await renderer.buildFlat();

  const out = document.createElement("canvas");
  out.width = W;
  out.height = H;
  const ctx = out.getContext("2d");
  const bg = canvas.level?.background?.color;
  ctx.fillStyle = bg?.css ?? (typeof bg === "string" ? bg : "#000000");
  ctx.fillRect(0, 0, W, H);

  const pixi = canvas.app.renderer;
  const wasVisible = renderer.root.visible;
  renderer.root.visible = true;
  const chunks = [];
  for (let y = 0; y < H; y += CHUNK) for (let x = 0; x < W; x += CHUNK) chunks.push({ x, y, w: Math.min(CHUNK, W - x), h: Math.min(CHUNK, H - y) });
  try {
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      bar.update(0.1 + (0.6 * i) / chunks.length, `Rendering ${i + 1}/${chunks.length}…`);
      const rt = PIXI.RenderTexture.create({ width: c.w, height: c.h, resolution: 1 });
      try {
        // The map root sits at the scene origin in canvas space; shift it so this chunk lands at (0, 0).
        pixi.render(renderer.root, { renderTexture: rt, clear: true, transform: new PIXI.Matrix(1, 0, 0, 1, -(r.x + c.x), -(r.y + c.y)) });
        const img = pixi.extract.canvas(rt);
        ctx.drawImage(img, c.x, c.y);
      } finally {
        rt.destroy(true);
      }
      await new Promise(res => setTimeout(res, 0));
    }
  } catch (err) {
    store.data.flattened.length = flattenedBefore;
    await renderer.buildFlat();
    throw err;
  } finally {
    renderer.root.visible = wasVisible;
  }

  bar.update(0.75, "Encoding…");
  const blob = await canvasToBlob(out, "image/webp", quality);
  bar.update(0.85, "Uploading…");
  const path = await uploadBlob(blob, uploadDir(scene), `battlemap-${Date.now().toString(36)}.webp`);

  // Save the map first: changing the background redraws the canvas, and the redrawn layer reloads the map
  // from the scene flag, so the flag must already hold the bake result.
  const old = store.data.baked?.src;
  store.data.baked = { src: path, at: Date.now() };
  store.data.dirty = false;
  await store.save();
  store.data.dirty = false;

  if (tiles.length) await scene.deleteEmbeddedDocuments("Tile", tiles.map(t => t.id), { [MODULE_ID]: { keepLights: true } });
  const level = canvas.level;
  if (level) await level.update({ "background.src": path });
  else await scene.update({ "background.src": path });
  bar.done(`Battlemap baked (${W}×${H}, ${(blob.size / 1e6).toFixed(1)} MB)${tiles.length ? `, ${tiles.length} objects flattened` : ""}.`);
  if (old) console.log(`${MODULE_ID} | previous bake ${old} is no longer used and can be deleted.`);
  return path;
}
