# Battlemap Editor (Foundry VTT v14)

A Dungeondraft-style map editor inside Foundry that uses your own Forgotten Adventures Dungeondraft packs.
Drawing something also sets up the scene behind it: walls become Foundry walls, doors become working doors with
FA door art, light-source objects get matching lights, and the finished map is baked into the scene background.

## Setup

1. **Extract the assets** (once, and again after FA updates). The packs stay outside the module in
   `FoundryVTT-WindowsPortable-14.365/fa-packs/`. From this module folder:

   ```
   python -I tools/extract_fa_packs.py --packs ../../../fa-packs --out ../../fa-assets
   ```

   This writes the art and thumbnails to `Data/fa-assets/<PACK>/` (about 9 GB, a few minutes), plus
   `bme-index.json` and `bme-objects.json`. Files already present are skipped, so it shares `fa-assets` with
   pf2e-map-generator. Use `--dry-run` to see sizes. Edit `tools/extract_config.json` to include or exclude
   folders.
2. Enable **Battlemap Editor (FA packs)** in your world.
3. Click **New battlemap** in the Scenes sidebar, or open any scene and pick the **Battlemap Editor**
   controls (map icon) on the left.

FA assets are licensed to you for personal use. `.gitignore` keeps packs, extracted files and images out of git;
don't publish them.

## Tools

| Tool | What it does |
|---|---|
| Paint terrain | The first texture you click fills the map; then drag to paint others on top. Alt-drag erases. Ctrl/Shift+wheel: brush size. *Opacity* is the most one stroke can add, however often you cross it; *Flow* is how much one pass adds (low flow: scrub to build up). Another stroke adds on top. Layers can be reordered or removed in the palette; click a layer to select its texture again. |
| Paths | Click points; double-click, right-click or Enter finishes. Backspace removes the last point, Esc cancels. Roads, rivers, cliffs, fences. *Roughness* adds a natural wobble to the line (cliff edges, riverbanks); each path gets its own noise. |
| Walls | Click grid points (Shift: free), click the first point to close a room. Draws the wall art and creates Foundry walls (normal, terrain, invisible, ethereal, or art only). With no art selected you get Foundry walls only. |
| Rooms | Floor and walls in one go. Pick a floor texture, then drag a rectangle or circle, or click a polygon; Ctrl+click adds a curve point and the wall bends through it (an apse, a round tower). *Merge* opens into rooms it overlaps or touches (dungeons); *Separate* keeps a wall where it meets other rooms (houses, a closet inside a hall). Alt or *Erase* cuts away. *Repaint room* swaps a room's floor (and optionally its walls). Walls use the Wall tool's art, type and thickness, and doors stay in place when rooms change. |
| Doors & windows | Hover an editor wall and click. Door art opens with Foundry's swing animation; art from `Windows/` makes a window that blocks movement but not sight. Click an opening again to remove it. |
| Objects | Click to place a tile. Shift+wheel rotates, Ctrl+wheel scales. Variants of the same object (e.g. Arctic Fir Tree Snow Large A1…A5) show as one cell marked ×N, which places a random variant each time; click the ×N badge to pick one exact variant. The *Group* checkbox turns this off. Ctrl+click several cells to mix them. Torches, braziers, candles and other light sources get a matching light. |
| Scatter | Drag to sprinkle the selected objects. Spacing grows with object size. With *Always mix variants* (on by default), even an exact variant you picked is mixed with its siblings. |
| Select | Click a path, wall, opening, tile, light (lights show as yellow dots) or room floor; Delete removes it (a room wall deletes its room). Tiles and lights can be dragged (Shift toggles snapping; an object's light moves with it). Shift+wheel rotates and Ctrl+wheel scales a tile. Double-click opens Foundry's settings sheet; the palette has Mirror, To front/back and Hide. A selected path can be mirrored (art to the other side of the line, e.g. a cliff drawn from the wrong end), get new noise, or change roughness and thickness. Also shows map stats and can restore flattened objects. |
| Bake | Renders terrain, paths, wall art (and optionally the editor's objects) into one WebP and makes it the level background. Players only see the map after baking. |

Ctrl+Z undoes the last 30 editor actions. The map autosaves into the scene; painted masks are uploaded as PNGs to
`worlds/<world>/battlemap-editor/<scene id>/` (setting: *Output folder*). Tiles and lights stay ordinary
Foundry documents; edit them with the Tile and Lighting tools.

You can also paint on top of a scene that already has a background image: the image is kept underneath.

## Notes

- FA terrain textures carry a height map in their alpha channel. By default the editor ignores it and transitions
  use the soft brush edge. Turn on **Terrain height blending** in the module settings for Dungeondraft-style borders,
  where stones and grass tufts poke through first; *Height blending softness* sets how crisp they are. With it on, a
  brush opacity below 1 shows only the raised parts of a texture. Existing maps change on the next bake.
- Baking renders in 4096 px chunks; the scene must fit in one image (16384 px per side). At 100 px per square that
  is 163 squares.
- *Flatten objects* paints the editor's tiles into the image and removes the tiles. They are kept in the map data,
  so later bakes still contain them, and Select → *Restore flattened objects* brings them back as tiles.
- Macro API: `game.modules.get("pf2e-battlemap-editor").api` has `openNewMapDialog()`, `bake({flatten})`,
  `layer` and `EditorCatalog`.
