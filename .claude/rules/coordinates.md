---
paths:
  - '**/mapProjection.ts'
  - '**/spawnPoints.generated.ts'
  - '**/interiorMap.ts'
  - '**/interiorRoute.ts'
  - '**/sceneLayout.ts'
  - '**/sceneGeometry.ts'
  - '**/sceneSizing.ts'
  - '**/MapView.vue'
  - '**/MineScene.vue'
  - '**/MineMarker.vue'
---

# One convention, two fits, on purpose

Both paintings are drawn into a resizable panel, and both author their points as percentages of
the _painting_ (image percent), projected to the box at render time. Where they differ is what
happens to the space that does not match — and they answer in **opposite** ways, each right for
its own reasons. Before adding or moving a point, know which one you are in.

**The world map — image percent, `cover`, centre pin.** `spawnPoints.generated.ts` carries the
design's 74 spawn locations as percentages of the painting (1856 x 2304), because every one of
them is a MEASURED position on a specific feature — a ledge, a river fork — and they run from
image x 3.4 to 96.8 and y 28.3 to 98.6, the closest pair 2.65 apart.
`mapProjection.projectToMapBox` converts image percent to box percent from the measured box;
`MapView.vue` calls it, then holds the result inside the box by half a marker, because the
design's own container is exactly the painting's ratio and never crops while ours is resizable.
The painting is pinned `50% 50%`, so both axes crop symmetrically.

**The mine interior — image percent, `contain`, nothing cropped.** `interiorMap.ts` carries every
workstation and corridor as percentages of the painting, because the interiors are a 1184 x 3622
tower drawn into a 245px column whose height is the whole display. A box-percent point would sit
on a different gallery at every column height. `sceneGeometry.projectToBox` converts;
`MineScene.vue` and `sceneSizing.ts` call it. Two things to know before touching a number:

- **The interior is `contain`, not `cover`** (`INTERIOR_FIT` in `sceneSizing.ts`). Nothing is ever
  cropped away, at any column shape — the leftover height becomes empty column instead. That is
  deliberate: every work point in this painting is load-bearing, and `cover` at a full-screen
  column height would eat about a quarter of the map's width. `sceneGeometry` implements both
  fits anyway, because they are the same sum with one `min` swapped for a `max`.
- **Distances are painting pixels, never percent** (`paintingDistance` in `interiorRoute.ts`).
  The art is three times taller than it is wide, so a percent of height is three times a percent
  of width — a naive hypotenuse calls a long vertical drop "nearer" than a short sideways step,
  and picks the wrong corridor, the wrong route and the wrong walk duration, all consistently
  enough to look deliberate.

Why the split exists: the map's markers sit on broad landforms and tolerate a symmetric crop; the
interior's stations do not tolerate any. Swapping the fits fails tests on both sides — six of
`mapProjection.test.ts`'s cases if the map is bottom-pinned, and `sceneSizing.test.ts` proves
`cover` would lose the interior's leftmost station.

**Both data files are generated — edit the script, never the numbers.**
`spawnPoints.generated.ts` comes from `node scripts/build-map-sites.mjs` (source:
`docs/map-spawn-points.json`); `interiorMap.ts` from `node scripts/build-interior-map.mjs`
(source: `docs/mine-interior-features.json`). Each source JSON measures against a **third space**
that is neither of the live ones — a full app-mockup screenshot for the map, a 182 x 579
comparison panel with its white title band for the interior — and each script re-anchors it onto
the real painting; its header explains how the art box was measured. Never copy a number straight
out of a source JSON — regenerate. `docs/map-coordinates.md` §4 is the long form.

The trap in every direction: a point authored in the wrong space, or projected against the wrong
fit, still looks correct at the one size you tested, and slides off its rock at every other.

Each file carries a long header explaining its own reasoning. Read the header of the file you are
editing before you touch a coordinate — this rule is the warning, those headers are the argument.

## What used to be here

Until #136 the map authored thirteen hand-placed sites in **box percent** — used raw against the
rendered box — and until #137 the cave authored anchors against a bottom-pinned 1289 x 1600
painting whose crop swung with the panel's shape. `mapSites.ts`, `MINE_SITES`, `MAP_TRAILS`,
`MineMound.vue`, the cave's `WalkableBand` and its `depthScale` are all gone with the redesign,
and so are both of those conventions. A coordinate authored in box percent, or an anchor that
assumes a bottom pin, is a leftover.
