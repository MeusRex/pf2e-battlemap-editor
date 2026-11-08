import { MODULE_ID } from "./constants.js";

/**
 * @typedef {object} Asset
 * @property {string} id      unique key: "<pack>/<rel>"
 * @property {string} kind    terrain | wall | path | portal | object | light | tileset
 * @property {string} src     URL usable as a Foundry texture src
 * @property {string} thumb   URL of a small preview (falls back to src)
 * @property {string} rel     path after "textures/<kind folder>/"
 * @property {string} folder  directory after "textures/", including the kind folder (e.g. "walls/Walls_Stone")
 * @property {string} name    file name without extension
 * @property {number} w       pixel width (256 px per grid square)
 * @property {number} h       pixel height
 * @property {string[]} tags
 * @property {string} search  lower-case haystack for text search
 */

const KIND_FOLDERS = {
  terrain: "terrain", wall: "walls", path: "paths", portal: "portals",
  object: "objects", light: "lights", tileset: "tilesets", pattern: "patterns"
};

function root() {
  return game.settings.get(MODULE_ID, "assetRoot").replace(/\/+$/, "");
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) {
    throw new Error(`Battlemap Editor: "${url}" not found (HTTP ${res.status}). Run tools/extract_fa_packs.py `
      + "and check the 'Asset folder' module setting.");
  }
  return res.json();
}

function buildAssets(kind, entries, data, base) {
  const folderName = KIND_FOLDERS[kind];
  return entries.map(([pack, rel, w, h, tagIds, thumb]) => {
    const packId = data.packs[pack];
    const slash = rel.lastIndexOf("/");
    const file = rel.slice(slash + 1);
    const inKind = rel.startsWith(`${folderName}/`) ? rel.slice(folderName.length + 1) : rel;
    const name = file.replace(/\.[^.]+$/, "");
    const tags = Array.isArray(tagIds) ? tagIds.map(i => data.tags[i]) : [];
    const src = `${base}/${packId}/textures/${rel}`;
    return {
      id: `${packId}/${rel}`,
      kind, src,
      thumb: thumb ? `${base}/${packId}/thumbs/${rel.replace(/\.[^.]+$/, ".png")}` : src,
      rel: inKind,
      folder: slash > 0 ? rel.slice(0, slash) : "",
      name, w, h, tags,
      search: `${inKind} ${tags.join(" ")}`.toLowerCase().replace(/_/g, " ")
    };
  });
}

export class EditorCatalog {
  static #index = null;
  static #indexLoading = null;
  static #objectsLoading = null;

  /** @type {Record<string, Asset[]>} */
  kinds = {};
  /** @type {Map<string, Asset>} */
  bySrc = new Map();
  ppi = 256;

  /** The loaded catalog, or null before {@link EditorCatalog.load} finished. */
  static get current() {
    return this.#index;
  }

  /** Load the small index (everything but objects). */
  static async load({ force = false } = {}) {
    if (this.#index && !force) return this.#index;
    if (this.#indexLoading && !force) return this.#indexLoading;
    this.#indexLoading = (async () => {
      const base = root();
      const data = await fetchJson(`${base}/bme-index.json`);
      const cat = new EditorCatalog();
      cat.ppi = data.ppi ?? 256;
      for (const [kind, entries] of Object.entries(data.kinds ?? {})) cat.#add(kind, buildAssets(kind, entries, data, base));
      this.#index = cat;
      this.#objectsLoading = null;
      console.log(`${MODULE_ID} | catalog loaded`, Object.fromEntries(Object.entries(cat.kinds).map(([k, v]) => [k, v.length])));
      return cat;
    })();
    try {
      return await this.#indexLoading;
    } finally {
      this.#indexLoading = null;
    }
  }

  /** Make sure the (large) object list is loaded. */
  async ensureObjects() {
    if (this.kinds.object) return this.kinds.object;
    const ctor = this.constructor;
    ctor.#objectsLoading ??= (async () => {
      const base = root();
      const data = await fetchJson(`${base}/bme-objects.json`);
      this.#add("object", buildAssets("object", data.entries ?? [], data, base));
      console.log(`${MODULE_ID} | objects loaded: ${this.kinds.object.length}`);
      return this.kinds.object;
    })();
    try {
      return await ctor.#objectsLoading;
    } catch (err) {
      ctor.#objectsLoading = null;
      throw err;
    }
  }

  #add(kind, assets) {
    this.kinds[kind] = assets;
    for (const a of assets) this.bySrc.set(a.src, a);
  }

  /** @returns {Asset|undefined} */
  get(src) {
    return this.bySrc.get(src);
  }

  /**
   * All assets of the given kinds.
   * @param {string[]} kinds
   * @returns {Asset[]}
   */
  list(kinds) {
    if (kinds.length === 1) return this.kinds[kinds[0]] ?? [];
    return kinds.flatMap(k => this.kinds[k] ?? []);
  }

  /**
   * Distinct folders (up to `depth` levels) for a list of assets, for the folder filter.
   * @param {Asset[]} assets
   */
  static folders(assets, depth = 3) {
    const set = new Set();
    for (const a of assets) {
      const parts = a.folder.split("/");
      for (let d = 1; d <= Math.min(depth, parts.length); d++) {
        const f = parts.slice(0, d).join("/");
        if (f) set.add(f);
      }
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  /**
   * Filter assets by folder prefix and a whitespace-separated text query (all words must match).
   * @param {Asset[]} assets
   * @param {{folder?: string, query?: string}} filter
   */
  static filter(assets, { folder = "", query = "" } = {}) {
    const words = query.toLowerCase().replace(/_/g, " ").split(/\s+/).filter(Boolean);
    const prefix = folder ? `${folder}/` : "";
    return assets.filter(a => {
      if (prefix && !(a.folder === folder || a.folder.startsWith(prefix))) return false;
      for (const w of words) if (!a.search.includes(w)) return false;
      return true;
    });
  }
}
