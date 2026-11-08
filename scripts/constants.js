export const MODULE_ID = "pf2e-battlemap-editor";
export const LAYER_NAME = "battlemap";
export const FLAG_MAP = "map";
export const MAP_VERSION = 1;

/** Mask resolution: pixels per grid square for painted terrain. */
export const MASK_RES = 32;

/** Maximum number of painted terrain layers per map (each is a full-scene masked texture). */
export const MAX_TERRAIN_LAYERS = 12;

/** Which catalog kinds each tool browses. */
export const TOOL_KINDS = {
  terrain: ["terrain"],
  path: ["path"],
  wall: ["wall", "path"],
  door: ["portal"],
  object: ["object"],
  scatter: ["object"],
  select: []
};

export const WALL_TYPES = {
  normal: "Normal (blocks sight and movement)",
  terrain: "Terrain (limited sight)",
  invisible: "Invisible (blocks movement only)",
  ethereal: "Ethereal (blocks sight only)",
  none: "Art only (no Foundry walls)"
};

export const LIGHT_PRESETS = [
  { match: /candle|candelabr/i, bright: 0.5, dim: 1.5, color: "#ffb35c", animation: "torch", intensity: 2 },
  { match: /chandelier/i, bright: 3, dim: 6, color: "#ffc178", animation: "torch", intensity: 1 },
  { match: /brazier|fire_?pit|campfire|bonfire|fireplace|hearth|forge|furnace/i, bright: 3, dim: 6, color: "#ff8a3d", animation: "flame", intensity: 4 },
  { match: /torch|sconce/i, bright: 2, dim: 4, color: "#ff9a4a", animation: "torch", intensity: 3 },
  { match: /lantern|lamp|lamppost|street_?light/i, bright: 2, dim: 4, color: "#ffd08a", animation: "torch", intensity: 1 },
  { match: /crystal|glow|magic|arcane|rune/i, bright: 1, dim: 3, color: "#7fb4ff", animation: "pulse", intensity: 3 },
  { match: /lava|magma/i, bright: 1, dim: 3, color: "#ff5a1f", animation: "fog", intensity: 3 }
];
