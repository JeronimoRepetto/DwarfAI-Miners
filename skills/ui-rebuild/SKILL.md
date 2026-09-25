---
name: ui-rebuild
description: >
  The generated, read-only design docs behind the interface rebuild, the reading route through
  them, and the decisions resolved there that code must not reopen.
  Trigger: implementing or styling any screen, panel or component of the redesigned UI.
license: MIT
metadata:
  author: JeronimoRepetto
  version: '2.1'
  scope: [root]
  auto_invoke:
    - 'implementing a screen, panel or component of the redesigned UI'
    - 'styling renderer UI with colors, typography, spacing or borders'
    - 'adding art, icons or sprite assets for the new interface'
allowed-tools: Read, Edit, Write, Glob, Grep, Bash
---

# Building the redesigned interface

The redesign's source of truth is `docs/dwarfai-miners-design/` — and it is **deliberately not
committed**. The folder is gitignored and exists only in the maintainer's main checkout, so an
agent that greps the repo finds no design and invents one.

Since 2026-09-25 the folder holds **generated Markdown**, produced from the private design
repository by that repository's own sync tool. Every file opens with a `GENERATED … DO NOT EDIT`
header naming the sources it came from. It is no longer the PDF-derived v4 source: the PDF, its
page renders, the Canva exports and the traceability index are archived in the design repository
as history only, and nothing here reads them.

## The rule

- **Read-only.** Never edit, reformat or "fix" anything under `docs/dwarfai-miners-design/`. A
  design change is made in the design repository's sources and regenerated there; a hand edit is
  overwritten by the next sync. If a doc is wrong, say so in the PR or issue.
- **Read before you write UI.** `foundations.md` first, then the screen file for what you are
  building, then `components.md` for shared parts, and `decisions.md` before reopening anything.
- **No folder, no design.** A worktree never has the folder. Ask the maintainer where the design
  docs are and read them there — do not reconstruct the design from screenshots, existing code,
  memory or taste, and do not copy or link the folder into the worktree.

| Building                                  | Read first                                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| Anything                                  | `README.md` — the routing map and the read-only rule                               |
| Anything visual                           | `foundations.md` — tokens, materials, type, spacing, shape, icons, attention       |
| A shared part                             | `components.md` — every kit component, its states, anatomy and accessibility       |
| Anything already argued                   | `decisions.md` — the binding decision log                                          |
| One screen                                | `screens/{shell,browse,mine,message,map,settings,launch}.md`                       |
| A mode or a hidden guild area             | `screens/{veta,valle}.md`, `screens/{lab,market,laboral-union}.md`                 |
| History                                   | `screens/mine.md` — there is no separate history screen                            |
| Motion, sound, focus and keyboard, or art | `motion.md`, `sound.md`, `accessibility.md`, `art-bible.md`                        |
| Text, per-OS behaviour, or porting        | `copy.md`, `platforms.md`, `handoff.md` — where each token and component lives now |
| Why the redesign exists                   | `brief.md`                                                                         |

## Status words

Every rule in the docs carries one. **Decided** is binding. **Proposal** is the design system's
recommendation awaiting a ruling. **Question** and **Verify** are open. **Missing** is an asset
that does not exist yet. Implement what is Decided; for anything else, implement nothing silently
— surface it in the PR or issue. Where the docs and today's code disagree, **the docs win**: the
decision log is binding for the redesign, and today's code is the baseline only where the docs
say nothing.

## Decisions already resolved — do not reopen them in code

Each is recorded in `foundations.md` or `decisions.md`.

- Tier order is **Bronze, Copper, Silver, Gold, Uranium** — the canonical order of the tier
  tokens.
- **`Copper` is the UI label** for the second tier, by maintainer ruling (#165). The retired v4
  source said `Cropper`; never restore it.
- **Stepped pixel corners replace the smooth 12px radius.** No `border-radius` anywhere: the
  corner is drawn with box-shadows so focus rings and drop shadows stay whole.
- **Type is four roles**: Jacquard 12 for titles only, Tiny5 for labels and never below label
  size, Pixelify Sans for small text and for everything a dwarf or the person says. Settings
  offers the presets DwarfAI, Pixel clean and Readable, plus Custom, whose per-role lists only
  hold faces that work in that role. Presets snap sizes to each face's pixel grid.
- **Spacing floor**: sibling controls never touch — at least 8px between neighbours, 6px for
  stacked nav slots and vertical tabs; 32px minimum targets, 40px navigation.
- **Attention ladder** has three levels — in the world, a sound once, an OS notification — and
  each is used only when the one below it cannot be seen.
- A permission's only decisions are **Allow and Deny**, in that order; "Other thing…" sends free
  text as an ordinary message on held sessions only, and the request renders in the code face.
  UI copy is English.
- **Motion** animates only `transform` and `opacity`, never a window's bounds, and every awaited
  motion goes through the app's bounded runner (`boundedMotion.ts`). Pass the anti-flicker
  checklist in `motion.md` before review; its transitions table gives each sequence, duration
  and easing.
- **Sprites** are 36×38 and play **per-action frame times** read from the Aseprite JSON sidecar,
  never a flat 100ms. Under reduced motion the dwarfs keep moving at 200ms a frame while the
  shell's own motion stops. The art sources and their tag names are in `art-bible.md`.

## The prototype is the visual reference

The design repository also holds the clickable prototype and the UI kit the docs were generated
from: how every component looks, every state, and how every transition moves. When a doc leaves
you guessing, ask the maintainer for access and replicate the prototype's behaviour — never
eyeball a screenshot. A gap the docs do not cover is reported in the PR or issue, not filled.

## Boundaries the rebuild does not get to break

- New wire state crosses processes only through `src/shared/contracts.ts`, re-exported by both
  barrels — the boundary section in [`AGENTS.md`](../../AGENTS.md) is the contract.
- `renderer/src/components/` stays thin; framework-agnostic logic goes to `renderer/src/lib/`.
- The map and mine-interior art stay untouched, and their spawn points, work points and passable
  paths are not machine-readable in the design docs. Deriving them is its own task, and the
  coordinate-space rule in `.claude/rules/coordinates.md` still binds — the map and the cave use
  opposite conventions on purpose.
- Colors, sizes and thresholds from `foundations.md` become named tokens or constants, not hex
  and px literals scattered per component.
- Verify layout under many sessions with the `simulated-valley` skill before claiming a screen
  works at scale.
- **Parity with today's behaviour comes from the code.** Settings rows, labels, hints and
  behaviour are copied from reading today's Vue component for that feature, never from a summary
  or an inventory: built from summaries, the prototype lost Settings rows twice.

## Getting it wrong

- Editing a file under `docs/dwarfai-miners-design/` to match the code. The next sync reverts it,
  and the design repository never learns what changed.
- Following a link or memory to `traceability.md`, `references/pages/`, `assets/` or the PDF.
  They are gone from the generated docs; building from the archived v4 source ships decisions the
  redesign has since replaced, 12px radius first among them.
- Shipping a **Proposal** value as if it were Decided because it has a hex code beside it.
- "Restoring" `Cropper` in copy, tests or fixtures because the retired v4 source used it (#165).
- Keeping the uniform 100ms sprite timing, or freezing the dwarfs under reduced motion.
- Hardcoding `#d19831` and friends inline across components, so a palette correction becomes a
  repo-wide hunt instead of one token edit.

## References

All of these live **outside version control**, in the maintainer's main checkout only; the links
resolve there and nowhere else. If they are missing, ask — do not proceed without them.

- [`docs/dwarfai-miners-design/README.md`](../../docs/dwarfai-miners-design/README.md) — the routing map
- [`docs/dwarfai-miners-design/foundations.md`](../../docs/dwarfai-miners-design/foundations.md) — tokens, type, spacing, shape
- [`docs/dwarfai-miners-design/components.md`](../../docs/dwarfai-miners-design/components.md) — shared parts
- [`docs/dwarfai-miners-design/decisions.md`](../../docs/dwarfai-miners-design/decisions.md) — the binding decision log
