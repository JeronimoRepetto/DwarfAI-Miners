---
name: ui-rebuild
description: >
  The local design source behind the interface rebuild, the reading route through it, and the
  source corrections already resolved there that code must not reopen.
  Trigger: implementing or styling any screen, panel or component of the redesigned UI.
license: MIT
metadata:
  author: JeronimoRepetto
  version: '1.0'
  scope: [root]
  auto_invoke:
    - 'implementing a screen, panel or component of the redesigned UI'
    - 'styling renderer UI with colors, typography, spacing or borders'
    - 'adding art, icons or sprite assets for the new interface'
allowed-tools: Read, Edit, Write, Glob, Grep, Bash
---

# Building the redesigned interface

The redesign's source of truth is `docs/dwarfai-miners-design/` — and it is **deliberately not
committed**. The design PDF and its verified Canva exports stay out of the repository (the UI
branch gitignores the folder), so an agent that greps the repo finds no design and invents one,
and an agent that reads the PDF directly trusts visuals the documentation has already corrected.

## The rule

Read `docs/dwarfai-miners-design/foundations.md` before writing any renderer UI, then the screen
file for what you are building, then `components.md` for shared parts. If the folder does not
exist on this machine, **stop and ask the maintainer for it** — do not reconstruct the design
from screenshots, existing code, memory or taste.

| Building                                                  | Read first                                                      |
| --------------------------------------------------------- | --------------------------------------------------------------- |
| Anything visual                                           | `foundations.md` — tokens, tiers, typography, spacing, motion   |
| One screen                                                | `screens/{shell,map,browse,mine,launch,settings,lab,market}.md` |
| A shared part (rail, cards, chips, modals, message panel) | `components.md`                                                 |
| Against PDF evidence                                      | `traceability.md`, then `references/pages/page-NN-*.png`        |
| With exported art                                         | `assets/README.md` and `assets/expected-assets.json`            |

## Decisions already resolved — do not reopen them in code

Each of these is recorded in `foundations.md` with its reasoning. Re-deriving any of them from
the PDF's pages produces the wrong answer.

- Tier order is **Bronze, Copper, Silver, Gold, Uranium**, with fixed non-overlapping
  thresholds. Some PDF and Canva comparisons draw the copper panel before Bronze; that ordering
  is presentation, not product.
- **`Copper` is the confirmed UI label** for the copper/Cobre tier — by maintainer ruling
  (#165, 2026-09-03), REVERSING what this file used to pin here. This bullet used to call
  `Cropper` the confirmed label and "not a typo to fix," on the design source's own claim that
  the misspelling was intentional; the maintainer withdrew that claim outright — it was never
  meant to survive, and the English word is `Copper`. `foundations.md`'s corrections table is
  what the maintainer is amending to match this — read it as the thing that was wrong, never as
  grounds for restoring `Cropper`.
- `Rigth` in the PDF is a source typo. Ship `Right`.
- Red rectangles in Canva exports are documentation callouts, never product UI.
- UI copy is English. The PDF's Spanish is narration around the screens, not UI copy.

## Unspecified means ask, not invent

The docs mark every gap explicitly as **Unspecified**: hover/focus/error/loading states, reduced
motion, breakpoints, z-index, the shadow recipe behind "elevation 5", marker hex values. Those
are product decisions — implement what is specified and surface the gap in the PR or issue,
never fill it silently. `screens/launch.md` states the PDF defines **no** agent-launch screen;
do not invent one for #86 out of this source.

## Boundaries the rebuild does not get to break

- New wire state crosses processes only through `src/shared/contracts.ts`, re-exported by both
  barrels — the boundary section in [`AGENTS.md`](../../AGENTS.md) is the contract.
- `renderer/src/components/` stays thin; framework-agnostic logic goes to `renderer/src/lib/`.
- The 74 map spawn points and the mine-interior work points and passable paths have **no
  machine-readable coordinates** in the design source. Deriving them is its own task, and the
  coordinate-space rule in `.claude/rules/coordinates.md` still binds — the map and the cave use
  opposite conventions on purpose.
- Colors, sizes and thresholds from `foundations.md` become named tokens or constants, not hex
  and px literals scattered per component.
- Verify layout under many sessions with the `simulated-valley` skill before claiming a screen
  works at scale.

## Getting it wrong

- Building a screen from a `references/pages/` render and shipping the comparison's tier order —
  the render is evidence of the source, not the resolved spec.
- "Restoring" `Cropper` in copy, tests or fixtures because a stale doc, memory, or an earlier
  revision of this very file called it the confirmed label — that ruling was reversed (#165).
  The mirror-image mistake now trips the same trap: `Copper` is what every chip, card and
  tooltip the panel actually shows, so reintroducing `Cropper` anywhere is what would disagree
  with them.
- Hardcoding `#d19831` and friends inline across components, so a palette correction becomes a
  repo-wide hunt instead of one token edit.
- Treating a red callout rectangle in an export as a border or focus state to reproduce.

## References

All of these live **outside version control** on the maintainer's machine; the links resolve
locally only. If they are missing, ask — do not proceed without them.

- [`docs/dwarfai-miners-design/README.md`](../../docs/dwarfai-miners-design/README.md) — the routing map
- [`docs/dwarfai-miners-design/foundations.md`](../../docs/dwarfai-miners-design/foundations.md) — tokens, tiers, corrections
- [`docs/dwarfai-miners-design/components.md`](../../docs/dwarfai-miners-design/components.md) — shared parts
- [`docs/dwarfai-miners-design/traceability.md`](../../docs/dwarfai-miners-design/traceability.md) — page-by-page evidence index
