import { TOOL_KINDS, WALL_TYPES } from "./constants.js";
import { EditorCatalog } from "./catalog.js";
import { describe } from "./placeables.js";

const CELL = 76;
const esc = s => foundry.utils.escapeHTML(String(s ?? ""));

const TOOL_INFO = {
  terrain: {
    title: "Paint terrain", icon: "fa-solid fa-paintbrush",
    hint: "The first texture you click fills the map. Then drag to paint others on top. Alt-drag erases back to the base. Ctrl/Shift+wheel changes brush size."
  },
  path: {
    title: "Paths", icon: "fa-solid fa-route",
    hint: "Click to add points; double-click, right-click or Enter finishes. Backspace removes the last point, Esc cancels. Good for roads, rivers, cliffs and fences."
  },
  wall: {
    title: "Walls", icon: "fa-solid fa-block-brick",
    hint: "Click points on the grid (Shift: free). Click the first point to close a room. Creates Foundry walls along the art. With no art selected, only Foundry walls are made."
  },
  door: {
    title: "Doors & windows", icon: "fa-solid fa-door-open",
    hint: "Hover an editor wall and click to cut a door (opens with the selected art) or a window (from Windows/). Click an existing opening to remove it."
  },
  object: {
    title: "Objects", icon: "fa-solid fa-chess-rook",
    hint: "Click to place a tile. Shift+wheel rotates, Ctrl+wheel scales. Ctrl+click several assets to place random variants. Light sources get a matching light."
  },
  scatter: {
    title: "Scatter", icon: "fa-solid fa-seedling",
    hint: "Drag to sprinkle the selected objects (Ctrl+click several). Each stroke is one undo step."
  },
  pick: {
    title: "Select", icon: "fa-solid fa-arrow-pointer",
    hint: "Click a path, wall, opening, tile or light (yellow dots) to select it. Drag tiles and lights to move them; Delete removes; Ctrl+Z undoes."
  }
};

/** Option controls per tool: [settings path, label, type, extra]. */
const OPTIONS = {
  terrain: [
    ["brush.size", "Brush size (squares)", "range", { min: 0.25, max: 30, step: 0.25 }],
    ["brush.hardness", "Hardness", "range", { min: 0, max: 1, step: 0.05 }],
    ["brush.opacity", "Opacity", "range", { min: 0.05, max: 1, step: 0.05 }],
    ["brush.erase", "Erase", "checkbox"]
  ],
  path: [
    ["path.width", "Thickness", "range", { min: 0.25, max: 4, step: 0.05 }],
    ["path.smooth", "Smooth curve", "checkbox"],
    ["path.flip", "Flip side", "checkbox"],
    ["path.snap", "Snap to grid", "checkbox"]
  ],
  wall: [
    ["wall.type", "Foundry walls", "select", { choices: WALL_TYPES }],
    ["wall.width", "Thickness", "range", { min: 0.25, max: 3, step: 0.05 }],
    ["wall.snap", "Snap to grid", "checkbox"]
  ],
  door: [
    ["door.width", "Width (squares)", "range", { min: 0.5, max: 4, step: 0.5 }],
    ["door.secret", "Secret door", "checkbox"]
  ],
  object: [
    ["object.rotation", "Rotation", "range", { min: 0, max: 345, step: 15 }],
    ["object.scale", "Scale", "range", { min: 0.1, max: 4, step: 0.05 }],
    ["object.scaleJitter", "Random scale ±", "range", { min: 0, max: 0.5, step: 0.05 }],
    ["object.randomRotation", "Random rotation", "checkbox"],
    ["object.randomMirror", "Random mirror", "checkbox"],
    ["object.snap", "Snap to grid", "checkbox"],
    ["object.autoLight", "Lights for light sources", "checkbox"]
  ],
  scatter: [
    ["scatter.radius", "Radius (squares)", "range", { min: 0.5, max: 15, step: 0.25 }],
    ["scatter.density", "Density (per square)", "range", { min: 0.05, max: 3, step: 0.05 }],
    ["scatter.spacing", "Extra spacing (squares)", "range", { min: 0, max: 4, step: 0.1 }],
    ["scatter.scaleJitter", "Random scale ±", "range", { min: 0, max: 0.5, step: 0.05 }],
    ["scatter.randomRotation", "Random rotation", "checkbox"],
    ["scatter.randomMirror", "Random mirror", "checkbox"],
    ["scatter.autoLight", "Lights for light sources", "checkbox"]
  ],
  pick: []
};

const MULTI = new Set(["object", "scatter"]);

/**
 * The editor palette: tool options and an asset browser with virtual scrolling.
 */
export class BattlemapPalette extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "bme-palette",
    classes: ["bme-palette"],
    window: { title: "Battlemap Editor", icon: "fa-solid fa-map-location-dot", resizable: true, minimizable: true },
    position: { width: 380, height: 720, top: 70, left: 110 }
  };

  /** @param {import("./layer.js").BattlemapLayer} layer */
  constructor(layer) {
    super();
    this.layer = layer;
    /** @type {Record<string, {folder: string, query: string, scroll: number}>} */
    this.filters = {};
    this.#items = [];
    this.#folderCache = new Map();
  }

  #items;
  #folderCache;
  #grid = null;
  #renderToken = 0;
  #resizeObserver = null;

  get tool() {
    return this.layer.tool;
  }

  filterFor(tool) {
    return (this.filters[tool] ??= { folder: "", query: "", scroll: 0 });
  }

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */

  /** @override */
  async _renderHTML(_context, _options) {
    const tool = this.tool;
    const info = TOOL_INFO[tool] ?? { title: tool, icon: "", hint: "" };
    const el = document.createElement("div");
    el.className = "bme-root";
    el.innerHTML = `
      <header class="bme-tool">
        <h3><i class="${info.icon}"></i> ${esc(info.title)}</h3>
        <p class="hint">${esc(info.hint)}</p>
      </header>
      <form class="bme-options" autocomplete="off">${this.#optionsHTML(tool)}</form>
      ${this.#extrasHTML(tool)}
      ${TOOL_KINDS[tool]?.length ? `
      <section class="bme-selected"></section>
      <section class="bme-browser">
        <div class="bme-filters">
          <select name="folder" class="bme-folder"><option value="">All folders</option></select>
          <input type="search" name="query" class="bme-query" placeholder="Search names and tags…">
        </div>
        <div class="bme-grid"><div class="bme-spacer"></div></div>
        <footer class="bme-count"></footer>
      </section>` : ""}`;
    return el;
  }

  /** @override */
  _replaceHTML(result, content, _options) {
    content.replaceChildren(result);
  }

  /** @override */
  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#grid = null;
    const root = this.element;
    root.querySelector(".bme-options")?.addEventListener("input", ev => this.#onOption(ev));
    root.querySelector(".bme-options")?.addEventListener("change", ev => this.#onOption(ev));
    root.querySelectorAll("[data-action-bme]").forEach(b => b.addEventListener("click", ev => this.#onAction(ev)));
    if (TOOL_KINDS[this.tool]?.length) await this.#initBrowser();
  }

  #optionsHTML(tool) {
    const s = this.layer.settings;
    return (OPTIONS[tool] ?? []).map(([path, label, type, extra = {}]) => {
      const value = foundry.utils.getProperty(s, path);
      let input;
      if (type === "checkbox") input = `<input type="checkbox" name="${path}" ${value ? "checked" : ""}>`;
      else if (type === "select") {
        input = `<select name="${path}">${Object.entries(extra.choices).map(([k, v]) =>
          `<option value="${k}" ${k === value ? "selected" : ""}>${esc(v)}</option>`).join("")}</select>`;
      } else {
        input = `<input type="range" name="${path}" value="${value}" min="${extra.min}" max="${extra.max}" step="${extra.step}">
          <output>${value}</output>`;
      }
      return `<div class="form-group bme-opt"><label>${esc(label)}</label><div class="form-fields">${input}</div></div>`;
    }).join("");
  }

  #extrasHTML(tool) {
    const store = this.layer.store;
    if (!store) return `<p class="notification warning">Open a scene to use the editor.</p>`;
    const cat = EditorCatalog.current;
    const nameOf = src => esc(cat?.get(src)?.name ?? src?.split("/").pop() ?? "");
    const thumbOf = src => esc(cat?.get(src)?.thumb ?? src);
    if (tool === "terrain") {
      const d = store.data;
      const layers = [...d.layers].reverse().map(l => `
        <li class="bme-layer">
          <img src="${thumbOf(l.src)}" alt=""><span>${nameOf(l.src)}</span>
          <a data-action-bme="layer-up" data-id="${l.id}" data-tooltip="Move up"><i class="fa-solid fa-arrow-up"></i></a>
          <a data-action-bme="layer-down" data-id="${l.id}" data-tooltip="Move down"><i class="fa-solid fa-arrow-down"></i></a>
          <a data-action-bme="layer-remove" data-id="${l.id}" data-tooltip="Remove"><i class="fa-solid fa-xmark"></i></a>
        </li>`).join("");
      const base = d.base ? `<li class="bme-layer bme-base"><img src="${thumbOf(d.base.src)}" alt=""><span>${nameOf(d.base.src)}</span><em>base</em></li>`
        : `<li class="bme-layer bme-base"><span>${d.underlay ? "Existing background" : "No base yet: click a texture, then click the map"}</span><em>base</em></li>`;
      return `
        <section class="bme-extras">
          <div class="bme-row">
            <button type="button" data-action-bme="fill"><i class="fa-solid fa-fill-drip"></i> Fill map with selected</button>
          </div>
          <ul class="bme-layers">${layers}${base}</ul>
        </section>`;
    }
    if (tool === "pick") {
      const sel = this.layer.selected;
      const d = store.data;
      let selHTML = `<p class="hint">Nothing selected.</p>`;
      const doc = this.layer.selectedDoc;
      if (doc) {
        const isTile = doc.documentName === "Tile";
        const btn = (action, icon, label) => `<button type="button" data-action-bme="doc-${action}"><i class="fa-solid ${icon}"></i> ${label}</button>`;
        selHTML = `<div class="bme-row"><strong>${isTile ? "Tile" : "Light"}:</strong> ${esc(describe(doc))}${doc.hidden ? " <em>(hidden)</em>" : ""}</div>
          <div class="bme-row bme-buttons">
            ${btn("configure", "fa-gear", "Configure")}
            ${isTile ? btn("mirror", "fa-left-right", "Mirror") + btn("front", "fa-arrow-up-wide-short", "To front") + btn("back", "fa-arrow-down-short-wide", "To back") : ""}
            ${btn("hide", doc.hidden ? "fa-eye" : "fa-eye-slash", doc.hidden ? "Show" : "Hide")}
            ${btn("delete", "fa-trash", "Delete")}
          </div>
          <p class="hint">Drag to move${isTile ? " (Shift toggles snapping, linked lights follow). Shift+wheel rotates, Ctrl+wheel scales" : " (Shift snaps)"}. Double-click opens the full settings.</p>`;
      } else if (sel) {
        const label = sel.type === "opening" ? `${sel.opening.kind} on a wall` : sel.type;
        const art = sel.type === "opening" ? sel.opening.src : sel.entry.src;
        selHTML = `<div class="bme-row"><strong>Selected:</strong> ${esc(label)} ${art ? `(${nameOf(art)})` : ""}
          <button type="button" data-action-bme="delete"><i class="fa-solid fa-trash"></i> Delete</button></div>`;
      }
      return `<section class="bme-extras">${selHTML}
        <p class="hint">This map: ${d.layers.length} painted textures, ${d.paths.length} paths, ${d.walls.length} walls,
        ${d.walls.reduce((n, w) => n + w.openings.length, 0)} openings.
        ${d.dirty ? "<strong>Not baked yet.</strong>" : (d.baked ? "Baked." : "")}</p>
        ${d.flattened?.length ? `<div class="bme-row"><button type="button" data-action-bme="unflatten">
          <i class="fa-solid fa-layer-group"></i> Restore ${d.flattened.length} flattened objects as tiles</button></div>` : ""}
        </section>`;
    }
    if (tool === "wall" || tool === "door") {
      return `<section class="bme-extras"><div class="bme-row">
        <button type="button" data-action-bme="clear-selection"><i class="fa-solid fa-ban"></i> ${tool === "wall" ? "No art (Foundry walls only)" : "Plain door (no art)"}</button>
      </div></section>`;
    }
    return "";
  }

  /** Update option inputs to match the settings (after wheel changes). */
  refreshOptions() {
    if (!this.rendered) return;
    for (const input of this.element.querySelectorAll(".bme-options [name]")) {
      const v = foundry.utils.getProperty(this.layer.settings, input.name);
      if (input.type === "checkbox") input.checked = !!v;
      else input.value = v;
      const out = input.parentElement.querySelector("output");
      if (out) out.textContent = v;
    }
  }

  #onOption(ev) {
    const input = ev.target;
    if (!input?.name) return;
    let value;
    if (input.type === "checkbox") value = input.checked;
    else if (input.type === "range" || input.type === "number") value = Number(input.value);
    else value = input.value;
    foundry.utils.setProperty(this.layer.settings, input.name, value);
    const out = input.parentElement.querySelector("output");
    if (out) out.textContent = value;
    this.layer.saveSettings();
    if (/^(object|scatter)\./.test(input.name)) this.layer.rollNext();
  }

  #onAction(ev) {
    ev.preventDefault();
    const a = ev.currentTarget;
    const id = a.dataset.id;
    switch (a.dataset.actionBme) {
      case "fill": return this.layer.fillBase();
      case "layer-up": return this.layer.moveLayer(id, 1);
      case "layer-down": return this.layer.moveLayer(id, -1);
      case "layer-remove": return this.layer.removeLayer(id);
      case "delete": return this.layer.deleteSelected();
      case "unflatten": return this.layer.unflatten();
      case "doc-configure": case "doc-mirror": case "doc-front": case "doc-back": case "doc-hide": case "doc-delete":
        return this.layer.editSelected(a.dataset.actionBme.slice(4));
      case "clear-selection":
        this.layer.setSelection(this.tool, []);
        return this.#renderSelected();
    }
  }

  /* -------------------------------------------- */
  /*  Asset browser                               */
  /* -------------------------------------------- */

  async #initBrowser() {
    const token = ++this.#renderToken;
    const tool = this.tool;
    const root = this.element;
    const grid = root.querySelector(".bme-grid");
    const count = root.querySelector(".bme-count");
    const folderSel = root.querySelector(".bme-folder");
    const query = root.querySelector(".bme-query");
    const f = this.filterFor(tool);
    query.value = f.query;

    let cat;
    try {
      cat = await EditorCatalog.load();
      if (TOOL_KINDS[tool].includes("object") && !cat.kinds.object) {
        count.textContent = "Loading 170,000 objects…";
        await cat.ensureObjects();
        this.layer.rollNext();
      }
    } catch (err) {
      count.textContent = err.message;
      return;
    }
    if (token !== this.#renderToken || !this.rendered) return;

    const all = cat.list(TOOL_KINDS[tool]);
    const key = TOOL_KINDS[tool].join(",");
    if (!this.#folderCache.has(key)) this.#folderCache.set(key, EditorCatalog.folders(all));
    const folders = this.#folderCache.get(key);
    folderSel.insertAdjacentHTML("beforeend", folders.map(fo => {
      const depth = fo.split("/").length - 1;
      return `<option value="${esc(fo)}" ${fo === f.folder ? "selected" : ""}>${"  ".repeat(depth)}${esc(fo.split("/").pop().replace(/_/g, " "))}</option>`;
    }).join(""));

    const apply = () => {
      this.#items = EditorCatalog.filter(all, f);
      count.textContent = `${this.#items.length.toLocaleString()} of ${all.length.toLocaleString()} assets`;
      this.#layoutGrid();
    };
    folderSel.addEventListener("change", () => {
      f.folder = folderSel.value;
      grid.scrollTop = 0;
      apply();
    });
    query.addEventListener("input", foundry.utils.debounce(() => {
      f.query = query.value;
      grid.scrollTop = 0;
      apply();
    }, 200));
    grid.addEventListener("scroll", () => {
      f.scroll = grid.scrollTop;
      this.#drawGrid();
    });
    grid.addEventListener("click", ev => this.#onCellClick(ev));
    this.#grid = { el: grid, spacer: grid.querySelector(".bme-spacer"), drawn: new Map(), cols: 1 };
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = new ResizeObserver(() => this.#layoutGrid());
    this.#resizeObserver.observe(grid);
    apply();
    grid.scrollTop = f.scroll;
    this.#renderSelected();
  }

  #layoutGrid() {
    const g = this.#grid;
    if (!g) return;
    g.cols = Math.max(1, Math.floor((g.el.clientWidth - 4) / CELL));
    g.spacer.style.height = `${Math.ceil(this.#items.length / g.cols) * CELL}px`;
    for (const node of g.drawn.values()) node.remove();
    g.drawn.clear();
    this.#drawGrid();
  }

  #drawGrid() {
    const g = this.#grid;
    if (!g) return;
    const top = g.el.scrollTop, h = g.el.clientHeight;
    const first = Math.max(0, Math.floor(top / CELL) - 2) * g.cols;
    const last = Math.min(this.#items.length, (Math.ceil((top + h) / CELL) + 2) * g.cols);
    const selected = new Set(this.layer.settings.selection[this.tool] ?? []);
    for (const [i, node] of g.drawn) {
      if (i < first || i >= last) {
        node.remove();
        g.drawn.delete(i);
      }
    }
    const ppi = EditorCatalog.current?.ppi ?? 256;
    for (let i = first; i < last; i++) {
      if (g.drawn.has(i)) continue;
      const a = this.#items[i];
      const cell = document.createElement("div");
      cell.className = `bme-cell${selected.has(a.src) ? " selected" : ""}`;
      cell.dataset.index = String(i);
      cell.style.transform = `translate(${(i % g.cols) * CELL}px, ${Math.floor(i / g.cols) * CELL}px)`;
      const size = a.w && a.h ? ` · ${+(a.w / ppi).toFixed(1)}×${+(a.h / ppi).toFixed(1)}` : "";
      cell.dataset.tooltipHtml = `${esc(a.name.replace(/_/g, " "))}${size}<br><small>${esc(a.folder)}</small>`;
      cell.innerHTML = `<img src="${esc(a.thumb)}" loading="lazy" decoding="async" alt="">`;
      g.spacer.appendChild(cell);
      g.drawn.set(i, cell);
    }
  }

  #onCellClick(ev) {
    const cell = ev.target.closest(".bme-cell");
    if (!cell) return;
    const a = this.#items[Number(cell.dataset.index)];
    if (!a) return;
    const tool = this.tool;
    let sel = [...(this.layer.settings.selection[tool] ?? [])];
    if (MULTI.has(tool) && (ev.ctrlKey || ev.metaKey)) {
      sel = sel.includes(a.src) ? sel.filter(s => s !== a.src) : [...sel, a.src];
    } else if (MULTI.has(tool) && ev.shiftKey && sel.length) {
      const lastIdx = this.#items.findIndex(x => x.src === sel[sel.length - 1]);
      const i = Number(cell.dataset.index);
      if (lastIdx >= 0) {
        const [lo, hi] = [Math.min(lastIdx, i), Math.max(lastIdx, i)];
        for (let k = lo; k <= hi && sel.length < 200; k++) if (!sel.includes(this.#items[k].src)) sel.push(this.#items[k].src);
      }
    } else {
      sel = [a.src];
    }
    this.layer.setSelection(tool, sel);
    for (const node of this.#grid.drawn.values()) {
      const it = this.#items[Number(node.dataset.index)];
      node.classList.toggle("selected", sel.includes(it?.src));
    }
    this.#renderSelected();
  }

  #renderSelected() {
    const box = this.element?.querySelector(".bme-selected");
    if (!box) return;
    const assets = this.layer.selection(this.tool);
    if (!assets.length) {
      box.innerHTML = `<span class="hint">Nothing selected${MULTI.has(this.tool) ? " (Ctrl+click for several)" : ""}.</span>`;
      return;
    }
    const shown = assets.slice(0, 10).map(a => `<img src="${esc(a.thumb)}" data-tooltip="${esc(a.name.replace(/_/g, " "))}" alt="">`).join("");
    const more = assets.length > 10 ? `<span>+${assets.length - 10}</span>` : "";
    box.innerHTML = `${shown}${more}<span class="bme-selname">${assets.length === 1 ? esc(assets[0].name.replace(/_/g, " ")) : `${assets.length} selected`}</span>`;
  }

  /** @override */
  _onClose(options) {
    super._onClose?.(options);
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    this.#grid = null;
  }
}
