# Map & Mine-Interior Coordinate Extraction (Issues #90, #89)

**Verdict: usable now for marker placement, one re-anchoring step short of
authoring `mapSites.ts`/`sceneLayout.ts` directly.** The 74 world-map spawn
points and every mine-interior work-point class (spawn/worker/foreman/
ladder/ramp) extracted at their expected counts, verified against
`screens/map.md`/`screens/mine.md` and against a rendered overlay, with
sub-pixel centroid stability. The passable-paths network extracted as an
honest polyline graph, not a fabricated clean one — its per-panel topology
varies by 0–3 nodes depending on how much a given tier's own art palette
overlaps the flat route-line gray, and that variance is reported rather than
hidden. Both source PNGs are full design-mockup renders (UI chrome, a
five-tier comparison sheet), not pixel-identical crops of the art the
renderer actually loads — see §5 before treating either JSON file as
authoring-ready input for the two files `.claude/rules/coordinates.md`
governs.

Source images (local, gitignored, read via one required CLI argument — see
§8), all under the design source's `assets/` directory:
`map/map-mine-spawn-points.png`, `mine/maps/mine-interior-work-points.png`,
and `mine/maps/mine-interior-passable-paths.png`. Legend, per
`screens/mine.md`: spawn = red circle, worker workstation = blue triangle,
foreman workstation = orange diamond, vertical ladder = purple double-arrow,
stair/ramp = magenta square, passable path = gray route line.

---

## 1. Method

### 1.1 Decoding the PNGs with no new dependency

`scripts/mapCoords/png.mjs` is a from-scratch PNG codec: chunk framing and
CRC32 are hand-rolled, DEFLATE is Node's own `zlib.inflateSync`/`deflateSync`.
Scope is deliberately narrow — 8-bit, non-interlaced, RGB or RGBA, no
palette — and throws rather than silently misreading anything outside that.
All three source images satisfy it (verified from their own IHDR, not
assumed): `map-mine-spawn-points.png` is 645×772, `mine-interior-work-points.png`
and `mine-interior-passable-paths.png` are both 910×579, all three color
type 2 (truecolor, no alpha), 8-bit, non-interlaced. `encodePng` (filter-type
"None", still through `zlib.deflateSync`) exists only to render this
report's validation overlays — never used on anything committed.
`png.test.mjs` round-trips a synthetic bitmap and pins `crc32`/`paethPredictor`
against known values.

### 1.2 Point markers: flat-color clustering

Every marker in both interior sheets and the world map is a single flat
design-tool fill with no gradient — confirmed by histogramming each source
image and finding one exact RGB triple accounts for the overwhelming
majority of near-that-hue pixels, with only a thin antialiased fringe around
it (e.g. spawn red: 4636 pixels at exactly `rgb(255,49,49)` out of 5195
candidate red pixels total). `scripts/mapCoords/cluster.mjs` masks every
pixel within a color-distance tolerance of that exact color, then labels
8-connected components (iterative flood fill, not recursive — safe on a
component with thousands of pixels) and reduces each to a centroid, pixel
count, and bounding box. One blob is one marker: true for every class here,
verified per class by the blob count against §3/§4's expected counts and by
the rendered overlay (§6).

Exact colors, measured directly from the source pixels (not guessed):

| Class            | Color                | Source                             |
| ---------------- | -------------------- | ---------------------------------- |
| World-map spawn  | `rgb(255, 49, 49)`   | `map-mine-spawn-points.png`        |
| Interior spawn   | `rgb(255, 49, 49)`   | `mine-interior-work-points.png`    |
| Interior worker  | `rgb(81, 112, 255)`  | same                               |
| Interior foreman | `rgb(255, 117, 31)`  | same                               |
| Interior ladder  | `rgb(140, 82, 255)`  | same                               |
| Interior ramp    | `rgb(255, 0, 176)`   | same                               |
| Passable path    | `rgb(166, 166, 166)` | `mine-interior-passable-paths.png` |

### 1.3 The route: a shape, not a point

The gray route line is a path a dwarf walks along, so collapsing it to a
centroid would throw away exactly the information issue #89 needs.
`scripts/mapCoords/skeleton.mjs` instead:

1. **Zhang-Suen thinning** erodes the filled route mask to a 1px-wide
   skeleton that preserves the shape's topology (branches, loops).
2. **Graph tracing** walks the skeleton: degree-1 pixels are endpoints,
   degree-3+ pixels are junctions, and the pixel run between two such nodes
   becomes one ordered polyline.
3. **Corner-cluster merging.** A wide intersection does not thin to exactly
   one pixel — it leaves a small cluster of adjacent degree≥3/degree-1
   pixels, connected to each other by very short edges. Union-Find merges
   every edge ≤6 pixels long into one node at the cluster's centroid.
4. **Degree-2 splicing.** A corridor bend is shape, not a decision point, so
   any node left with exactly two edges after merging gets spliced out —
   its two edges concatenate into one, iteratively, so a chain of several
   almost-collinear bend artifacts collapses in one pass.
5. **Douglas-Peucker simplification** (epsilon 1.5px) drops points that sit
   within 1.5 source pixels of the straight line between their neighbors,
   without changing the path's visible shape.

Steps 3–4 are not cosmetic — without them the raw trace over-reports nodes
by roughly 6× on the real art (Cropper panel: 128 raw nodes → 20 after
merge+splice, §3.3). `skeleton.mjs`'s test suite pins the same behavior on a
synthetic T-shape: the raw trace finds more than 4 nodes for a shape with
one true junction and three arm-ends, and the merge+splice pipeline reduces
it back to exactly 4 nodes / 3 edges at the right positions.

---

## 2. World map spawn points — results

**Found 74 of 74 expected** (`screens/map.md`: "The map defines **74**
symmetric spawn locations"). Tolerance 40 (RGB Euclidean distance),
minimum blob size 20px — and the count holds at exactly 74 across a wide
parameter sweep (tolerance 20/30/40/50/60/80 × min size 3/5/8/10, all 24
combinations), so this is not a threshold picked to hit the target number.
Blob sizes range 67–72px (a filled circle of radius ≈4.6–4.8px), consistent
with 74 uniform, non-overlapping markers.

**Empirical centroid stability:** matching every blob found at tolerance 20
against its nearest counterpart at tolerance 80 (4× the range), the maximum
centroid drift is 0.235px and the mean is 0.086px across all 74 points. The
error bound this report claims for every spawn-point coordinate is **±0.5px
in source-image pixels**, i.e. ≈±0.08% on the x axis and ≈±0.06% on the y
axis of `map-mine-spawn-points.png`.

## 3. Mine interior — results

Both interior sheets show five tier variants side by side (displayed order,
per their own title row: **Cropper, Bronze, Silver, Gold, Uranium** — note
this differs from the canonical tier order `screens/mine.md` names,
Bronze/Cropper/Silver/Gold/Uranium; the canonical order governs meaning
everywhere else in the codebase, this is only the artwork's left-to-right
layout). Per `screens/mine.md`, "each interior variant shares the same
symmetric logical map; only the visual style changes" — confirmed, not
assumed: every marker class produced the _identical_ per-panel count across
all five panels.

### 3.1 Work points

| Class   | Total (5 panels) | Per panel | Blob size range (px) |
| ------- | ---------------- | --------- | -------------------- |
| Spawn   | 15               | 3         | 290–295              |
| Worker  | 90               | 18        | 197–215              |
| Foreman | 15               | 3         | 180–199              |
| Ladder  | 25               | 5         | 273–288              |
| Ramp    | 20               | 4         | 393–396              |

Tolerance 40, minimum blob size 80. One sub-threshold fragment (19px, ~10%
of a normal foreman diamond's footprint) was found near the Cropper panel's
foreman cluster before the size floor dropped it — almost certainly the tip
of a diamond marker separated by an occluding art detail (a beam or rock)
breaking 8-connectivity, not a fourth marker: it sat 20px from two of the
panel's three real foreman blobs and nowhere near a fourth. Every other
panel's foreman count was exactly 3 with no fragment, so this is called out
rather than silently absorbed by the size floor.

The committed JSON uses **one representative panel (Bronze, index 1)** —
any panel would do topologically, since the logical map is identical; Bronze
was chosen because its route extraction (§3.2) needed zero manual exception,
unlike Cropper and Silver.

### 3.2 Passable paths

Route color `rgb(166, 166, 166)`, tolerance 30, minimum component size 100.
Per panel the route mask forms **two** connected components, not one: a main
network (≈5000–5227px) and a smaller stub (≈286–300px) near the panel's
bottom (entrance) that does not touch the main network within the flat-color
mask. Both are extracted. Visual inspection of the overlay (§6) shows the
stub sits right where the entrance/campfire decoration is drawn on top of
the art — most likely a real spur route whose connecting pixels are
occluded by that decoration, not a genuinely disconnected path. Consumers
should treat the stub as probably connected to the network at the mine
phase's discretion, not as confirmed-disconnected.

**Bronze panel (committed):** main network 18 nodes / 20 edges (1487
skeleton px), stub 2 nodes / 1 edge (82 skeleton px).

### 3.3 Cross-panel topology check — and its one honest gap

The same merge+splice pipeline (§1.3) was run on the main network of all
five panels as a consistency check, not just Bronze:

| Panel                  | Blob sizes (px) | Nodes  | Edges  |
| ---------------------- | --------------- | ------ | ------ |
| Cropper                | 5051, 294       | 20     | 21     |
| **Bronze (committed)** | 5227, 286       | **18** | **20** |
| Silver                 | 4969, 298       | 53     | 20     |
| Gold                   | 5083, 300, 172  | 18     | 20     |
| Uranium                | 5020, 298       | 18     | 20     |

Three of five panels (Bronze, Gold, Uranium) agree exactly at 18 nodes / 20
edges — the modal, trusted topology, and what the committed dataset uses.
Two disagree, and both were investigated visually rather than left as an
unexplained number:

- **Silver: 53 nodes.** Rendering its skeleton overlay shows dozens of small
  red-marked fragments scattered off the true green route path, clustered
  over the panel's silver-ore rock walls — Silver's own ore/rock highlight
  palette sits close enough to the flat route gray to register as extra
  route pixels and produce spurious skeleton branches. This is a genuine
  limitation of pure color-based extraction applied to art whose palette
  isn't fully independent of the annotation color, not a bug in the
  clustering or thinning logic. **Silver's route topology should not be
  trusted**; its markers (§3.1) were unaffected, since marker colors
  (saturated blue/orange/purple/magenta/red) don't overlap Silver's palette
  the way a desaturated gray does.
- **Cropper: 20 nodes / 21 edges**, one pair more than the 18/20 consensus.
  Unlike Silver, its overlay shows no stray off-path fragments — the
  skeleton tracks the visible gray line cleanly throughout. The extra
  node/edge pair is more likely a merge-radius boundary case (a real
  junction's thinning-cluster pixels landing just over the 6-point merge
  threshold in this one panel) than color contamination. Not fully
  isolated; called out rather than asserted.

Gold's extra small blob (172px) is the panel-divider line's own antialiasing
— a 1px-wide, 172px-tall sliver, correctly excluded from all topology work
by the "take the largest blob" selection, confirmed by its degenerate
bounding box.

---

## 4. Coordinate conventions — read before using either JSON file

`.claude/rules/coordinates.md` names two conventions already live in this
codebase: `mapSites.ts`'s **box-percent** (percentage of the _rendered box_,
authored raw, safe only because of a conservative central band + minimum
spacing) and `sceneLayout.ts`'s **image-percent** (percentage of the
_painting_, projected to the box at render time via
`sceneGeometry.projectToBox`). Neither JSON file below is either of those,
and treating them as such would misplace every point.

### `map-spawn-points.json`

**Convention: image-percent of the source PNG itself** (645×772px,
`xPercent`/`yPercent` = pixel position ÷ image dimension × 100). This is the
_same kind_ of convention `sceneLayout.ts` uses (percent of an image) but
**not the same pixel space as anything the renderer loads**:
`map-mine-spawn-points.png` is a full app-mockup screenshot — the gold card
border, 12px corner radius, and the settings/compass/flask icon column are
all baked into these pixels — not a crop of `map-bg-day.jpg`, 1856×2304
(aspect ratio 0.806 vs. this mockup's 0.835). That file (and its three time-
of-day siblings, `src/renderer/src/assets/art/map/`) matches this design
source's pixel-art style, but — checked directly, not assumed —
`MAP_BG_SRC` in `art.ts` currently points at the older
`concept/map-bg.jpg` instead, so it isn't wired into the renderer yet
either; the same "real matching art already exists, not yet integrated"
situation §4's interior section describes in more detail. **Before
authoring `MINE_SITES` from these numbers**, they
need re-anchoring against the real rendered map box (or at minimum, the
mockup's card interior needs to be cropped out and re-normalized against
`map-bg-*.jpg`'s own pixel dimensions) — copying `xPercent`/`yPercent`
straight into `mapSites.ts` would place every site relative to the mockup's
border and icon column, not the painting.

### `mine-interior-features.json`

**Convention: image-percent of one 182×579 tier panel**, cropped out of the
910×579 five-panel comparison sheet (`extractedPanelIndex: 1`, Bronze).
Same caveat, sharper, and checked directly against what's actually in the
tree rather than assumed: `INTERIOR_ART_SIZE` (`src/renderer/src/lib/art.ts`)
says the in-app interior painting is **1289×1600** — but that constant
currently points `INTERIOR_SRC` at `src/renderer/src/assets/art/concept/
interior-<tier>.jpg`, an early painterly concept painting in a visibly
different art style from this design source's isometric pixel art. That is
**not** the art this dataset was extracted from, and re-anchoring against it
would silently mix two unrelated paintings.

The art that actually matches — checked visually, not assumed — already
exists, uncommitted to any component: `src/renderer/src/assets/art/
inside-mines/inside-<tier>-mine.jpg` (`inside-bronze-mine.jpg` viewed and
compared directly against this report's Bronze panel: same isometric
staircase/ladder/ore-vein composition, same room layout, unmistakably the
same painting at far higher resolution and with no annotation markers).
All five tiers share its dimensions, **1184×3622** (aspect ratio 0.327,
much closer to this panel crop's own 182×579 / 0.314 than the concept
painting's 0.806 is) — Cropper's file is 1184×3620, 2px off, negligible.
Two of the five filenames carry typos worth knowing about before scripting
against them: `inside-cropper-mine..jpg` (double dot) and
`insiede-uranium-mine.jpg`. None of these five files are imported by
`art.ts`, referenced by `scripts/build-art.mjs`'s source-file naming
(`interior-<tier>.jpg`, not `inside-<tier>-mine.jpg`), or otherwise wired
into the renderer yet — they read as delivered-but-unintegrated art for
this exact feature.

**Before authoring `sceneLayout.ts` anchors from this dataset**, re-derive
its percentages against `inside-mines/inside-<tier>-mine.jpg` once that art
is wired up as `INTERIOR_SRC` (which will also mean updating
`INTERIOR_ART_SIZE` off its current 1289×1600) — this dataset tells you
_what_ to place and _roughly where relative to itself_, not the final
image-percent values for that real painting.

Both `_meta.convention` fields in the JSON restate this inline, so the
warning travels with the data even if this file is not read alongside it.

---

## 5. Validation

Every dataset was cross-checked two ways: a count against an independent
expectation (§2, §3.1), and a rendered overlay read back with the same
image-viewing step used to read the originals — not just diffed
numerically.

- **World map:** all 74 detected points, rendered as cyan-outlined squares
  directly on the original 645×772 art. Every square lands precisely
  centered on its red dot with no visible offset, no missed dot, and no
  spurious extra marker anywhere on the map. **Verdict: pass, no
  reservations.**
- **Interior markers (Bronze panel):** every centroid rendered as a
  white-on-black crosshair (a contrasting color, not the marker's own —
  redrawing in the same color would just repaint the shape and prove
  nothing). Every crosshair sits in the visual center of its triangle/
  diamond/circle/arrow/square, for all five classes. **Verdict: pass, no
  reservations.**
- **Interior route (Bronze panel):** skeleton drawn in green, nodes as red
  squares, both directly on the original art. The green line tracks the
  gray route's centerline through every corner and both branches; the 18
  red nodes fall on the true corners/junctions, not on arbitrary bends.
  **Verdict: pass** for Bronze/Gold/Uranium's shared topology; **Silver's
  topology is flagged untrustworthy** per §3.3 and should be re-extracted
  with a tighter route-color tolerance (or a manual pass) before use.

Overlay PNGs are not committed — they are renders of gitignored design
source and regenerate from `--overlay-dir` (§8).

---

## 6. Known error bounds, summarized

| Dataset                          | Bound                  | Basis                                                                                                                             |
| -------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| World-map spawn centroids        | ±0.5px (source pixels) | Empirical: max 0.235px drift across a 4× tolerance sweep, all 74 points                                                           |
| Interior marker centroids        | ±1px (source pixels)   | Same clustering method on flatter, larger (180–396px) blobs; not independently swept, bounded by analogy to the spawn measurement |
| Interior route node positions    | ±6px (source pixels)   | The merge-cluster radius (edges ≤6 points get folded into one node)                                                               |
| Interior route polyline shape    | ±1.5px (source pixels) | The Douglas-Peucker simplification epsilon                                                                                        |
| All `xPercent`/`yPercent` values | rounded to 2 decimals  | Adds ≤0.005% of the relevant dimension, negligible next to the above                                                              |

---

## 7. How the map/interior phases should consume this data

1. **Read §4 before writing a single coordinate into `mapSites.ts` or
   `sceneLayout.ts`.** Neither JSON file's percentages are directly
   authorable — both need re-anchoring against real production art first.
2. **Counts and relative layout are trustworthy now.** 74 world-map sites,
   and per mine tier: 3 spawn, 18 worker, 3 foreman, 5 ladder, 4 ramp
   workstations, plus a route network with 18 real junctions/endpoints and
   20 corridor segments (Bronze/Gold/Uranium topology; not Silver, §3.3).
   Use these to size data structures and drive layout logic before real
   pixel coordinates exist.
3. **The route graph is a graph, not a polyline list**: `paths.network.nodes`
   are junctions/endpoints (id, pixel, percent), `paths.network.edges`
   reference two node ids and carry an ordered, simplified point list
   between them (image-percent, same convention as the nodes) — build
   adjacency/pathfinding from that shape directly rather than flattening it.
4. **`paths.stub`** is a second, small component near the entrance — decide
   at the mine-interior design stage whether it's a real spur (most likely,
   per §3.2) or noise before wiring it into navigation.
5. **Re-anchor, don't hand-adjust.** The real single-tier interior art
   already exists (`inside-mines/inside-<tier>-mine.jpg`, §4) — someone
   still needs to wire it into `art.ts`/`sceneLayout.ts` and produce a
   chrome-free map background, then either re-run this extractor's
   clustering/skeleton logic directly against that art, or otherwise
   re-derive percentages against it. Either way, re-anchor against the real
   files rather than eyeballing an adjustment to the numbers here — the
   whole point of committing the script is that a future art revision
   reruns it instead of re-deriving coordinates by hand.

---

## 8. Reproducing this extraction

```sh
node scripts/extract-map-coordinates.mjs <design-assets-dir> [--overlay-dir <scratch-dir>]
```

`<design-assets-dir>` is the design source's `assets/` folder (containing
`map/map-mine-spawn-points.png` and `mine/maps/mine-interior-*.png`) — never
hardcoded, and this path itself must never be committed anywhere (see
`skills/privacy-guard/SKILL.md`). `--overlay-dir`, if given, writes the three
validation PNGs described in §5 — point it at a scratch directory, never
into the repo, since they are re-renders of gitignored source art.

No new dependency: PNG decode/encode uses only `node:zlib` (§1.1); marker
and route extraction is pure JS math (`scripts/mapCoords/cluster.mjs`,
`scripts/mapCoords/skeleton.mjs`), both covered by
`scripts/mapCoords/*.test.mjs`.

---

## 9. Files

| File                                  | Contents                                                                         |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| `docs/map-coordinates.md`             | This report                                                                      |
| `docs/map-spawn-points.json`          | 74 world-map spawn points, image-percent of the source mockup (§4)               |
| `docs/mine-interior-features.json`    | Interior markers (5 classes) + route graph, image-percent of one tier panel (§4) |
| `scripts/extract-map-coordinates.mjs` | The reproducible extractor (§8)                                                  |
| `scripts/mapCoords/png.mjs`           | From-scratch PNG codec                                                           |
| `scripts/mapCoords/cluster.mjs`       | Color-blob clustering (markers)                                                  |
| `scripts/mapCoords/skeleton.mjs`      | Thinning + graph simplification (routes)                                         |
