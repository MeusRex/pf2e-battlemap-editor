import { FLAG_MAP, LAYER_NAME, MODULE_ID } from "./constants.js";
import { EditorCatalog } from "./catalog.js";
import { BattlemapLayer } from "./layer.js";
import { openNewMapDialog } from "./newmap.js";
import { registerLightCleanup } from "./objects.js";
import { bakeMap } from "./bake.js";

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "assetRoot", {
    name: "Asset folder",
    hint: "Folder (relative to the Foundry Data folder) with bme-index.json and the extracted FA assets, as written by tools/extract_fa_packs.py.",
    scope: "world", config: true, type: String, default: "fa-assets",
    onChange: () => EditorCatalog.load({ force: true }).catch(err => console.error(err))
  });
  game.settings.register(MODULE_ID, "gridSize", {
    name: "Default grid size (px)",
    hint: "Pixels per square for new battlemaps. FA art is authored at 256.",
    scope: "world", config: true, type: Number, default: 100,
    range: { min: 50, max: 256, step: 1 }
  });
  game.settings.register(MODULE_ID, "outputFolder", {
    name: "Output folder",
    hint: "Where painted masks and baked backgrounds are uploaded. Empty = worlds/<world>/battlemap-editor.",
    scope: "world", config: true, type: String, default: ""
  });
  game.settings.register(MODULE_ID, "toolState", {
    scope: "client", config: false, type: Object, default: {}
  });

  CONFIG.Canvas.layers[LAYER_NAME] = { layerClass: BattlemapLayer, group: "interface" };
  registerLightCleanup();
});

Hooks.once("ready", () => {
  game.modules.get(MODULE_ID).api = {
    EditorCatalog,
    openNewMapDialog,
    bake: options => bakeMap(canvas[LAYER_NAME], options),
    get layer() {
      return canvas[LAYER_NAME];
    }
  };
  if (game.user.isGM) EditorCatalog.load().catch(err => console.warn(`${MODULE_ID} |`, err.message));
});

/* Another GM (or a macro) changed the map of the viewed scene: reload it. */
Hooks.on("updateScene", (scene, changes, options) => {
  if (scene !== canvas.scene || !game.user.isGM) return;
  if (!foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${FLAG_MAP}`)) return;
  if (options?.[MODULE_ID]?.fromEditor) return;
  canvas[LAYER_NAME]?.reload();
});

/* "New battlemap" button in the Scenes sidebar. */
Hooks.on("renderSceneDirectory", (app, html) => {
  if (!game.user.isGM) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  const actions = root?.querySelector(".header-actions");
  if (!actions || actions.querySelector(".bme-new")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "bme-new";
  btn.innerHTML = `<i class="fa-solid fa-map-location-dot"></i> <span>New battlemap</span>`;
  btn.addEventListener("click", ev => {
    ev.preventDefault();
    openNewMapDialog();
  });
  actions.append(btn);
});
