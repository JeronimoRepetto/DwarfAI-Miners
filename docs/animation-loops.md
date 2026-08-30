# Dwarf animation loops: what to commission, and what not to

Every active dwarf animation is a two-frame pair. Issue #61 asked whether that is the reason the
motion looks thin, whether timing is the real problem, and whether a larger hand-painted set would
be worth its cost. This is that investigation.

It is a decision document, not a change. The one measurement it could not take is the one a person
has to take: whether motion _reads_. Everything that could be measured was, and the two are kept
apart throughout — a section headed **measured** contains numbers, and a section headed **for the
owner** contains a question with no number behind it.

The headline: **three paintings, not the eight to twelve the issue's planning table contemplated.**
Two of the four loops need no new art at all and one of those needs only a timing change. The pick
loop does need paint — for a reason worse than a low frame count, and one timing cannot reach.

## How to reproduce

Every figure below came from one of four instruments. None of them is left in the tree.

| What                             | How                                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Frame-pair difference            | `jimp` over the committed PNGs: alpha masks at a 128 cutoff, colour deltas above a 24-unit noise floor, per-band and per-pixel  |
| Installer delta                  | `electron-builder --win nsis --x64` three times, against `out/renderer/assets` seeded with cost proxies                         |
| Load, decode and renderer memory | A hidden Electron `BrowserWindow` over `file://`, `performance.now()` around `Image`/`createImageBitmap`, `app.getAppMetrics()` |
| Renderer cost at 2 vs 4 frames   | `webContents.debugger` `Performance.getMetrics` over repeated 30 s A/B/A/B windows                                              |

The measurement machine is the same one `docs/performance.md` used: Windows 11 Pro 26200, Node
24.11.1, Electron 44 — **at a device pixel ratio of 1**, which is why the HiDPI row below is
arithmetic rather than observed.

The simulated valley was run at seed `anim-61`. What it contributed is stated in
[Crowding](#crowding-what-the-simulator-actually-guarantees), including what it did not.

## The baseline, verified rather than restated

Nine poses ship, all 507&times;512 RGBA8 PNGs under `src/renderer/src/assets/art/`:

| File                      |         Bytes |
| ------------------------- | ------------: |
| `dwarf-foreman-idle.png`  |       174 239 |
| `dwarf-pick-1.png`        |       182 870 |
| `dwarf-walk-1.png`        |       192 150 |
| `dwarf-foreman-check.png` |       195 466 |
| `dwarf-walk-2.png`        |       200 279 |
| `dwarf-idle.png`          |       201 393 |
| `dwarf-rest-1.png`        |       202 040 |
| `dwarf-rest-2.png`        |       203 807 |
| `dwarf-pick-2.png`        |       204 718 |
| **Nine frames**           | **1 756 962** |

Mean 195 218 bytes. The issue's "about 195 KB average" is **correct** as stated, in decimal
kilobytes; in binary units it is 190.6 KiB, which is where a cross-check would otherwise disagree
with it by 2%.

Those nine poses drive four running loops plus two still ones (`presentation.ts`):

| Loop                            | Frames                          | Hold    | Cycle  | Swaps/min |
| ------------------------------- | ------------------------------- | ------- | ------ | --------: |
| Working, worker                 | `pick-1`, `pick-2`              | 550 ms  | 1.10 s |       109 |
| Working, foreman                | `foreman-idle`, `foreman-check` | 1000 ms | 2.00 s |        60 |
| Waiting, either rank            | `rest-1`, `rest-2`              | 1400 ms | 2.80 s |        43 |
| Walking or leaving, either rank | `walk-1`, `walk-2`              | 350 ms  | 0.70 s |       171 |
| Silent worker (#47)             | `idle`                          | —       | —      |         0 |
| Silent foreman (#47)            | `foreman-idle`                  | —       | —      |         0 |

Two structural facts about the renderer matter to everything below, and neither is a defect:

- **`DwarfAnimation.frameMs` is one number for the whole loop.** `DwarfSprite` turns it into a
  single `setInterval`. Asymmetric holds are therefore not something the renderer can currently
  express — testing them at all needs a code change first, which is why the timing experiment
  below was run outside the app.
- **A loop of fewer than two frames starts no timer**, so the silence poses cost nothing to draw.

## The frame count is not the interesting number

The issue frames the question as "two frames versus four". Measuring the committed pairs says the
frame _count_ is the wrong axis: the four loops differ enormously in how far apart their two
paintings are, and that — not the count — is what decides whether a loop has a motion problem and
what kind.

Silhouette IoU is the share of the character's outline the two frames have in common (`alpha ≥ 128`
in both, over `alpha ≥ 128` in either). The band columns are the share of each band's ink that
differs, splitting the 512 px canvas at 30% and 65%, which lands on helmet / torso-and-arms /
legs-and-boots for every pose.

**Measured.**

| Loop                 | Silhouette IoU |  Head | Torso |  Legs | Centre of mass | Top of helmet |
| -------------------- | -------------: | ----: | ----: | ----: | -------------: | ------------: |
| Pick                 |      **0.406** | 95.5% | 82.7% | 92.6% |          51 px |     **70 px** |
| Foreman check        |          0.835 |  1.0% | 37.2% | 14.8% |          22 px |          0 px |
| Walk                 |          0.922 |  0.6% |  0.3% | 32.8% |         2.9 px |          0 px |
| Rest                 |      **0.994** |  6.2% |  1.2% |  0.1% |         1.2 px |          0 px |
| _`idle` vs `pick-1`_ |        _0.677_ |   _—_ |   _—_ |   _—_ |        _16 px_ |       _12 px_ |

The last row is a control: two poses that are **not** a loop and were never painted as one. The
pick pair is further apart than the control. Nothing else in the table comes close to it.

Rendering the difference masks makes the same point without arithmetic:

- **Pick** — no part of the figure is unchanged. Stance, height, facing and silhouette all move at
  once. This is a cut between two drawings, not two frames of a swing.
- **Foreman check** — head, legs and stance hold still; one arm swings the log book up to reading
  height, adding 11.1% ink. This is what a two-frame gesture is supposed to look like.
- **Walk** — head, torso, arms and pick are frozen to within noise. The entire difference is one
  boot nudged and a burst of kicked debris appearing beside it. The back leg does not move and the
  helmet does not rise or fall, so there is no stride and no bob.
- **Rest** — the pose does not change at all. Frame 2 adds a painted **z** over the helmet and
  repaints a little around the closed eye.

The rest finding has a consequence nobody was looking for: `DwarfSprite` **also** renders a CSS
`z z z` that floats up off any waiting dwarf. A sleeping dwarf therefore carries two independent
sleep indicators, one painted and one drawn, on the same sprite.

## Timing alone: what it can and cannot buy

The issue is right that a faster timer over the same two images adds no motion information. The
open question was whether _uneven_ timing does. It is a different question, and the answer differs
per loop — but it follows from the table above rather than from taste.

Apparent motion between two stills is inferred, and the inference needs correspondence: the eye has
to be able to match parts of frame 1 to parts of frame 2. Hold length changes the perceived
_speed_ of whatever motion is inferred; it cannot create a correspondence that is not there. So:

- Where the two frames share most of their outline and one part moves — the **foreman**, IoU 0.835,
  a single arm arc — the correspondence is strong, and hold length is genuinely expressive. A 50/50
  hold means he spends exactly half of his life staring at the log book. A long-then-short hold
  turns the same two paintings into a foreman who _glances_ at it. That is a real improvement for
  the price of two numbers.
- Where nothing corresponds because nothing moved — the **walk** and the **rest** — there is no
  motion to speed up or slow down. Timing cannot manufacture a stride.
- Where everything moves at once — the **pick** — there is no correspondence to read either, for
  the opposite reason. A short hold on the struck pose makes the cut _brief_; it does not make it
  a swing. No hold pattern puts anything between a raised helmet and one 70 px lower.

**For the owner.** The reasoning above predicts which loops timing helps; it does not prove the
result is pleasant. These are the hold pairs worth seeing before deciding — the first of each is
what ships today, and each plays the committed frames unchanged:

| Loop    | Ships today | Candidate  | Candidate  |
| ------- | ----------- | ---------- | ---------- |
| Pick    | 550 / 550   | 800 / 300  | 900 / 170  |
| Walk    | 350 / 350   | 480 / 220  | 220 / 220  |
| Rest    | 1400 / 1400 | 2400 / 600 | 3000 / 900 |
| Foreman | 1000 / 1000 | 2600 / 800 | 4200 / 700 |

Judge them at 100 px first — that is how big a dwarf is in the default panel — then at 45 px, which
is how small he gets. The specific things to look at:

1. **Pick** — does _any_ hold pattern read as one dwarf swinging, rather than two taking turns?
2. **Walk** — with the back leg static, does he read as walking, or as a standing painting being
   slid across the floor by the scene's transition?
3. **Rest** — is a **z** that is on half the time reading as breathing, or as an indicator light?
4. **Foreman** — at the long-hold preset, does he read as glancing at his book now and then?

If the answer to 1 is "no", the pick loop needs paint and this document's recommendation stands. If
it is somehow "yes", the whole commission collapses to nothing, which is the outcome worth checking
for first.

## What a commission would actually cost

All four cost axes were measured rather than projected from the issue's table.

### Package: about 190 KiB per frame, and it does not compress

Vite copies the PNGs into `out/renderer/assets` byte for byte — no recompression — so a shipped
frame weighs exactly what the file weighs. Brotli at quality 11 over the nine gains **0.4%
overall**, and makes four of the nine _larger_: a PNG is already a deflate stream, and there is
nothing left in it.

**Measured**, by building the NSIS installer three times:

|                           |     Installer |            Δ | Δ per frame |    Δ % | `app.asar` |
| ------------------------- | ------------: | -----------: | ----------: | -----: | ---------: |
| Baseline, 9 frames        | 118 356 739 B |            — |           — |      — | 20 841 521 |
| + 2 frames (pick 2→4)     | 118 740 494 B |   +383 755 B |   187.4 KiB | +0.32% | 21 229 622 |
| + 6 frames (worker loops) | 119 528 324 B | +1 171 585 B |   190.7 KiB | +0.99% | 22 028 243 |

One methodological trap is worth recording, because it produced a wrong answer first. Seeding the
bundle with **byte-identical copies** of existing frames grew the installer by 1 471 bytes for
387 588 bytes of PNG — NSIS's solid LZMA stream deduplicated them almost entirely. The numbers
above use horizontally mirrored real paintings instead: same size, palette, edge feathering and
entropy as a real frame, sharing no byte sequences with the originals. They re-encode to within 1%
of their sources, which is what makes them usable as cost stand-ins.

The absolute figures match the issue's estimate. The relative one reframes it: the installer is
112.9 MiB, overwhelmingly Electron, so **every worker loop going 2→4 is a 1% installer**.

### Decoded memory: under a third of the arithmetic, as the app actually uses it

Nine frames at 507&times;512&times;4 bytes is 8.9 MiB of RGBA, and holding all nine as explicit
`ImageBitmap`s does cost that — **12.1 MB of renderer working set, 1.34 MB per frame**, measured
over three runs.

The app does not do that. `preloadDwarfArt()` creates nine `Image`s and drops the references, and
only one frame is ever in the DOM, drawn at about 100 px. Measured the way the app actually uses
them:

| Renderer working set                   | Δ from blank |  Per frame |
| -------------------------------------- | -----------: | ---------: |
| After a `preloadDwarfArt()` equivalent |   2.5–2.7 MB | 280–300 KB |
| After drawing all nine at 100 px       |   2.5–3.0 MB | 282–337 KB |

Chromium keeps the encoded bytes and a decode sized for the draw, not a full-size bitmap. So a
frame costs **roughly its file size in memory, not five times it**, and six more frames would add
under 2 MB against a measured ~455 MB total RSS and a 600 MB budget.

### Startup: below the noise floor

`preloadDwarfArt()` fires all nine in one burst and they load in parallel.

| Measured over three runs                       |              |
| ---------------------------------------------- | -----------: |
| Wall time for all nine to load                 |   4.5–4.8 ms |
| Per image, individually                        |       4.7 ms |
| Forced full decode to a bitmap, all nine       |      12.4 ms |
| Decode resized to the drawn 96&times;100, nine | 13.7–14.4 ms |

About **1.4 ms of decode per added frame, once per run**. The first poll of every run costs 581 ms
(`docs/performance.md`), so six more frames would add 1.4% to a cost that is already the app's
worst budget breach and has nothing to do with art.

### Runtime: adding frames costs ticks, not frames

A four-frame loop at the same `frameMs` is a _slower_ animation with the same tick rate. Keeping
the swing's tempo while doubling the frames means halving the hold, which doubles the timer rate —
that, not the frame count, is the runtime cost.

**Measured**, `Performance.getMetrics` over repeated 30-second windows, sprites cycling real frames
with the same one-`setInterval`-per-sprite shape `DwarfSprite` uses:

| Sprites |    2 frames @ 550 ms |    4 frames @ 275 ms | Style recalcs | Layouts |
| ------: | -------------------: | -------------------: | ------------: | ------: |
|      12 | 0.13–0.14% of a core |      0.24% of a core |             0 |       0 |
|      40 | 0.27–0.30% of a core | 0.45–0.46% of a core |             0 |       0 |

Doubling the frame count at constant tempo costs **+0.10 points of one core at 12 sprites and
+0.18 at 40**, against a 2.5% visible-renderer budget currently sitting at 1.76%.

Note the zeros. Swapping an `img` `src` at a fixed height is a paint, not a style recalculation or
a layout — the ~50 recalcs/second `docs/performance.md` attributes to the visible panel come from
the infinite CSS keyframes (`tier-pulse`, `zzz-float`), not from frame cycling. More frames do not
touch that number.

### Crowding: what the simulator actually guarantees

`DWARFAI_SIMULATE=1` was run at seed `anim-61`. The panel's per-poll `[perf]` line is written by
the Electron child process and did not reach a piped stdout in a non-interactive shell here, so
crew counts were read from `world.ts` instead — which is better evidence, because that module is
pure and therefore exact rather than sampled.

The showcase mine (`SHOWCASE_MINE_INDEX`) holds the **full configured crew at every tick and every
seed**, defaulting to 12 including the foreman, capped at 40. That is the sprite count a mine view
must animate, and it is exactly the two rows measured above. No projection was needed.

## The conditions the answer has to hold under

**Measured** for scale, **arithmetic** for HiDPI, **read from the source** for reduced motion.

### Drawn size

A dwarf is not drawn at 512 px. `spriteHeightPx` scales him with the painting's cover scale, and
`depthScale` then applies perspective between 0.74 and 1.06.

| Panel                   | Cave box  | Sprite | With depth   | Device px @ DPR 2, no depth |
| ----------------------- | --------- | -----: | ------------ | --------------------------: |
| Minimum, 276&times;408  | 244×320   |  60 px | **45–64 px** |                      120 px |
| Authored, 460&times;600 | 428×512   | 100 px | 74–106 px    |                      200 px |
| 1000&times;1300         | 968×1212  | 228 px | 169–242 px   |                      456 px |
| 1200&times;1600         | 1168×1512 | 285 px | 211–302 px   |                      569 px |

The floor of 276&times;408 is enforced as the `BrowserWindow` minimum, so 45 px is genuinely the
smallest a dwarf is ever drawn. **That is the size any additional frame has to earn its place at.**
At 45 px tall, an intermediate swing pose is four or five pixels of arm travel.

### HiDPI

At DPR 2 the default panel asks 200 device px of a 512 px source — 2.56&times; headroom — and a
near-full-screen panel asks 569, which the source cannot cover. So 512 is **not** generous: it is
about right for the top of the panel's range and comfortable in the middle. There is no free
package saving hiding in a smaller source, which was worth checking before recommending a
commission at this resolution.

This row is arithmetic. The measurement machine reports DPR 1; no HiDPI display was available.

### Reduced motion — nothing is done, and this is the finding

`prefers-reduced-motion: reduce` is handled in four places, and handled well:

- `theme.css` neutralises **every** CSS animation and transition globally.
- `MineScene` reads the preference during setup — before the first paint, deliberately — and places
  every dwarf statically instead of walking them, zeroing walk durations.
- `DwarfSprite` hides the spark bursts, stills the drifting `z z z`, and replaces the walk-out with
  a plain dim.
- `MineMound` and `VaultChip` still their own pulses.

**The sprite's frame timer is consulted by none of it.** `prefersReducedMotion()` is never read in
`DwarfSprite`, and the `setInterval` that swaps paintings runs identically either way. So a viewer
who has asked their operating system for less movement gets a panel where every other animation has
been switched off, and the largest moving thing on screen — the dwarf himself — keeps changing
pose 109 times a minute at the vein, 60 at the log book, 43 at the rest boulder, and 171 for anyone
leaving, since `leaving` resolves to the walk cycle regardless of the preference.

This bears directly on the commission: **more frames at the same tempo make the unhandled case
strictly worse**, doubling the swap rate for exactly the viewer who asked for the opposite. It
should be fixed before any new frame lands, and it is a defect on its own terms whatever is decided
about art.

## The decision, per loop

They do not share a frame count, and they do not share a diagnosis.

### Pick — commission two frames, as a sample

The only loop that is deficient in the way the issue assumed, and worse than assumed: its two
paintings share 41% of their silhouette, less than a control pair that was never a loop. Timing
cannot bridge a 70 px drop of the helmet.

Going to four halves each gap to roughly 35 px of head travel, which is still larger than the
foreman's entire gesture — so four is a real improvement rather than a marginal one, and six is not
obviously necessary. **Commission the two in-betweens first and judge them**, which is exactly what
`CONTRIBUTING.md` asks for: settle a sample before producing a full set. Deciding between four and
six from a document, without either in hand, would be guessing.

The two new poses must sit on the same source canvas as the other nine, or the union crop in
`scripts/build-art.mjs` shifts and every existing frame jitters.

### Walk — commission one frame, and it is not the frame you would guess

The walk loop has no gait: 92% shared silhouette, a static back leg, no vertical bob, and a
difference that amounts to one boot and some kicked dust. It should be read as **one usable pose
plus a near-duplicate**, not as a two-frame cycle that needs doubling.

The cheap fix is therefore not "two more frames". It is **one** pose showing the opposite stride,
which turns the loop into a genuine alternation for the first time. A four-frame gait
(contact/passing/contact/passing) would take three, and there is no evidence yet that it is needed
for a figure drawn 45–106 px tall.

### Rest — commission nothing

99.4% shared silhouette, and the whole difference is a painted **z**. That is not a deficiency; a
sleeping dwarf is supposed to be still. Two free actions instead:

- Resolve the double **z**. The painted one and the CSS `z z z` are two indicators for one fact.
- If the painted one stays, an uneven hold turns a 50% duty square wave into a blink.

### Foreman check — commission nothing, change two numbers

The one loop whose two frames are a properly constructed gesture: a still body and a single arm arc
raising the log book. Its flaw is entirely timing — at 1000/1000 he spends half his existence
reading. A long-then-short hold is the whole fix and costs no art.

That change is blocked on a small renderer capability that does not exist yet: `frameMs` is one
number and `DwarfSprite` uses one `setInterval`. Per-frame holds need the interval to become a
chained timeout.

### Foreman waiting (#34), while the brush is out

`WAITING.foreman` still borrows the worker rest frames. This investigation says what that costs to
fix properly: since the rest pair is effectively one pose, dedicated foreman-waiting art is **one**
painting, not two. It is out of scope here and belongs to its own issue.

## What to commission, and what it costs

**Three paintings**, in one sample batch:

| Pose                     | Why                                                    |
| ------------------------ | ------------------------------------------------------ |
| Two pick in-betweens     | Settles the 4-versus-6 question with something in hand |
| One opposite-stride walk | Gives the walk loop a gait it has never had            |

Measured cost of those three, projected from the per-frame figures above:

| Axis                                 | Cost              | Against                          |
| ------------------------------------ | ----------------- | -------------------------------- |
| Installer                            | ~572 KiB (+0.50%) | 112.9 MiB today                  |
| Renderer working set                 | ~0.9 MB           | ~455 MB total RSS, 600 MB budget |
| Startup decode                       | ~4 ms, once       | a 581 ms first poll              |
| Renderer CPU, 12 sprites, tempo kept | +0.05 points ⚠️   | 1.76% of a core, 2.5% budget     |

The last row is the only projection in the table: the measured +0.10 points is for _every_ sprite
doubling its tick rate, and in the guaranteed-crowded mine six of twelve dwarfs are on the pick
loop. The other three rows are per-frame measurements multiplied by three.

Not commissioned, and deliberately: any rest frame, any foreman-check frame, the six-frame pick,
and the four-frame walk. Three of those four are refused on a measurement; the six-frame pick is
deferred pending a sample, which is a different and weaker reason, stated as such.

## Changes this implies, none of them made here

Each wants its own issue and its own failing test first. None was made on this branch, because the
timing values are the thing the owner has to see before they are chosen, and because a research
branch that quietly changes what users see is not research.

1. **Gate the sprite's frame timer on `prefersReducedMotion()`.** A defect independent of
   everything else here, and the only one that gets worse if art lands first.
2. **Let a loop carry per-frame holds.** `frameMs: number` becomes `number | readonly number[]`,
   and `DwarfSprite`'s `setInterval` becomes a chained `setTimeout`. Needed for the foreman fix and
   for any asymmetric pick timing. Note it also makes a hidden sprite's timer chain slightly more
   expensive to reason about than the single interval `docs/performance.md` measured.
3. **Resolve the two sleep indicators**, painted and CSS.

## What was not measured

Stated plainly rather than estimated:

- **Whether any of this looks better.** The central question, and the one this document is careful
  not to pretend it answered. The hold pairs above are candidates to be looked at, not verdicts.
- **HiDPI, on hardware.** The measurement machine is DPR 1. The device-pixel column is arithmetic
  from `spriteHeightPx`, not a photograph of a Retina panel.
- **Four frames of real art.** They do not exist, so the comparison the issue asked for could not
  literally be run. The 2-versus-4 numbers above are runtime and package costs measured with real
  paintings standing in for frames that have not been made; they say what four frames would _cost_,
  never how four frames would _look_.
- **The panel above 1200&times;1600.** The window has no maximum, and past that width the 512 px
  source is being upscaled. Nobody has looked at it there.
- **macOS and Linux.** Every figure is from the Windows host. Nothing measured here is obviously
  platform-dependent, but nothing was checked.
- **Whether the art pipeline could produce smaller frames at the same quality.** The frames are
  incompressible as PNGs and the source resolution is justified, but no palette quantisation or
  alternative encoder was tried. If a commission ever grows past a handful of frames, that is the
  thing to measure next.
