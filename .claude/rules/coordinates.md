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

# One convention, one fit, two modules

Both paintings are drawn into a resizable panel, both author their points as percentages of the
_painting_ (image percent), projected to the box at render time — and since #153 both are fitted
the same way: **`contain`, centred, nothing ever cropped.** What differs is only which module you
are standing in.

**The rule the maintainer set, in their own words:** "the whole painting must be visible, aspect
preserved, no crop — full height of the shell content area, width follows". So a painting's column
does not have a width of its own; the display's height gives it one. `interiorColumnWidth`
(`sceneSizing.ts`) and `mineColumnWidth` / `secondaryColumnWidth` (`main/shell/panelBounds.ts`) are
that rule evaluated, and `panelBounds.test.ts` holds the renderer's copy and main's equal. The
design's `245px` interior is what the rule returns at the mock's own 768-tall composition; it was
never a constant, and reserving it on a 1392-tall display is what made the interior read tiny.

**The world map.** `spawnPoints.generated.ts` carries the design's 74 spawn locations as
percentages of the painting (1856 x 2304), because every one of them is a MEASURED position on a
specific feature — a ledge, a river fork — and they run from image x 3.4 to 96.8 and y 28.3 to
98.6, the closest pair 2.65 apart. `mapProjection.projectToMapBox` converts image percent to box
percent from the measured box; `MapView.vue` calls it, then holds the result inside the box by half
a marker — not because anything is cropped, but because a 22px marker centred on image x 3.4 would
hang half off the panel.

**The mine interior.** `interiorMap.ts` carries every workstation and corridor as percentages of
the painting, because the interiors are a 1184 x 3622 tower. A box-percent point would sit on a
different gallery at every column height. `sceneGeometry.projectToBox` converts; `MineScene.vue`
and `sceneSizing.ts` call it. One thing more to know before touching a number:

- **Distances are painting pixels, never percent** (`paintingDistance` in `interiorRoute.ts`).
  The art is three times taller than it is wide, so a percent of height is three times a percent
  of width — a naive hypotenuse calls a long vertical drop "nearer" than a short sideways step,
  and picks the wrong corridor, the wrong route and the wrong walk duration, all consistently
  enough to look deliberate.

**Both data files are generated — edit the script, never the numbers.**
`spawnPoints.generated.ts` comes from `node scripts/build-map-sites.mjs` (source:
`docs/map-spawn-points.json`); `interiorMap.ts` from `node scripts/build-interior-map.mjs`
(source: `docs/mine-interior-features.json`). Each source JSON measures against a **third space**
that is neither of the live ones — a full app-mockup screenshot for the map, a 182 x 579
comparison panel with its white title band for the interior — and each script re-anchors it onto
the real painting; its header explains how the art box was measured. Never copy a number straight
out of a source JSON — regenerate. `docs/map-coordinates.md` §4 is the long form.

The trap in every direction: a point authored in the wrong space still looks correct at the one
size you tested, and slides off its rock at every other.

Each file carries a long header explaining its own reasoning. Read the header of the file you are
editing before you touch a coordinate — this rule is the warning, those headers are the argument.

## What used to be here

Until #136 the map authored thirteen hand-placed sites in **box percent** — used raw against the
rendered box — and until #137 the cave authored anchors against a bottom-pinned 1289 x 1600
painting whose crop swung with the panel's shape. `mapSites.ts`, `MINE_SITES`, `MAP_TRAILS`,
`MineMound.vue`, the cave's `WalkableBand` and its `depthScale` are all gone with the redesign,
and so are both of those conventions. A coordinate authored in box percent, or an anchor that
assumes a bottom pin, is a leftover.

Until #153 the map alone was drawn with `object-fit: cover`, which `screens/map.md` asks for, and
this file said the two paintings answered the leftover space in **opposite** ways on purpose. The
maintainer's first acceptance run overruled that ruling from the running app: the crop was eating
a quarter of the valley. `visibleMapRect` and `coverScaleOf` went with it, replaced by
`drawnMapRect` and `mapFitScale` — the same sums with one `max` swapped for a `min`, which is all
the difference between the two fits ever was.
