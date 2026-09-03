---
paths:
  - '**/mapProjection.ts'
  - '**/spawnPoints.generated.ts'
  - '**/sceneLayout.ts'
  - '**/sceneGeometry.ts'
  - '**/sceneSizing.ts'
  - '**/MapView.vue'
  - '**/MineScene.vue'
  - '**/MineMarker.vue'
---

# Two coordinate spaces, on purpose

Both paintings are drawn with `object-fit: cover` into a resizable panel, so both get cropped.
The map and the cave answer that in **opposite** ways, and each file is right for its own
reasons. Before adding or moving a point, know which one you are in.

**The world map — image percent, projected at render time, centre pin.** `spawnPoints.generated.ts`
carries the design's 74 spawn locations as percentages of the _painting_ (1856 x 2304), because
every one of them is a MEASURED position on a specific feature — a ledge, a river fork — and
they run from image x 3.4 to 96.8 and y 28.3 to 98.6, the closest pair 2.65 apart.
`mapProjection.projectToMapBox` converts image percent to box percent from the measured box;
`MapView.vue` calls it, then holds the result inside the box by half a marker, because the design's
own container is exactly the painting's ratio and never crops while ours is resizable. The painting
is pinned `50% 50%`, so both axes crop symmetrically.

That file is **generated** (`node scripts/build-map-sites.mjs`, from `docs/map-spawn-points.json`);
edit the conversion in the script, never the numbers in the output. `docs/map-coordinates.md` §4
explains why the source JSON's own percentages are a third thing again — percentages of a full
app-mockup screenshot, chrome included — and must be re-anchored before use.

**The cave interior — image percent, projected at render time, bottom pin.** `sceneLayout.ts`
authors anchors as percentages of the _painting_, because the interiors are tall portrait art
(1289 x 1600) pinned to the bottom with `object-position: 50% 100%`: the floor the dwarfs stand on
is painted in the lowest band and must never be what gets cropped. How much of the painting
survives swings enormously with the panel's shape. `sceneGeometry.projectToBox` converts;
`MineScene.vue` and `sceneSizing.ts` call it.

So the two spaces agree on the convention and differ on the **pin**, which is exactly why there are
two modules: bottom-pinning the map's crop slides every marker down its own hillside, and
centre-pinning the cave's crops the floor away. Six of `mapProjection.test.ts`'s cases fail if you
swap them, which was confirmed by swapping them.

The trap in both directions: an anchor authored in the wrong space, or projected against the wrong
pin, still looks correct at the panel size you tested and slides off its rock at every other size.

Both modules carry a long header explaining the reasoning, and each explains why the other exists.
Read the header of the file you are editing before you touch a coordinate — this rule is the
warning, those headers are the argument.

## What used to be here

Until #136 the map authored its thirteen hand-placed sites in **box percent** — a percentage of the
rendered box, used raw — which was safe only because `object-position: 50% 60%` made that crop
contract inward from every edge, and only because those sites sat on broad landforms inside a
conservative central band. `mapSites.ts`, `MINE_SITES`, `MAP_TRAILS` and `MineMound.vue` are all
gone with the design's map, and so is that third convention. If you find a coordinate authored in
box percent anywhere, it is a leftover.
