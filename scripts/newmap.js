import { FLAG_MAP, LAYER_NAME, MODULE_ID } from "./constants.js";
import { EditorCatalog } from "./catalog.js";
import { emptyMap } from "./store.js";

const esc = s => foundry.utils.escapeHTML(String(s ?? ""));

/** One representative texture per terrain folder, for the base terrain choice. */
function baseChoices(cat) {
  const seen = new Map();
  for (const a of cat.kinds.terrain ?? []) {
    const folder = a.folder.split("/").slice(0, 2).join("/");
    if (!seen.has(folder)) seen.set(folder, a);
  }
  return [...seen.entries()].map(([folder, a]) => ({
    src: a.src, label: folder.split("/").pop().replace(/_Terrain$/, "").replace(/_/g, " ")
  })).sort((x, y) => x.label.localeCompare(y.label));
}

/**
 * Create a new battlemap scene: sized, gridded, lit, with a base terrain, and open it in the editor.
 */
export async function openNewMapDialog() {
  if (!game.user.isGM) return;
  let cat;
  try {
    cat = await EditorCatalog.load();
  } catch (err) {
    return ui.notifications.error(err.message);
  }
  const choices = baseChoices(cat);
  const selected = game.settings.get(MODULE_ID, "toolState")?.selection?.terrain?.[0];
  const preferred = selected ?? choices.find(c => /grass/i.test(c.label))?.src;
  const options = choices.map(c => `<option value="${esc(c.src)}" ${c.src === preferred ? "selected" : ""}>${esc(c.label)}</option>`).join("");
  const G = game.settings.get(MODULE_ID, "gridSize");

  const data = await foundry.applications.api.DialogV2.input({
    window: { title: "New battlemap", icon: "fa-solid fa-file-circle-plus" },
    position: { width: 460 },
    content: `
      <div class="form-group"><label>Name</label>
        <div class="form-fields"><input type="text" name="name" value="New battlemap" autofocus></div></div>
      <div class="form-group"><label>Size (squares)</label>
        <div class="form-fields">
          <input type="number" name="w" value="30" min="5" max="200" step="1"> ×
          <input type="number" name="h" value="20" min="5" max="200" step="1">
        </div></div>
      <div class="form-group"><label>Grid size (px)</label>
        <div class="form-fields"><input type="number" name="grid" value="${G}" min="50" max="256" step="1"></div>
        <p class="hint">FA art is drawn at 256 px per square; 100–150 is a good balance of sharpness and file size.</p></div>
      <div class="form-group"><label>Base terrain</label>
        <div class="form-fields"><select name="base"><option value="">None (paint later)</option>${options}</select></div></div>
      <div class="form-group"><label>Darkness</label>
        <div class="form-fields"><input type="range" name="darkness" value="0" min="0" max="1" step="0.05"></div></div>
      <div class="form-group"><label>Token vision</label>
        <div class="form-fields"><input type="checkbox" name="vision" checked></div></div>`,
    ok: { label: "Create", icon: "fa-solid fa-check" },
    rejectClose: false
  });
  if (!data) return;

  const w = Math.max(5, Math.round(Number(data.w) || 30));
  const h = Math.max(5, Math.round(Number(data.h) || 20));
  const size = Math.max(50, Math.round(Number(data.grid) || G));
  const darkness = Number(data.darkness) || 0;
  const map = emptyMap();
  if (data.base) {
    map.base = { src: data.base };
    map.dirty = true;
  }
  const scene = await CONFIG.Scene.documentClass.create({
    name: data.name?.trim() || "New battlemap",
    width: w * size,
    height: h * size,
    padding: 0.1,
    grid: { size, type: CONST.GRID_TYPES.SQUARE },
    tokenVision: !!data.vision,
    environment: { darknessLevel: darkness, globalLight: { enabled: darkness < 0.5 } },
    navigation: false,
    flags: { [MODULE_ID]: { [FLAG_MAP]: map } }
  });
  Hooks.once("canvasReady", () => {
    canvas[LAYER_NAME]?.activate({ tool: "terrain" });
  });
  await scene.view();
  ui.notifications.info(`Created "${scene.name}". Paint, draw walls, place objects, then bake.`);
  return scene;
}
