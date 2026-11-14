import { LAYER_NAME, MAX_TERRAIN_LAYERS, MODULE_ID } from "./constants.js";
import { EditorCatalog } from "./catalog.js";
import { MapStore } from "./store.js";
import { MapRenderer, artScale } from "./renderer.js";
import { cumulative, dist, pathPoints, project, ringPoints } from "./geometry.js";
import { removeWalls, syncWalls } from "./walls.js";
import { footprint, placeObjects, snapCenter } from "./objects.js";
import { BattlemapPalette } from "./palette.js";
import { bakeMap, currentUnderlay } from "./bake.js";
import { isAlive, lightAt, lightsOnLevel, linkedLights, tileAt, tileCorners } from "./placeables.js";
import { openNewMapDialog } from "./newmap.js";
import { circlePoints, outline, pieceAt, roomWalls } from "./rooms.js";

export const DEFAULT_SETTINGS = {
  selection: { terrain: [], path: [], wall: [], room: [], door: [], object: [], scatter: [] },
  brush: { size: 3, hardness: 0.4, opacity: 0.8, erase: false },
  path: { width: 1, smooth: true, flip: false, snap: false, rough: 0 },
  wall: { type: "normal", width: 1, snap: true },
  room: { shape: "rect", mode: "merge", snap: true, erase: false, repaintWalls: false },
  door: { width: 1, secret: false },
  object: { rotation: 0, scale: 1, randomRotation: false, randomMirror: false, scaleJitter: 0, snap: false, autoLight: true },
  scatter: { radius: 2, density: 0.5, spacing: 0.2, randomRotation: true, randomMirror: true, scaleJitter: 0.15, autoLight: false, variants: true },
  browse: { groupVariants: true }
};

const UNDO_LIMIT = 30;
const POLY_TOOLS = new Set(["path", "wall", "room"]);

function isTyping(event) {
  const el = event.target;
  return el instanceof HTMLElement && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
}

/**
 * The Battlemap Editor canvas layer: owns the tools, the map store of the viewed scene, and its preview renderer.
 */
export class BattlemapLayer extends foundry.canvas.layers.InteractionLayer {
  constructor() {
    super();
    this.settings = foundry.utils.mergeObject(foundry.utils.deepClone(DEFAULT_SETTINGS),
      game.settings.get(MODULE_ID, "toolState") ?? {}, { inplace: false });
    this.palette = new BattlemapPalette(this);
    /** @type {MapStore|null} */
    this.store = null;
    /** @type {MapRenderer|null} */
    this.renderer = null;
    this.tool = "terrain";
    this.undoStack = [];
    this.selected = null;
    this.#onKeyDown = this.#handleKeyDown.bind(this);
    canvas.registerMouseMoveHandler(this.#onMouseMove, foundry.canvas.Canvas.MOUSE_MOVE_HANDLER_PRIORITIES.LOW, this);
  }

  #onKeyDown;
  #draft = null;          // polyline being drawn: {tool, points, curves}
  #roomDrag = null;       // rectangle or circle room being dragged: {shape, start, erase}
  #stroke = null;         // terrain stroke in progress
  #scatter = null;        // scatter stroke in progress
  #move = null;           // tile or light being dragged with the Select tool
  #wheelUndo = null;      // coalesces wheel rotate/scale into one undo step
  #roll = null;           // pre-rolled randomness for the next placed object
  #ghostSrc = null;
  #brushCache = new Map();
  #settingsTimer = null;
  #built = false;

  static get layerOptions() {
    return foundry.utils.mergeObject(super.layerOptions, { name: LAYER_NAME, zIndex: 950 });
  }

  /** @override */
  static prepareSceneControls() {
    const layer = () => canvas[LAYER_NAME];
    const t = (name, order, title, icon, extra = {}) => ({ name, order, title, icon, ...extra });
    return {
      name: LAYER_NAME,
      order: 15,
      title: "Battlemap Editor",
      icon: "fa-solid fa-map-location-dot",
      layer: LAYER_NAME,
      visible: game.user.isGM,
      onChange: (_event, active) => {
        if (active) layer()?.activate();
      },
      onToolChange: (_event, tool, active) => {
        if (active) layer()?.setTool(tool.name);
      },
      tools: {
        terrain: t("terrain", 1, "Paint terrain (Alt: erase, Ctrl/Shift+wheel: brush size)", "fa-solid fa-paintbrush"),
        path: t("path", 2, "Draw path: roads, rivers, cliffs (click points, double-click/right-click/Enter to finish)", "fa-solid fa-route"),
        wall: t("wall", 3, "Draw walls with art and Foundry walls (click points, double-click/right-click/Enter to finish)", "fa-solid fa-block-brick"),
        room: t("room", 3.5, "Draw rooms: floor and walls together (drag a rectangle or circle, or click a polygon; Ctrl+click adds a curve)", "fa-solid fa-vector-square"),
        door: t("door", 4, "Place doors and windows on editor walls", "fa-solid fa-door-open"),
        object: t("object", 5, "Place objects (Shift+wheel: rotate, Ctrl+wheel: scale)", "fa-solid fa-chess-rook"),
        scatter: t("scatter", 6, "Scatter brush: drag to sprinkle the selected objects", "fa-solid fa-seedling"),
        pick: t("pick", 7, "Select: paths, walls, openings, tiles and lights (drag to move, double-click to configure)", "fa-solid fa-arrow-pointer"),
        palette: t("palette", 8, "Show the asset palette", "fa-solid fa-swatchbook", {
          button: true, onChange: () => layer()?.palette.render({ force: true })
        }),
        bake: t("bake", 9, "Bake the map into the scene background", "fa-solid fa-image", {
          button: true, onChange: () => layer()?.promptBake()
        }),
        newmap: t("newmap", 10, "New battlemap scene", "fa-solid fa-file-circle-plus", {
          button: true, onChange: () => openNewMapDialog()
        }),
        clear: t("clear", 11, "Clear the editor map of this scene", "fa-solid fa-trash", {
          button: true, onChange: () => layer()?.promptClear()
        })
      },
      activeTool: "terrain"
    };
  }

  /* -------------------------------------------- */
  /*  Lifecycle                                   */
  /* -------------------------------------------- */

  /** @override */
  async _draw(options) {
    await super._draw(options);
    this.overlay = this.addChild(new PIXI.Graphics());
    this.ghost = this.addChild(new PIXI.Sprite());
    this.ghost.anchor.set(0.5);
    this.ghost.alpha = 0.65;
    this.ghost.visible = false;
    this.#ghostSrc = null;
    this.#built = false;
    this.undoStack = [];
    this.selected = null;
    this.#draft = null;
    if (!game.user.isGM || !canvas.scene) return;
    this.store = new MapStore(canvas.scene);
    this.renderer = new MapRenderer(this.store);
    this.renderer.attach();
    this.renderer.visible = false;
    if (this.store.data.dirty && !this.store.isEmpty) await this.#ensureBuilt();
    this.refreshVisibility();
  }

  /** @override */
  async _tearDown(options) {
    if (this.store?.hasPendingChanges) {
      try {
        await this.store.save();
      } catch (err) {
        console.error(err);
      }
    }
    this.renderer?.destroy();
    this.renderer = null;
    this.store = null;
    this.#stroke = null;
    this.#scatter = null;
    return super._tearDown(options);
  }

  /** @override */
  _activate() {
    window.addEventListener("keydown", this.#onKeyDown);
    this.tool = ui.controls.tool?.name ?? this.tool;
    this.#ensureBuilt().then(() => this.refreshVisibility());
    EditorCatalog.load().then(() => this.palette.render({ force: true })).catch(err => {
      console.error(err);
      ui.notifications.error(err.message, { permanent: true });
    });
    this.rollNext();
  }

  /** @override */
  _deactivate() {
    window.removeEventListener("keydown", this.#onKeyDown);
    this.#draft = null;
    this.selected = null;
    this.overlay?.clear();
    if (this.ghost) this.ghost.visible = false;
    this.palette.close({ animate: false });
    if (this.store?.hasPendingChanges) this.store.save().catch(err => console.error(err));
    this.refreshVisibility();
    if (this.store?.data.dirty && !this.store.isEmpty) {
      ui.notifications.info("Battlemap Editor: the map has changes that are not baked yet. Players see them after you bake.");
    }
  }

  async #ensureBuilt() {
    if (this.#built || !this.renderer) return;
    this.#built = true;
    const d = this.store.data;
    await this.renderer.setUnderlay(d.base ? null : d.underlay);
    await this.renderer.build();
  }

  /** The preview is shown to the GM while editing, and while there are unbaked changes. */
  refreshVisibility() {
    if (!this.renderer) return;
    this.renderer.visible = game.user.isGM && !this.store.isEmpty && (this.active || this.store.data.dirty);
  }

  /** Reload the map after it was changed elsewhere (another GM, a macro). */
  async reload() {
    if (!canvas.scene || !this.renderer) return;
    this.store = new MapStore(canvas.scene);
    this.renderer.store = this.store;
    this.#built = false;
    this.undoStack = [];
    if (this.active || this.store.data.dirty) await this.#ensureBuilt();
    this.refreshVisibility();
  }

  setTool(name) {
    if (this.#draft && this.#draft.tool !== name) this.#draft = null;
    this.tool = name;
    this.selected = null;
    this.rollNext();
    if (this.palette.rendered) this.palette.render();
    this.#updateCursor(canvas.mousePosition);
  }

  saveSettings() {
    clearTimeout(this.#settingsTimer);
    this.#settingsTimer = setTimeout(() => game.settings.set(MODULE_ID, "toolState", this.settings), 800);
  }

  /**
   * Selected palette entries for a tool. An entry is an asset src (that exact asset) or "group:<key>"
   * (a random variant each time). With the scatter option "Always mix variants", single assets expand too.
   * @returns {{entry: string, asset: object, assets: object[], group: string|null}[]}
   */
  selectionItems(tool = this.tool) {
    const cat = this.catalog;
    if (!cat) return [];
    const expand = tool === "scatter" && this.settings.scatter.variants;
    const items = [];
    for (const entry of this.settings.selection[tool] ?? []) {
      if (entry.startsWith("group:")) {
        const key = entry.slice(6);
        const assets = cat.groups.get(key);
        if (assets?.length) items.push({ entry, asset: assets[0], assets, group: key });
        continue;
      }
      const asset = cat.get(entry);
      if (!asset) continue;
      items.push({ entry, asset, assets: expand ? cat.variants(asset) : [asset], group: null });
    }
    return items;
  }

  /** Selected assets for a tool (one representative per group entry). */
  selection(tool = this.tool) {
    return this.selectionItems(tool).map(i => i.asset);
  }

  /** A random asset from the selection: pick an entry, then one of its variants. */
  #pickAsset(items) {
    if (!items.length) return null;
    const item = items[Math.floor(Math.random() * items.length)];
    return item.assets[Math.floor(Math.random() * item.assets.length)];
  }

  setSelection(tool, srcs) {
    this.settings.selection[tool] = srcs;
    this.saveSettings();
    this.rollNext();
  }

  get catalog() {
    return EditorCatalog.current;
  }

  get G() {
    return canvas.grid.size;
  }

  get origin() {
    return canvas.dimensions.sceneRect;
  }

  toLocal(p) {
    return [p.x - this.origin.x, p.y - this.origin.y];
  }

  /* -------------------------------------------- */
  /*  Undo                                        */
  /* -------------------------------------------- */

  pushUndo(label, undo) {
    this.undoStack.push({ label, undo });
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
  }

  /** @override */
  _onUndoKey(event) {
    if (this.#draft?.points.length) {
      this.#draft.points.pop();
      this.#draft.curves?.pop();
      if (!this.#draft.points.length) this.#draft = null;
      this.#updateCursor(canvas.mousePosition);
      return true;
    }
    const entry = this.undoStack.pop();
    if (!entry) {
      ui.notifications.info("Battlemap Editor: nothing to undo.");
      return true;
    }
    Promise.resolve(entry.undo()).then(() => {
      this.refreshVisibility();
      ui.notifications.info(`Undid: ${entry.label}`);
    }).catch(err => {
      console.error(err);
      ui.notifications.error(`Undo failed: ${err.message}`);
    });
    return true;
  }

  /** @override */
  _onDismissKey(event) {
    if (this.#roomDrag) {
      this.#roomDrag = null;
      this.#updateCursor(canvas.mousePosition);
      return true;
    }
    if (this.#draft) {
      this.#draft = null;
      this.#updateCursor(canvas.mousePosition);
      return true;
    }
    if (this.selected) {
      this.selected = null;
      this.#updateCursor(canvas.mousePosition);
      this.palette.render();
      return true;
    }
    return false;
  }

  /** @override */
  _onDeleteKey(event) {
    if (this.tool === "pick" && this.selected) {
      this.deleteSelected();
      return true;
    }
    return false;
  }

  #handleKeyDown(event) {
    if (!this.active || isTyping(event) || event.repeat) return;
    if (event.key === "Enter" && this.#draft) {
      event.preventDefault();
      this.#finishDraft();
    } else if (event.key === "Backspace" && this.#draft) {
      event.preventDefault();
      this.#draft.points.pop();
      this.#draft.curves?.pop();
      if (!this.#draft.points.length) this.#draft = null;
      this.#updateCursor(canvas.mousePosition);
    }
  }

  /* -------------------------------------------- */
  /*  Mouse                                       */
  /* -------------------------------------------- */

  #onMouseMove(pos) {
    if (!this.active) return;
    this.#updateCursor(pos);
  }

  /** @override */
  _onClickLeft(event) {
    const pos = canvas.mousePosition;
    switch (this.tool) {
      case "terrain":
        // Foundry fires clicks on pointer-down; the stroke continues if a drag follows and ends on pointer-up.
        if (this.#beginStroke(event)) {
          this.#strokeTo(pos);
          this.#endOnPointerUp();
        }
        break;
      case "path": case "wall":
        this.#addDraftPoint(pos, event);
        break;
      case "room":
        this.#roomClick(pos, event);
        break;
      case "door":
        this.#placeOpening(pos);
        break;
      case "object":
        this.#placeObject(pos, event);
        break;
      case "scatter":
        this.#beginScatter();
        this.#scatterAt(pos);
        this.#endOnPointerUp();
        break;
      case "pick":
        this.selected = this.#hitTest(pos);
        this.palette.render();
        this.#updateCursor(pos);
        break;
    }
  }

  /** The tile or light selected with the Select tool, if it still exists. */
  get selectedDoc() {
    const sel = this.selected;
    if (!sel?.doc) return null;
    if (isAlive(sel.doc)) return sel.doc;
    this.selected = null;
    return null;
  }

  /** @override */
  _onClickLeft2(event) {
    if (POLY_TOOLS.has(this.tool) && this.#draft) this.#finishDraft();
    else if (this.tool === "pick") this.selectedDoc?.sheet?.render({ force: true });
  }

  /** @override */
  _onClickRight(event) {
    if (POLY_TOOLS.has(this.tool) && this.#draft) {
      if (this.#draft.points.length >= 2) this.#finishDraft();
      else this.#draft = null;
      this.#updateCursor(canvas.mousePosition);
    }
  }

  /** @override */
  _canDragLeftStart(user, event) {
    if (this.tool === "pick") {
      const doc = this.selectedDoc;
      if (!doc) return false;
      const origin = event.interactionData?.origin ?? canvas.mousePosition;
      return this.#hitTest(origin)?.doc === doc;
    }
    if (this.tool === "room") return !!this.#roomDrag;
    return this.tool === "terrain" || this.tool === "scatter";
  }

  /** @override */
  _onDragLeftStart(event) {
    if (this.tool === "terrain") {
      if (this.#stroke || this.#beginStroke(event)) this.#strokeTo(canvas.mousePosition);
    } else if (this.tool === "scatter") {
      if (!this.#scatter) this.#beginScatter();
      this.#scatterAt(canvas.mousePosition);
    } else if (this.tool === "pick") {
      this.#beginMove(event);
    }
  }

  /** Finish the current stroke or scatter when the mouse button is released. */
  #endOnPointerUp() {
    const end = () => {
      if (this.#stroke) this.#endStroke();
      if (this.#scatter) this.#endScatter();
    };
    window.addEventListener("pointerup", end, { once: true });
  }

  /** The polyline being drawn (for debugging and macros). */
  get draft() {
    return this.#draft;
  }

  /** @override */
  _onDragLeftMove(event) {
    const pos = canvas.mousePosition;
    if (this.#stroke) this.#strokeTo(pos);
    else if (this.#scatter) this.#scatterAt(pos);
    else if (this.#move) this.#moveTo(pos, event);
    this.#updateCursor(pos);
  }

  /** @override */
  _onDragLeftDrop(event) {
    if (this.#stroke) this.#endStroke();
    if (this.#scatter) this.#endScatter();
    if (this.#move) this.#endMove(true);
    if (this.#roomDrag) this.#finishRoomDrag();
  }

  /** @override */
  _onDragLeftCancel(event) {
    if (this.#stroke) this.#endStroke();
    if (this.#scatter) this.#endScatter();
    if (this.#move) this.#endMove(false);
    if (this.#roomDrag) this.#finishRoomDrag();
  }

  /** @override */
  _onMouseWheel(event) {
    const up = event.delta < 0;
    const shift = event.shiftKey;
    const s = this.settings;
    if (this.tool === "pick") {
      if (this.selectedDoc?.documentName !== "Tile") return;
      if (shift) this.#transformSelected({ rotate: up ? 15 : -15 });
      else this.#transformSelected({ scale: up ? 1.1 : 1 / 1.1 });
      return;
    }
    if (this.tool === "object") {
      if (shift) s.object.rotation = (s.object.rotation + (up ? 15 : -15) + 360) % 360;
      else s.object.scale = Math.round(Math.min(8, Math.max(0.1, s.object.scale * (up ? 1.1 : 1 / 1.1))) * 100) / 100;
    } else if (this.tool === "terrain") {
      s.brush.size = Math.round(Math.min(30, Math.max(0.25, s.brush.size * (up ? 1.15 : 1 / 1.15))) * 100) / 100;
    } else if (this.tool === "scatter") {
      s.scatter.radius = Math.round(Math.min(15, Math.max(0.5, s.scatter.radius * (up ? 1.15 : 1 / 1.15))) * 100) / 100;
    } else return;
    this.saveSettings();
    this.palette.refreshOptions();
    this.#updateCursor(canvas.mousePosition);
  }

  /* -------------------------------------------- */
  /*  Cursor & overlay                            */
  /* -------------------------------------------- */

  #snap(pos, mode) {
    const M = CONST.GRID_SNAPPING_MODES;
    const m = mode === "vertex" ? (M.VERTEX ?? 0xF0) : (M.VERTEX ?? 0xF0) | M.CENTER | M.EDGE_MIDPOINT;
    return canvas.grid.getSnappedPoint({ x: pos.x, y: pos.y }, { mode: m, resolution: 1 });
  }

  #draftPoint(pos, event) {
    const shift = event?.shiftKey ?? game.keyboard.isModifierActive("SHIFT");
    const s = this.settings[this.tool] ?? {};
    const wantSnap = s.snap ? !shift : shift;
    if (!wantSnap) return pos;
    // Room corners go on grid vertices; curve points (Ctrl) may also use centres and edge midpoints.
    const curve = this.tool === "room" && (event?.ctrlKey ?? game.keyboard.isModifierActive("CONTROL"));
    return this.#snap(pos, (this.tool === "wall" || this.tool === "room") && !curve ? "vertex" : "any");
  }

  #updateCursor(pos) {
    const g = this.overlay;
    if (!g || g.destroyed || !this.active) return;
    g.clear();
    this.ghost.visible = false;
    const G = this.G;
    const o = this.origin;
    const accent = 0xff9a3c;

    switch (this.tool) {
      case "terrain": {
        const r = (this.settings.brush.size * G) / 2;
        const erase = this.settings.brush.erase || game.keyboard.isModifierActive("ALT");
        g.lineStyle(2, erase ? 0xff4444 : 0xffffff, 0.9).drawCircle(pos.x, pos.y, r);
        g.lineStyle(1, 0x000000, 0.5).drawCircle(pos.x, pos.y, r * this.settings.brush.hardness);
        break;
      }
      case "scatter": {
        const r = this.settings.scatter.radius * G;
        g.lineStyle(2, 0x7dff8a, 0.9).drawCircle(pos.x, pos.y, r);
        break;
      }
      case "path": case "wall": {
        const p = this.#draftPoint(pos);
        g.lineStyle(1, 0xffffff, 0.8).drawCircle(p.x, p.y, 5);
        const pts = this.#draft?.points ?? [];
        if (pts.length) {
          g.lineStyle(3, accent, 0.9).moveTo(pts[0][0] + o.x, pts[0][1] + o.y);
          for (const q of pts.slice(1)) g.lineTo(q[0] + o.x, q[1] + o.y);
          g.lineStyle(2, accent, 0.5).lineTo(p.x, p.y);
          g.lineStyle(0).beginFill(accent, 0.9);
          for (const q of pts) g.drawCircle(q[0] + o.x, q[1] + o.y, 4);
          g.endFill();
          if (this.tool === "wall" && pts.length >= 3 && dist([p.x - o.x, p.y - o.y], pts[0]) < G * 0.3) {
            g.lineStyle(2, 0x7dff8a, 1).drawCircle(pts[0][0] + o.x, pts[0][1] + o.y, 10);
          }
        }
        break;
      }
      case "room":
        this.#drawRoomPreview(g, pos);
        break;
      case "door": {
        const hit = this.#openingAt(pos);
        this.#drawWallOutlines(g, 0x66aaff, 0.35);
        if (hit) {
          g.lineStyle(8, hit.replace ? 0xff4444 : 0x66ff99, 0.85).moveTo(hit.a[0] + o.x, hit.a[1] + o.y).lineTo(hit.b[0] + o.x, hit.b[1] + o.y);
        }
        break;
      }
      case "object": {
        const a = this.#roll?.asset;
        if (!a) break;
        this.#showGhost(a, this.#objectPoint(pos, a), this.#roll);
        break;
      }
      case "pick": {
        this.#drawWallOutlines(g, 0x66aaff, 0.3);
        this.#drawPathOutlines(g, 0xffffff, 0.2);
        g.lineStyle(1, 0x000000, 0.6);
        for (const l of lightsOnLevel()) g.beginFill(0xffd25a, 0.55).drawCircle(l.x, l.y, G * 0.12).endFill();
        if (this.#move) {
          this.#drawMove(g, accent);
          break;
        }
        this.selectedDoc;  // drops a selection whose document was deleted elsewhere
        const hover = this.#hitTest(pos);
        if (hover) this.#drawHit(g, hover, 0xffffff, 0.6);
        if (this.selected) this.#drawHit(g, this.selected, accent, 1);
        break;
      }
    }
  }

  #drawWallOutlines(g, color, alpha) {
    const o = this.origin;
    for (const w of this.store?.data.walls ?? []) {
      const pts = ringPoints(w.points, w.closed);
      if (pts.length < 2) continue;
      g.lineStyle(3, color, alpha).moveTo(pts[0][0] + o.x, pts[0][1] + o.y);
      for (const q of pts.slice(1)) g.lineTo(q[0] + o.x, q[1] + o.y);
    }
  }

  #drawPathOutlines(g, color, alpha) {
    const o = this.origin;
    for (const p of this.store?.data.paths ?? []) {
      const pts = pathPoints(p, this.G);
      if (pts.length < 2) continue;
      g.lineStyle(2, color, alpha).moveTo(pts[0][0] + o.x, pts[0][1] + o.y);
      for (const q of pts.slice(1)) g.lineTo(q[0] + o.x, q[1] + o.y);
    }
  }

  #drawHit(g, hit, color, alpha) {
    const o = this.origin;
    if (hit.type === "tile") {
      g.lineStyle(3, color, alpha).drawPolygon(tileCorners(hit.doc).flat());
      return;
    }
    if (hit.type === "light") {
      g.lineStyle(3, color, alpha).drawCircle(hit.doc.x, hit.doc.y, this.G * 0.22);
      return;
    }
    if (hit.type === "room") {
      const pts = hit.piece.ring;
      g.lineStyle(4, color, alpha).drawPolygon(pts.flatMap(p => [p[0] + o.x, p[1] + o.y]));
      return;
    }
    if (hit.type === "opening") {
      const { a, b } = this.#openingEnds(hit.wall, hit.opening);
      g.lineStyle(10, color, alpha).moveTo(a[0] + o.x, a[1] + o.y).lineTo(b[0] + o.x, b[1] + o.y);
      return;
    }
    const e = hit.entry;
    const pts = hit.type === "path" ? pathPoints(e, this.G) : ringPoints(e.points, e.closed);
    g.lineStyle(6, color, alpha).moveTo(pts[0][0] + o.x, pts[0][1] + o.y);
    for (const q of pts.slice(1)) g.lineTo(q[0] + o.x, q[1] + o.y);
  }

  async #showGhost(asset, p, roll) {
    const ghost = this.ghost;
    if (this.#ghostSrc !== asset.src) {
      this.#ghostSrc = asset.src;
      const t = await foundry.canvas.loadTexture(asset.src).catch(() => null);
      if (this.#ghostSrc !== asset.src || ghost.destroyed) return;
      ghost.texture = t ?? PIXI.Texture.EMPTY;
    }
    const { w, h } = footprint(asset, this.catalog?.ppi);
    const scale = this.settings.object.scale * (roll?.scale ?? 1);
    ghost.anchor.set(0.5);
    ghost.scale.set(1);  // the width setter keeps the sign of scale, so reset mirroring first
    ghost.width = w * this.G * scale;
    ghost.height = h * this.G * scale;
    if (roll?.mirror) ghost.scale.x = -Math.abs(ghost.scale.x);
    ghost.angle = this.settings.object.rotation + (roll?.rotation ?? 0);
    ghost.position.set(p.x, p.y);
    ghost.visible = true;
  }

  /* -------------------------------------------- */
  /*  Terrain painting                            */
  /* -------------------------------------------- */

  #brush(radius, hardness) {
    const r = Math.max(1, Math.round(radius));
    const key = `${r}:${hardness.toFixed(2)}`;
    let c = this.#brushCache.get(key);
    if (c) return c;
    c = document.createElement("canvas");
    c.width = c.height = r * 2;
    const ctx = c.getContext("2d");
    const grad = ctx.createRadialGradient(r, r, 0, r, r, r);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(Math.min(0.99, Math.max(0, hardness)), "rgba(255,255,255,1)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, r * 2, r * 2);
    if (this.#brushCache.size > 40) this.#brushCache.clear();
    this.#brushCache.set(key, c);
    return c;
  }

  #beginStroke(event) {
    if (!this.store) return false;
    const d = this.store.data;
    const b = this.settings.brush;
    const alt = event?.altKey ?? game.keyboard.isModifierActive("ALT");
    const src = this.selection("terrain")[0]?.src;
    let erase = b.erase || alt;
    if (!erase && !src) {
      ui.notifications.warn("Battlemap Editor: pick a terrain texture in the palette first.");
      return false;
    }
    if (!erase && !d.base) {
      if (currentUnderlay(this.store)) {
        // Painting over an existing background image: keep it underneath.
        if (!d.underlay) {
          this.captureUnderlay();
          this.renderer.setUnderlay(d.underlay);
        }
      } else {
        // The first texture becomes the base that fills the whole map.
        this.#setBase(src);
        return false;
      }
    }
    if (!erase && d.base?.src === src) erase = true; // painting the base texture = revealing it
    let layer = null, created = false;
    if (!erase) {
      layer = d.layers.find(l => l.src === src);
      if (!layer) {
        if (d.layers.length >= MAX_TERRAIN_LAYERS) {
          ui.notifications.warn(`Battlemap Editor: at most ${MAX_TERRAIN_LAYERS} painted textures per map. Remove one in the palette.`);
          return false;
        }
        layer = { id: foundry.utils.randomID(8), src, mask: null, v: 0 };
        d.layers.push(layer);
        this.store.masks.set(layer.id, this.store.newMask());
        created = true;
      }
    }
    const index = layer ? d.layers.indexOf(layer) : -1;
    const targets = d.layers.map((l, i) => ({ layer: l, mode: l === layer ? "paint" : (erase || i > index ? "erase" : null) }))
      .filter(t => t.mode);
    const snapshots = new Map();
    for (const t of targets) {
      const c = this.store.masks.get(t.layer.id);
      if (!c) continue;
      const copy = document.createElement("canvas");
      copy.width = c.width;
      copy.height = c.height;
      copy.getContext("2d").drawImage(c, 0, 0);
      snapshots.set(t.layer.id, copy);
    }
    this.#stroke = { targets, snapshots, last: null, created: created ? layer : null };
    if (created) this.renderer.buildTerrain().then(() => this.refreshVisibility());
    return true;
  }

  #strokeTo(pos) {
    const st = this.#stroke;
    if (!st) return;
    const { k } = this.store.maskSize;
    const b = this.settings.brush;
    const radius = (b.size * this.G * k) / 2;
    const brush = this.#brush(radius, b.hardness);
    const p = [(pos.x - this.origin.x) * k, (pos.y - this.origin.y) * k];
    const from = st.last ?? p;
    const spacing = Math.max(1, radius * 0.18);
    const steps = Math.max(1, Math.ceil(dist(from, p) / spacing));
    const alpha = Math.min(1, b.opacity * 0.45);
    for (const t of st.targets) {
      const c = this.store.masks.get(t.layer.id);
      if (!c) continue;
      const ctx = c.getContext("2d");
      ctx.save();
      ctx.globalCompositeOperation = t.mode === "paint" ? "source-over" : "destination-out";
      ctx.globalAlpha = alpha;
      for (let i = st.last ? 1 : 0; i <= steps; i++) {
        const x = from[0] + ((p[0] - from[0]) * i) / steps;
        const y = from[1] + ((p[1] - from[1]) * i) / steps;
        ctx.drawImage(brush, x - brush.width / 2, y - brush.height / 2);
      }
      ctx.restore();
      this.renderer.updateMask(t.layer.id);
    }
    st.last = p;
  }

  #endStroke() {
    const st = this.#stroke;
    this.#stroke = null;
    if (!st) return;
    for (const t of st.targets) this.store.markMask(t.layer.id);
    this.refreshVisibility();
    const store = this.store;
    this.pushUndo("paint stroke", async () => {
      if (st.created) {
        store.data.layers = store.data.layers.filter(l => l !== st.created);
        store.masks.delete(st.created.id);
      }
      for (const [id, snap] of st.snapshots) {
        const c = store.masks.get(id);
        if (!c) continue;
        const ctx = c.getContext("2d");
        ctx.clearRect(0, 0, c.width, c.height);
        ctx.drawImage(snap, 0, 0);
        store.markMask(id);
        this.renderer?.updateMask(id);
      }
      if (st.created) await this.renderer?.buildTerrain();
      store.touch();
    });
  }

  #setBase(src) {
    const d = this.store.data;
    const prev = d.base ? { ...d.base } : null;
    d.base = { src };
    this.store.touch();
    this.renderer.setUnderlay(null);
    this.renderer.buildTerrain().then(() => this.refreshVisibility());
    ui.notifications.info("Battlemap Editor: base terrain set. Paint other textures on top.");
    this.palette.render();
    this.pushUndo("set base terrain", async () => {
      d.base = prev;
      await this.renderer?.setUnderlay(prev ? null : d.underlay);
      await this.renderer?.buildTerrain();
      this.store.touch();
      this.palette.render();
    });
  }

  /** Fill the whole map with the selected texture (replaces the base, keeps painted layers). */
  fillBase() {
    const src = this.selection("terrain")[0]?.src;
    if (!src) return ui.notifications.warn("Battlemap Editor: pick a terrain texture first.");
    this.#setBase(src);
  }

  removeLayer(id) {
    const d = this.store.data;
    const i = d.layers.findIndex(l => l.id === id);
    if (i < 0) return;
    const [layer] = d.layers.splice(i, 1);
    const mask = this.store.masks.get(id);
    this.store.masks.delete(id);
    this.store.touch();
    this.renderer.buildTerrain();
    this.palette.render();
    this.pushUndo("remove texture layer", async () => {
      d.layers.splice(i, 0, layer);
      if (mask) this.store.masks.set(id, mask);
      this.store.markMask(id);
      await this.renderer?.buildTerrain();
      this.palette.render();
    });
  }

  moveLayer(id, dir) {
    const d = this.store.data;
    const i = d.layers.findIndex(l => l.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= d.layers.length) return;
    [d.layers[i], d.layers[j]] = [d.layers[j], d.layers[i]];
    this.store.touch();
    this.renderer.buildTerrain();
    this.palette.render();
  }

  /* -------------------------------------------- */
  /*  Paths and walls                             */
  /* -------------------------------------------- */

  #addDraftPoint(pos, event) {
    if (!this.store) return;
    const p = this.#draftPoint(pos, event);
    const q = this.toLocal(p);
    if (!this.#draft) {
      const erase = this.tool === "room" && (this.settings.room.erase || !!event?.altKey);
      this.#draft = { tool: this.tool, points: [], curves: [], erase };
    }
    const pts = this.#draft.points;
    if (pts.length && dist(pts[pts.length - 1], q) < 2) return; // double-click repeats the last point
    if ((this.tool === "wall" || this.tool === "room") && pts.length >= 3 && dist(q, pts[0]) < this.G * 0.3) {
      this.#finishDraft({ closed: true });
      return;
    }
    pts.push(q);
    this.#draft.curves.push(this.tool === "room" && !!event?.ctrlKey);
    this.#updateCursor(pos);
  }

  async #finishDraft({ closed = false } = {}) {
    const draft = this.#draft;
    this.#draft = null;
    this.#updateCursor(canvas.mousePosition);
    if (!draft || draft.points.length < 2 || !this.store) return;
    const d = this.store.data;
    const store = this.store;
    if (draft.tool === "room") {
      if (draft.points.length < 3) return;
      const ring = outline(draft.points, draft.curves, true, this.G / 4);
      return this.#addRoom(ring, draft.erase);
    }
    if (draft.tool === "path") {
      const src = this.selection("path")[0]?.src;
      if (!src) return ui.notifications.warn("Battlemap Editor: pick a path texture in the palette first.");
      const s = this.settings.path;
      const entry = { id: foundry.utils.randomID(8), src, points: draft.points, closed, smooth: s.smooth, flip: s.flip, width: s.width,
        rough: s.rough ?? 0, seed: Math.floor(Math.random() * 2 ** 31) };
      d.paths.push(entry);
      store.touch();
      await this.renderer.buildVectors();
      this.refreshVisibility();
      this.pushUndo("path", async () => {
        store.data.paths = store.data.paths.filter(p => p !== entry);
        store.touch();
        await this.renderer?.buildVectors();
      });
    } else {
      const s = this.settings.wall;
      const src = this.selection("wall")[0]?.src ?? null;
      const entry = {
        id: foundry.utils.randomID(8), src, points: draft.points, closed, type: s.type, width: s.width,
        openings: [], wallIds: []
      };
      d.walls.push(entry);
      await syncWalls(store.scene, entry, { ppi: this.catalog?.ppi });
      store.touch();
      await this.renderer.buildVectors();
      this.refreshVisibility();
      this.pushUndo("wall", async () => {
        store.data.walls = store.data.walls.filter(w => w !== entry);
        await removeWalls(store.scene, entry);
        store.touch();
        await this.renderer?.buildVectors();
      });
    }
  }

  /* -------------------------------------------- */
  /*  Rooms                                       */
  /* -------------------------------------------- */

  /** Wall style for new rooms: the Wall tool's art, type and thickness. */
  roomWallStyle() {
    const s = this.settings.wall;
    return { src: this.selection("wall")[0]?.src ?? null, type: s.type, width: s.width };
  }

  #roomClick(pos, event) {
    if (!this.store) return;
    const s = this.settings.room;
    if (s.shape === "repaint") return this.#repaintRoom(pos);
    if (s.shape === "poly") return this.#addDraftPoint(pos, event);
    // Rectangle and circle: pointer-down starts the shape, releasing the button finishes it.
    const p = this.#draftPoint(pos, event);
    this.#roomDrag = { shape: s.shape, start: this.toLocal(p), erase: s.erase || !!event?.altKey };
    window.addEventListener("pointerup", () => {
      if (this.#roomDrag) this.#finishRoomDrag();
    }, { once: true });
  }

  /** Outline of the rectangle or circle being dragged, ending at canvas point cur. */
  #roomDragRing(cur, drag = this.#roomDrag) {
    if (!drag) return null;
    const G = this.G;
    const a = drag.start, b = this.toLocal(cur);
    if (drag.shape === "circle") {
      let r = dist(a, b);
      const shift = game.keyboard.isModifierActive("SHIFT");
      if (this.settings.room.snap ? !shift : shift) r = Math.max(G / 2, Math.round(r / (G / 2)) * (G / 2));
      return r >= G / 4 ? circlePoints(a[0], a[1], r, G / 4) : null;
    }
    if (Math.abs(b[0] - a[0]) < G / 4 || Math.abs(b[1] - a[1]) < G / 4) return null;
    return [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]];
  }

  #finishRoomDrag() {
    const drag = this.#roomDrag;
    this.#roomDrag = null;
    const ring = this.#roomDragRing(this.#draftPoint(canvas.mousePosition), drag);
    this.#updateCursor(canvas.mousePosition);
    if (ring) this.#addRoom(ring, drag.erase);
  }

  #drawRoomPreview(g, pos) {
    const o = this.origin, G = this.G;
    const s = this.settings.room;
    const d = this.store?.data;
    if (!d) return;
    const toCanvas = pts => pts.flatMap(p => [p[0] + o.x, p[1] + o.y]);
    this.#drawWallOutlines(g, 0x66aaff, 0.3);
    if (s.shape === "repaint" && !this.#draft) {
      const piece = d.rooms?.length ? pieceAt(d.rooms, this.toLocal(pos)) : null;
      if (piece) g.lineStyle(3, 0x7dff8a, 0.9).beginFill(0x7dff8a, 0.15).drawPolygon(toCanvas(piece.ring)).endFill();
      return;
    }
    const cur = this.#draftPoint(pos);
    const ctrl = game.keyboard.isModifierActive("CONTROL");
    const draft = this.#draft?.tool === "room" ? this.#draft : null;
    const erase = this.#roomDrag?.erase ?? draft?.erase ?? (s.erase || game.keyboard.isModifierActive("ALT"));
    const color = erase ? 0xff5555 : 0x7dff8a;
    g.lineStyle(1, 0xffffff, 0.8).drawCircle(cur.x, cur.y, ctrl && s.shape === "poly" ? 7 : 5);
    let ring = null;
    if (this.#roomDrag) ring = this.#roomDragRing(cur);
    else if (draft) ring = outline([...draft.points, this.toLocal(cur)], [...draft.curves, ctrl], true, G / 4);
    if (ring && ring.length >= 2) g.lineStyle(2, color, 0.95).beginFill(color, 0.12).drawPolygon(toCanvas(ring)).endFill();
    if (draft) {
      g.lineStyle(0);
      draft.points.forEach((q, i) => {
        g.beginFill(draft.curves[i] ? 0x66ccff : color, 0.95).drawCircle(q[0] + o.x, q[1] + o.y, draft.curves[i] ? 6 : 4).endFill();
      });
      const first = draft.points[0];
      if (draft.points.length >= 3 && dist(this.toLocal(cur), first) < G * 0.3) {
        g.lineStyle(2, 0xffffff, 1).drawCircle(first[0] + o.x, first[1] + o.y, 10);
      }
    }
  }

  async #addRoom(ring, erase) {
    if (!this.store) return;
    const d = this.store.data;
    if (erase && !d.rooms?.length) return;
    const r8 = v => Math.round(v * 8) / 8;
    const piece = {
      id: foundry.utils.randomID(8),
      mode: erase ? "erase" : this.settings.room.mode,
      ring: ring.map(p => [r8(p[0]), r8(p[1])]),
      floor: erase ? null : (this.selection("room")[0]?.src ?? null),
      wall: this.roomWallStyle()
    };
    await this.#changeRooms(erase ? "erase room" : "room", rooms => [...rooms, piece]);
  }

  async #repaintRoom(pos) {
    const d = this.store?.data;
    const piece = d?.rooms?.length ? pieceAt(d.rooms, this.toLocal(pos)) : null;
    if (!piece) return;
    const floor = this.selection("room")[0]?.src ?? null;
    const wall = this.settings.room.repaintWalls ? this.roomWallStyle() : piece.wall;
    await this.#changeRooms("repaint room", rooms => rooms.map(p => (p.id === piece.id ? { ...p, floor, wall } : p)));
  }

  /** Change the room pieces, regenerate their walls and floors, and record one undo step. */
  async #changeRooms(label, change) {
    const store = this.store;
    if (!store) return;
    const d = store.data;
    const snap = { rooms: foundry.utils.deepClone(d.rooms ?? []), walls: foundry.utils.deepClone(d.walls.filter(w => w.room)) };
    d.rooms = change(d.rooms ?? []);
    try {
      await this.#syncRoomWalls(store);
    } catch (err) {
      console.error(err);
      ui.notifications.error(`Battlemap Editor: could not build the room walls: ${err.message}`);
    }
    store.touch();
    await this.renderer?.buildVectors();
    this.refreshVisibility();
    this.pushUndo(label, () => this.#restoreRooms(store, snap));
  }

  async #restoreRooms(store, snap) {
    const d = store.data;
    const roomIds = new Set(d.walls.filter(w => w.room).map(w => w.id));
    const ids = store.scene.walls.filter(w => roomIds.has(w.flags?.[MODULE_ID]?.wall)).map(w => w.id);
    if (ids.length) await store.scene.deleteEmbeddedDocuments("Wall", ids);
    const walls = foundry.utils.deepClone(snap.walls);
    d.rooms = foundry.utils.deepClone(snap.rooms);
    d.walls = [...d.walls.filter(w => !w.room), ...walls];
    for (const w of walls) await syncWalls(store.scene, w, { ppi: this.catalog?.ppi });
    store.touch();
    if (this.store === store) await this.renderer?.buildVectors();
  }

  /**
   * Regenerate the wall entries that come from rooms. Walls whose shape and style did not change are kept as
   * they are (with their Foundry walls and doors); doors and windows on changed walls move to the new wall
   * at the same spot.
   */
  async #syncRoomWalls(store) {
    const d = store.data, scene = store.scene, G = store.gridSize;
    const r8 = v => Math.round(v * 8) / 8;
    const sig = w => JSON.stringify([w.points.map(p => [r8(p[0]), r8(p[1])]), !!w.closed, w.src ?? null, w.type, w.width]);
    const fresh = roomWalls(d.rooms ?? []).filter(w => w.style.src || (w.style.type ?? "normal") !== "none");
    const old = d.walls.filter(w => w.room);
    const pool = new Map();
    for (const w of old) {
      const k = sig(w);
      if (!pool.has(k)) pool.set(k, []);
      pool.get(k).push(w);
    }
    const next = [], resync = new Set();
    for (const f of fresh) {
      const cand = {
        src: f.style.src ?? null, type: f.style.type ?? "normal", width: f.style.width ?? 1,
        points: f.points.map(p => [r8(p[0]), r8(p[1])]), closed: f.closed
      };
      const same = pool.get(sig(cand))?.shift();
      if (same) {
        same.room = f.piece;
        next.push(same);
        continue;
      }
      const entry = { id: foundry.utils.randomID(8), ...cand, openings: [], wallIds: [], room: f.piece };
      next.push(entry);
      resync.add(entry);
    }
    const keep = new Set(next);
    const dropped = old.filter(w => !keep.has(w));

    for (const w of dropped) {
      for (const o of w.openings ?? []) {
        const { a, b } = this.#openingEnds(w, o);
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], len = dist(a, b);
        let best = null;
        for (const e of next) {
          const pts = ringPoints(e.points, e.closed);
          const cum = cumulative(pts);
          const h = project(pts, cum, mid);
          if (h.dist < G * 0.35 && (!best || h.dist < best.h.dist)) best = { e, h, total: cum[cum.length - 1] };
        }
        if (!best) continue;  // the wall is gone (rooms merged there): so is the door
        const d0 = Math.max(0, best.h.d - len / 2), d1 = Math.min(best.total, best.h.d + len / 2);
        if (best.e.openings.some(x => d0 < Math.max(x.d0, x.d1) && d1 > Math.min(x.d0, x.d1))) continue;
        best.e.openings.push({ ...o, d0, d1 });
        resync.add(best.e);
      }
    }

    const dropIds = new Set(dropped.map(w => w.id));
    const dropDocs = new Set(dropped.flatMap(w => w.wallIds ?? []));
    const docIds = scene.walls.filter(w => dropIds.has(w.flags?.[MODULE_ID]?.wall) || dropDocs.has(w.id)).map(w => w.id);
    if (docIds.length) await scene.deleteEmbeddedDocuments("Wall", docIds);
    d.walls = [...d.walls.filter(w => !w.room), ...next];
    for (const e of resync) await syncWalls(scene, e, { ppi: this.catalog?.ppi });
  }

  /* -------------------------------------------- */
  /*  Doors and windows                           */
  /* -------------------------------------------- */

  #openingEnds(wall, opening) {
    const pts = ringPoints(wall.points, wall.closed);
    const cum = cumulative(pts);
    const at = d => {
      for (let i = 1; i < pts.length; i++) {
        if (d <= cum[i] + 1e-6) {
          const t = (d - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
          return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
        }
      }
      return pts[pts.length - 1];
    };
    return { a: at(Math.min(opening.d0, opening.d1)), b: at(Math.max(opening.d0, opening.d1)) };
  }

  /** The opening the door tool would create (or remove) at a canvas point. */
  #openingAt(pos) {
    if (!this.store) return null;
    const G = this.G;
    const q = this.toLocal(pos);
    let best = null;
    for (const wall of this.store.data.walls) {
      const pts = ringPoints(wall.points, wall.closed);
      if (pts.length < 2) continue;
      const cum = cumulative(pts);
      const hit = project(pts, cum, q);
      if (hit.dist > G * 0.6 || (best && hit.dist >= best.hit.dist)) continue;
      best = { wall, pts, cum, hit };
    }
    if (!best) return null;
    const { wall, pts, cum, hit } = best;
    const existing = wall.openings.find(o => hit.d >= Math.min(o.d0, o.d1) - 2 && hit.d <= Math.max(o.d0, o.d1) + 2);
    if (existing) return { wall, replace: existing, ...this.#openingEnds(wall, existing) };
    const width = Math.max(0.5, this.settings.door.width) * G;
    const s0 = cum[hit.seg], s1 = cum[hit.seg + 1];
    let d0, d1;
    if (s1 - s0 <= width) {
      d0 = s0;
      d1 = s1;
    } else {
      const half = G / 2;
      let c = this.settings.wall.snap ? s0 + Math.round((hit.d - s0) / half) * half : hit.d;
      c = Math.min(s1 - width / 2, Math.max(s0 + width / 2, c));
      d0 = c - width / 2;
      d1 = c + width / 2;
    }
    const overlaps = wall.openings.some(o => d0 < Math.max(o.d0, o.d1) && d1 > Math.min(o.d0, o.d1));
    if (overlaps) return null;
    const at = d => {
      const t = (d - s0) / ((s1 - s0) || 1);
      const a = pts[hit.seg], b = pts[hit.seg + 1];
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    };
    return { wall, d0, d1, a: at(d0), b: at(d1) };
  }

  async #placeOpening(pos) {
    const hit = this.#openingAt(pos);
    if (!hit) {
      if (!this.store?.data.walls.length) ui.notifications.warn("Battlemap Editor: doors go on walls drawn with the Wall tool.");
      return;
    }
    const store = this.store;
    const wall = hit.wall;
    const before = foundry.utils.deepClone(wall.openings);
    if (hit.replace) {
      wall.openings = wall.openings.filter(o => o !== hit.replace);
    } else {
      const asset = this.selection("door")[0] ?? null;
      const isWindow = !!asset && /(^|\/)Windows\//i.test(asset.rel);
      const kind = isWindow ? "window" : (this.settings.door.secret ? "secret" : "door");
      wall.openings.push({ id: foundry.utils.randomID(8), kind, d0: hit.d0, d1: hit.d1, src: asset?.src ?? null });
    }
    await syncWalls(store.scene, wall, { ppi: this.catalog?.ppi });
    store.touch();
    await this.renderer.buildVectors();
    this.#updateCursor(pos);
    this.pushUndo(hit.replace ? "remove opening" : "opening", async () => {
      wall.openings = before;
      await syncWalls(store.scene, wall, { ppi: this.catalog?.ppi });
      store.touch();
      await this.renderer?.buildVectors();
    });
  }

  /* -------------------------------------------- */
  /*  Objects                                     */
  /* -------------------------------------------- */

  rollNext() {
    const tool = this.tool === "scatter" ? "scatter" : "object";
    const s = this.settings[tool];
    const asset = this.#pickAsset(this.selectionItems(tool));
    this.#roll = {
      asset,
      rotation: s.randomRotation ? Math.floor(Math.random() * 24) * 15 : 0,
      mirror: s.randomMirror ? Math.random() < 0.5 : false,
      scale: 1 + (s.scaleJitter ? (Math.random() * 2 - 1) * s.scaleJitter : 0)
    };
  }

  #objectPoint(pos, asset) {
    const snap = this.settings.object.snap ? !game.keyboard.isModifierActive("SHIFT") : game.keyboard.isModifierActive("SHIFT");
    if (!snap) return { x: pos.x, y: pos.y };
    return snapCenter(pos, asset, this.settings.object.scale * (this.#roll?.scale ?? 1), this.catalog?.ppi);
  }

  async #placeObject(pos) {
    const roll = this.#roll;
    if (!roll?.asset) return ui.notifications.warn("Battlemap Editor: pick an object in the palette first.");
    const p = this.#objectPoint(pos, roll.asset);
    const s = this.settings.object;
    this.rollNext();
    const { tiles, lights } = await placeObjects(canvas.scene, [{
      asset: roll.asset, x: p.x, y: p.y, rotation: s.rotation + roll.rotation, scale: s.scale * roll.scale, mirror: roll.mirror
    }], { autoLight: s.autoLight, ppi: this.catalog?.ppi });
    this.#pushPlacementUndo("place object", tiles, lights);
    this.#updateCursor(canvas.mousePosition);
  }

  #pushPlacementUndo(label, tiles, lights) {
    const scene = canvas.scene;
    const tileIds = tiles.map(t => t.id), lightIds = lights.map(l => l.id);
    this.pushUndo(label, async () => {
      const t = tileIds.filter(id => scene.tiles.has(id));
      const l = lightIds.filter(id => scene.lights.has(id));
      if (t.length) await scene.deleteEmbeddedDocuments("Tile", t);
      if (l.length) await scene.deleteEmbeddedDocuments("AmbientLight", l.filter(id => scene.lights.has(id)));
    });
  }

  #beginScatter() {
    const list = this.selectionItems("scatter");
    if (!list.length) {
      ui.notifications.warn("Battlemap Editor: select one or more objects in the palette (Ctrl+click for several).");
      return;
    }
    this.#scatter = { list, placed: [], last: null, queue: [], tiles: [], lights: [], flushing: null };
  }

  #scatterAt(pos) {
    const sc = this.#scatter;
    if (!sc) return;
    const s = this.settings.scatter;
    const G = this.G;
    const r = s.radius * G;
    if (sc.last && Math.hypot(pos.x - sc.last.x, pos.y - sc.last.y) < r * 0.5) return;
    sc.last = { x: pos.x, y: pos.y };
    const area = Math.PI * s.radius * s.radius;
    const count = Math.max(1, Math.round(area * s.density * (sc.placed.length ? 0.5 : 1)));
    // Each object keeps a clearance radius: half its footprint plus half the spacing setting.
    const ppi = this.catalog?.ppi ?? 256;
    const radiusOf = (w, h) => 0.5 * Math.max(w, h) * 0.8 + (s.spacing * G) / 2;
    const existing = canvas.scene.tiles.filter(t => t.flags?.[MODULE_ID]?.editor)
      .map(t => ({ x: t.x, y: t.y, r: radiusOf(t.width, t.height) })) // v14: x/y is the (centred) anchor
      .filter(c => Math.hypot(c.x - pos.x, c.y - pos.y) < r + c.r + G * 4);
    const others = [...existing, ...sc.placed];
    let added = 0;
    for (let i = 0; i < count * 6 && added < count && sc.queue.length < 500; i++) {
      const asset = this.#pickAsset(sc.list);
      const scale = 1 + (Math.random() * 2 - 1) * (s.scaleJitter ?? 0);
      const cr = radiusOf((asset.w / ppi) * G * scale, (asset.h / ppi) * G * scale);
      const ang = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * r;
      const c = { x: pos.x + Math.cos(ang) * rr, y: pos.y + Math.sin(ang) * rr, r: cr };
      if (others.some(o => Math.hypot(o.x - c.x, o.y - c.y) < o.r + c.r)) continue;
      others.push(c);
      sc.placed.push(c);
      added++;
      sc.queue.push({
        asset, x: c.x, y: c.y, scale,
        rotation: s.randomRotation ? Math.random() * 360 : 0,
        mirror: s.randomMirror ? Math.random() < 0.5 : false
      });
    }
    this.#flushScatter();
  }

  #flushScatter() {
    const sc = this.#scatter;
    if (!sc || sc.flushing || !sc.queue.length) return sc?.flushing;
    const batch = sc.queue.splice(0);
    sc.flushing = placeObjects(canvas.scene, batch, { autoLight: this.settings.scatter.autoLight, ppi: this.catalog?.ppi })
      .then(({ tiles, lights }) => {
        sc.tiles.push(...tiles);
        sc.lights.push(...lights);
      })
      .catch(err => console.error(err))
      .finally(() => {
        sc.flushing = null;
        if (sc.queue.length) this.#flushScatter();
      });
    return sc.flushing;
  }

  async #endScatter() {
    const sc = this.#scatter;
    this.#scatter = null;
    if (!sc) return;
    while (sc.flushing || sc.queue.length) {
      if (!sc.flushing) {
        const batch = sc.queue.splice(0);
        const res = await placeObjects(canvas.scene, batch, { autoLight: this.settings.scatter.autoLight, ppi: this.catalog?.ppi });
        sc.tiles.push(...res.tiles);
        sc.lights.push(...res.lights);
      } else await sc.flushing;
    }
    if (sc.tiles.length) this.#pushPlacementUndo(`scatter (${sc.tiles.length})`, sc.tiles, sc.lights);
  }

  /* -------------------------------------------- */
  /*  Pick & delete                               */
  /* -------------------------------------------- */

  #hitTest(pos) {
    if (!this.store) return null;
    const q = this.toLocal(pos);
    const G = this.G;
    const d = this.store.data;
    let best = null;
    const consider = (hit, dd) => {
      if (!best || dd < best.dd) best = { ...hit, dd };
    };
    for (const wall of d.walls) {
      const pts = ringPoints(wall.points, wall.closed);
      if (pts.length < 2) continue;
      const cum = cumulative(pts);
      const h = project(pts, cum, q);
      if (h.dist > G * 0.4) continue;
      const opening = wall.openings.find(o => h.d >= Math.min(o.d0, o.d1) && h.d <= Math.max(o.d0, o.d1));
      if (opening) consider({ type: "opening", wall, opening }, h.dist - 1);
      else consider({ type: "wall", entry: wall }, h.dist);
    }
    for (const path of d.paths) {
      const pts = pathPoints(path, G);
      if (pts.length < 2) continue;
      const h = project(pts, cumulative(pts), q);
      const tol = Math.max(G * 0.3, (this.catalog?.get(path.src)?.h ?? 128) * artScale(G) * (path.width ?? 1) * 0.5);
      if (h.dist <= tol) consider({ type: "path", entry: path }, h.dist + 0.5);
    }
    // Thin things first: a click right on a wall or opening wins, then lights, then tiles, then the rest.
    if (best && best.type !== "path" && best.dd < G * 0.15) return best;
    const light = lightAt(pos, G * 0.3);
    if (light) return { type: "light", doc: light };
    const tile = tileAt(pos);
    if (tile) return { type: "tile", doc: tile };
    if (best) return best;
    const piece = d.rooms?.length ? pieceAt(d.rooms, q) : null;
    return piece ? { type: "room", piece } : null;
  }

  async deleteSelected() {
    const sel = this.selected;
    if (!sel || !this.store) return;
    this.selected = null;
    if (sel.doc) return this.#deleteDoc(sel.doc);
    const store = this.store;
    const d = store.data;
    const roomId = sel.type === "room" ? sel.piece.id : (sel.type === "wall" ? sel.entry.room : null);
    if (roomId) {
      await this.#changeRooms("delete room", rooms => rooms.filter(p => p.id !== roomId));
      this.palette.render();
      this.#updateCursor(canvas.mousePosition);
      return;
    }
    if (sel.type === "path") {
      const i = d.paths.indexOf(sel.entry);
      d.paths.splice(i, 1);
      this.pushUndo("delete path", async () => {
        store.data.paths.splice(i, 0, sel.entry);
        store.touch();
        await this.renderer?.buildVectors();
      });
    } else if (sel.type === "wall") {
      const i = d.walls.indexOf(sel.entry);
      d.walls.splice(i, 1);
      await removeWalls(store.scene, sel.entry);
      this.pushUndo("delete wall", async () => {
        store.data.walls.splice(i, 0, sel.entry);
        await syncWalls(store.scene, sel.entry, { ppi: this.catalog?.ppi });
        store.touch();
        await this.renderer?.buildVectors();
      });
    } else if (sel.type === "opening") {
      const wall = sel.wall;
      wall.openings = wall.openings.filter(o => o !== sel.opening);
      await syncWalls(store.scene, wall, { ppi: this.catalog?.ppi });
      this.pushUndo("delete opening", async () => {
        wall.openings.push(sel.opening);
        await syncWalls(store.scene, wall, { ppi: this.catalog?.ppi });
        store.touch();
        await this.renderer?.buildVectors();
      });
    }
    store.touch();
    await this.renderer.buildVectors();
    this.palette.render();
    this.#updateCursor(canvas.mousePosition);
  }

  /* -------------------------------------------- */
  /*  Tiles & lights                              */
  /* -------------------------------------------- */

  #beginMove(event) {
    const doc = this.selectedDoc;
    if (!doc) return;
    const origin = event.interactionData?.origin ?? canvas.mousePosition;
    const isTile = doc.documentName === "Tile";
    const lights = isTile ? linkedLights(doc).map(l => ({ doc: l, x: l.x, y: l.y })) : [];
    this.#move = { doc, isTile, origin: { x: origin.x, y: origin.y }, from: { x: doc.x, y: doc.y }, to: { x: doc.x, y: doc.y }, lights };
    const mesh = isTile ? doc.object?.mesh : null;
    if (mesh) {
      this.#move.meshAlpha = mesh.alpha;
      mesh.alpha = 0.25;
      const ghost = this.ghost;
      this.#ghostSrc = null;  // the object tool reloads its own texture
      ghost.texture = mesh.texture ?? PIXI.Texture.EMPTY;
      ghost.anchor.set(doc.texture.anchorX ?? 0.5, doc.texture.anchorY ?? 0.5);
      ghost.scale.set(1);
      ghost.width = doc.width;
      ghost.height = doc.height;
      if ((doc.texture.scaleX ?? 1) < 0) ghost.scale.x = -Math.abs(ghost.scale.x);
      if ((doc.texture.scaleY ?? 1) < 0) ghost.scale.y = -Math.abs(ghost.scale.y);
      ghost.angle = doc.rotation ?? 0;
    }
  }

  #moveTo(pos, event) {
    const m = this.#move;
    let p = { x: m.from.x + pos.x - m.origin.x, y: m.from.y + pos.y - m.origin.y };
    const shift = event?.shiftKey ?? game.keyboard.isModifierActive("SHIFT");
    if (m.isTile) {
      // Same snapping as the object tool: odd footprints centre on a square, even ones on a grid line.
      const centred = (m.doc.texture.anchorX ?? 0.5) === 0.5 && (m.doc.texture.anchorY ?? 0.5) === 0.5;
      const wantSnap = this.settings.object.snap ? !shift : shift;
      if (wantSnap && centred) p = snapCenter(p, { w: m.doc.width, h: m.doc.height }, 1, this.G);
    } else if (shift) p = this.#snap(p, "any");
    m.to = { x: Math.round(p.x), y: Math.round(p.y) };
  }

  #drawMove(g, accent) {
    const m = this.#move;
    const G = this.G;
    const dx = m.to.x - m.from.x, dy = m.to.y - m.from.y;
    if (m.isTile) {
      this.ghost.position.set(m.to.x, m.to.y);
      this.ghost.visible = true;
      const d = m.doc;
      const c = tileCorners({ x: m.to.x, y: m.to.y, width: d.width, height: d.height, rotation: d.rotation, texture: d.texture });
      g.lineStyle(2, accent, 1).drawPolygon(c.flat());
    } else g.lineStyle(3, accent, 1).drawCircle(m.to.x, m.to.y, G * 0.22);
    for (const l of m.lights) g.lineStyle(2, 0xffd25a, 1).drawCircle(l.x + dx, l.y + dy, G * 0.22);
  }

  async #endMove(commit) {
    const m = this.#move;
    this.#move = null;
    this.ghost.visible = false;
    const mesh = m.isTile ? m.doc.object?.mesh : null;
    if (mesh && !mesh.destroyed && m.meshAlpha !== undefined) mesh.alpha = m.meshAlpha;
    const dx = m.to.x - m.from.x, dy = m.to.y - m.from.y;
    if (!commit || (!dx && !dy) || !isAlive(m.doc)) return this.#updateCursor(canvas.mousePosition);
    const scene = m.doc.parent;
    const type = m.doc.documentName;
    const id = m.doc.id;
    try {
      await scene.updateEmbeddedDocuments(type, [{ _id: id, x: m.to.x, y: m.to.y }]);
      if (m.lights.length) await scene.updateEmbeddedDocuments("AmbientLight", m.lights.map(l => ({ _id: l.doc.id, x: l.x + dx, y: l.y + dy })));
    } catch (err) {
      console.error(err);
      ui.notifications.error(`Battlemap Editor: move failed: ${err.message}`);
      return;
    }
    this.pushUndo(`move ${m.isTile ? "tile" : "light"}`, async () => {
      if (scene.getEmbeddedDocument(type, id)) await scene.updateEmbeddedDocuments(type, [{ _id: id, x: m.from.x, y: m.from.y }]);
      const back = m.lights.filter(l => scene.lights.has(l.doc.id)).map(l => ({ _id: l.doc.id, x: l.x, y: l.y }));
      if (back.length) await scene.updateEmbeddedDocuments("AmbientLight", back);
    });
    this.#updateCursor(canvas.mousePosition);
  }

  /** Rotate or scale the selected tile around its anchor. Wheel ticks within 1.5 s share one undo step. */
  async #transformSelected({ rotate = 0, scale = 1 }) {
    const doc = this.selectedDoc;
    if (doc?.documentName !== "Tile") return;
    const scene = doc.parent, id = doc.id;
    const change = { _id: id };
    if (rotate) change.rotation = (((doc.rotation + rotate) % 360) + 360) % 360;
    if (scale !== 1) {
      change.width = Math.max(8, Math.round(doc.width * scale));
      change.height = Math.max(8, Math.round(doc.height * scale));
    }
    const now = Date.now();
    const w = this.#wheelUndo;
    if (w && w.id === id && now - w.at < 1500 && this.undoStack.at(-1) === w.entry) w.at = now;
    else {
      const before = { rotation: doc.rotation, width: doc.width, height: doc.height };
      this.pushUndo("rotate/scale tile", async () => {
        if (scene.tiles.has(id)) await scene.updateEmbeddedDocuments("Tile", [{ _id: id, ...before }]);
      });
      this.#wheelUndo = { id, at: now, entry: this.undoStack.at(-1) };
    }
    await scene.updateEmbeddedDocuments("Tile", [change]);
    this.#updateCursor(canvas.mousePosition);
  }

  /** Palette actions on the selected tile or light. */
  async editSelected(action) {
    const doc = this.selectedDoc;
    if (!doc) return;
    const scene = doc.parent, id = doc.id, type = doc.documentName;
    if (action === "configure") return doc.sheet?.render({ force: true });
    if (action === "delete") return this.deleteSelected();
    let change, before;
    if (action === "mirror") {
      before = { "texture.scaleX": doc.texture.scaleX };
      change = { "texture.scaleX": -(doc.texture.scaleX ?? 1) };
    } else if (action === "front" || action === "back") {
      const sorts = scene.tiles.map(t => t.sort ?? 0);
      before = { sort: doc.sort };
      change = { sort: action === "front" ? Math.max(...sorts) + 1 : Math.min(...sorts) - 1 };
    } else if (action === "hide") {
      before = { hidden: doc.hidden };
      change = { hidden: !doc.hidden };
    } else return;
    await scene.updateEmbeddedDocuments(type, [{ _id: id, ...change }]);
    this.pushUndo(`${action} ${type === "Tile" ? "tile" : "light"}`, async () => {
      if (scene.getEmbeddedDocument(type, id)) await scene.updateEmbeddedDocuments(type, [{ _id: id, ...before }]);
    });
    this.palette.render();
    this.#updateCursor(canvas.mousePosition);
  }

  /** The editor path selected with the Select tool, if it still exists. */
  get selectedPath() {
    const sel = this.selected;
    return sel?.type === "path" && this.store?.data.paths.includes(sel.entry) ? sel.entry : null;
  }

  #pathEdit = null;

  /**
   * Palette actions on the selected path.
   * "mirror" flips the art to the other side, "reseed" rolls new noise, "rough" sets the roughness live:
   * slider moves preview immediately and become one undo step when the slider is released (final = true).
   */
  async editPath(action, value, { final = true } = {}) {
    const entry = this.selectedPath;
    if (!entry) return;
    const store = this.store;
    const keys = { mirror: "flip", reseed: "seed", rough: "rough", width: "width" };
    const key = keys[action];
    if (!key) return;
    if (!this.#pathEdit || this.#pathEdit.entry !== entry || this.#pathEdit.key !== key) {
      this.#pathEdit = { entry, key, before: entry[key] };
    }
    if (action === "mirror") entry.flip = !entry.flip;
    else if (action === "reseed") entry.seed = Math.floor(Math.random() * 2 ** 31);
    else entry[key] = value;
    await this.renderer?.buildVectors();
    this.#updateCursor(canvas.mousePosition);
    if (!final) return;
    const { before } = this.#pathEdit;
    this.#pathEdit = null;
    const after = entry[key];
    if (before === after) return;
    store.touch();
    this.pushUndo(action === "mirror" ? "mirror path" : `path ${key}`, async () => {
      entry[key] = before;
      store.touch();
      await this.renderer?.buildVectors();
      if (this.selectedPath === entry) this.palette.render();
    });
    if (action !== "rough" && action !== "width") this.palette.render();
  }

  async #deleteDoc(doc) {
    const scene = doc.parent;
    const type = doc.documentName;
    const data = doc.toObject();
    const lights = type === "Tile" ? linkedLights(doc).map(l => l.toObject()) : [];
    await scene.deleteEmbeddedDocuments(type, [doc.id]);  // the deleteTile hook removes linked lights
    this.pushUndo(`delete ${type === "Tile" ? "tile" : "light"}`, async () => {
      await scene.createEmbeddedDocuments(type, [data], { keepId: true });
      const missing = lights.filter(l => !scene.lights.has(l._id));
      if (missing.length) await scene.createEmbeddedDocuments("AmbientLight", missing, { keepId: true });
    });
    this.palette.render();
    this.#updateCursor(canvas.mousePosition);
  }

  /* -------------------------------------------- */
  /*  Bake & clear                                */
  /* -------------------------------------------- */

  async promptBake() {
    if (!this.store) return;
    if (this.store.isEmpty) return ui.notifications.warn("Battlemap Editor: nothing to bake yet.");
    const editorTiles = canvas.scene.tiles.filter(t => t.flags?.[MODULE_ID]?.editor).length;
    const result = await foundry.applications.api.DialogV2.input({
      window: { title: "Bake battlemap", icon: "fa-solid fa-image" },
      content: `
        <p>Renders terrain, paths and wall art into one image and makes it this level's background.
        Players see the map after baking. You can keep editing and bake again.</p>
        <div class="form-group">
          <label>Flatten objects</label>
          <div class="form-fields"><input type="checkbox" name="flatten"></div>
          <p class="hint">Also paint the ${editorTiles} object tile(s) placed with the editor into the image and delete
          the tiles. Faster for players, but the objects can no longer be moved. Lights stay.</p>
        </div>
        <div class="form-group">
          <label>Quality</label>
          <div class="form-fields"><input type="number" name="quality" value="0.9" min="0.5" max="1" step="0.05"></div>
        </div>`,
      ok: { label: "Bake", icon: "fa-solid fa-image" },
      rejectClose: false
    });
    if (!result) return;
    try {
      await bakeMap(this, { flatten: !!result.flatten, quality: Number(result.quality) || 0.9 });
      this.refreshVisibility();
    } catch (err) {
      console.error(err);
      ui.notifications.error(`Battlemap Editor: bake failed: ${err.message}`);
    }
  }

  async promptClear() {
    if (!this.store) return;
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Clear battlemap", icon: "fa-solid fa-trash" },
      content: `<p>Remove all painted terrain, rooms, paths, wall art and the Foundry walls the editor created on this scene?</p>
        <p>Object tiles, lights and the baked background stay. This cannot be undone.</p>`,
      rejectClose: false
    });
    if (!ok) return;
    const store = this.store;
    const ids = store.scene.walls.filter(w => w.flags?.[MODULE_ID]?.wall).map(w => w.id);
    if (ids.length) await store.scene.deleteEmbeddedDocuments("Wall", ids);
    Object.assign(store.data, { base: null, layers: [], paths: [], walls: [], rooms: [] });
    store.masks.clear();
    this.undoStack = [];
    await store.save();
    await this.renderer.build();
    this.refreshVisibility();
    this.palette.render();
  }

  /** Turn objects that were flattened into the bake back into tiles. */
  async unflatten() {
    const store = this.store;
    const items = store?.data.flattened ?? [];
    if (!items.length) return;
    await canvas.scene.createEmbeddedDocuments("Tile", items);
    store.data.flattened = [];
    store.touch();
    await this.renderer.buildFlat();
    this.refreshVisibility();
    this.palette.render();
    ui.notifications.info(`Battlemap Editor: ${items.length} objects restored as tiles. Bake again to remove them from the image.`);
  }

  /** Make sure the current underlay is captured before painting over an existing background. */
  captureUnderlay() {
    if (!this.store || this.store.data.base || this.store.data.underlay) return;
    const src = currentUnderlay(this.store);
    if (src) this.store.data.underlay = src;
  }
}
