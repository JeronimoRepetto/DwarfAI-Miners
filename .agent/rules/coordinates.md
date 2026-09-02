---
paths:
  - '**/mapSites.ts'
  - '**/sceneLayout.ts'
  - '**/sceneGeometry.ts'
  - '**/sceneSizing.ts'
  - '**/MapView.vue'
  - '**/MineScene.vue'
  - '**/MineMound.vue'
---

# Two coordinate spaces, on purpose

Both paintings are drawn with `object-fit: cover` into a resizable panel, so both get cropped.
The valley and the cave answer that in **opposite** ways, and each file is right for its own
reasons. Before adding or moving a point, know which one you are in.

**The valley map — box percent, no projection.** `mapSites.ts` authors `MINE_SITES` and
`MAP_TRAILS` as percentages of the _rendered box_. `MapView.vue` uses them raw. This is safe
only because `object-position: 50% 60%` makes the crop contract inward from every edge, so an
authored point can drift toward the valley floor but never off the canvas. It holds up because
sites stay inside a conservative central band, which `mapSites.test.ts` enforces as explicit
safe bounds — along with a minimum distance between sites, a stable ordering, and every site
being reachable by a trail. A point that needs to hit a 2%-wide rock is wrong the moment someone
drags the panel wider.

Be careful with one claim here: the header of `mapSites.ts` says two rules are enforced by
`mapSites.test.ts`, the second being that sites are pinned to broad landforms. **That second one
is not tested**, and cannot be from coordinates alone — the nearest thing is the minimum-distance
check, which is about two mounds reading as one blob, not about the size of the feature
underneath. Keeping a site on a broad landform is still the right instinct; it is just on you,
not on the suite.

**The cave interior — image percent, projected at render time.** `sceneLayout.ts` authors
anchors as percentages of the _painting_, because the interiors are tall portrait art
(1289 x 1600) pinned to the bottom with `object-position: 50% 100%`. How much of the painting
survives swings enormously with the panel's shape, so a box-percent point would sit on the
tunnel mouth in one shape and the foreground boulders in another. `sceneGeometry.projectToBox`
converts image percent to box percent from the measured box; `MineScene.vue` and
`sceneSizing.ts` call it.

The trap in both directions: an anchor authored in the wrong space still looks correct at the
panel size you tested, and slides off its rock at every other size.

Both files carry a long header explaining the reasoning, and `sceneGeometry.ts` explains why the
two differ. Read the header of the file you are editing before you touch a coordinate — this
rule is the warning, those headers are the argument.
