# Planned features

Not implemented yet. Notes on intent and first design thoughts.

## ~~Layers for placeables~~ (done: see README, Tile layers)

## Prefab editor

- Save a group of placed items as a reusable prefab and stamp it like an object (rotate, scale, mirror, random variants).
- A prefab can span layers. Example: a tree is a trunk on *Objects* plus a canopy on *Roof*.
- Bonus: prefabs can also contain walls and lights. Example: terrain walls around the trunk, or a campfire's light.
- Coordinates are relative to the prefab anchor. Stamping creates each part on its layer and links the parts
  (shared flag), so Select, move and delete treat the prefab as one unit, with an option to break it apart.
- Storage: world-level (a module setting or a journal/compendium) so prefabs can be used on every map.
- Open questions: editing a prefab later (update existing stamps?), and how variants of the parts combine.

## Terrain-style painting for difficult terrain and other regions

- Paint regions with the same brush as terrain (paint, Alt to erase, brush size), instead of drawing polygons.
- Output: Foundry Region documents with behaviours (difficult terrain first; later hazards, darkness, teleport, …).
- The painted mask is turned into region shapes (trace the mask outline into polygons and simplify), and the
  matching Region is updated after each stroke.
- Optional visual: a semi-transparent tint in the editor only, or real terrain art like mud or rubble, so painting
  "difficult terrain" can also paint the look.
