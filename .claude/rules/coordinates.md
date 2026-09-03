---
paths:
  - '**/mapSites.ts'
  - '**/interiorMap.ts'
  - '**/interiorRoute.ts'
  - '**/sceneLayout.ts'
  - '**/sceneGeometry.ts'
  - '**/sceneSizing.ts'
  - '**/MapView.vue'
  - '**/MineScene.vue'
  - '**/MineMound.vue'
---

# Two coordinate spaces, on purpose

Both paintings are drawn into a resizable box, so both have to answer what happens to the space
that does not match. The valley and the mine answer in **opposite** ways, and each file is right
for its own reasons. Before adding or moving a point, know which one you are in.

**The valley map — box percent, no projection.** `mapSites.ts` authors `MINE_SITES` and
`MAP_TRAILS` as percentages of the _rendered box_. `MapView.vue` uses them raw. This is safe
only because `object-fit: cover` with `object-position: 50% 60%` makes the crop contract inward
from every edge, so an authored point can drift toward the valley floor but never off the canvas.
It holds up because sites stay inside a conservative central band, which `mapSites.test.ts`
enforces as explicit safe bounds — along with a minimum distance between sites, a stable
ordering, and every site being reachable by a trail. A point that needs to hit a 2%-wide rock is
wrong the moment someone drags the panel wider.

Be careful with one claim here: the header of `mapSites.ts` says two rules are enforced by
`mapSites.test.ts`, the second being that sites are pinned to broad landforms. **That second one
is not tested**, and cannot be from coordinates alone — the nearest thing is the minimum-distance
check, which is about two mounds reading as one blob, not about the size of the feature
underneath. Keeping a site on a broad landform is still the right instinct; it is just on you,
not on the suite.

**The mine interior — image percent, projected at render time.** `interiorMap.ts` carries every
workstation and corridor as percentages of the _painting_, because the interiors are a 1184x3622
tower drawn into a 245px column whose height is the whole display. A box-percent point would sit
on a different gallery at every column height. `sceneGeometry.projectToBox` converts image
percent to box percent from the measured box; `MineScene.vue` and `sceneSizing.ts` call it.

Two things about that projection are worth knowing before you touch a number:

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

**And a third space, which is neither.** `docs/mine-interior-features.json` measures against one
182x579 panel cropped out of the design's five-panel comparison sheet, white title band and all.
Those percentages are NOT the ones `interiorMap.ts` carries: `scripts/build-interior-map.mjs`
re-anchors them onto the painting, and its header explains how the panel's art box was measured.
Never copy a number straight out of that JSON — regenerate.

The trap in every direction: a point authored in the wrong space still looks correct at the one
size you tested, and slides off its rock at every other.

Each file carries a long header explaining its own reasoning, and `sceneGeometry.ts` explains why
the two live spaces differ. Read the header of the file you are editing before you touch a
coordinate — this rule is the warning, those headers are the argument.
