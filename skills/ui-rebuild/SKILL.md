---
name: ui-rebuild
description: >
  The generated, read-only design docs behind the interface rebuild, the reading route through
  them, and the decisions resolved there that code must not reopen.
  Trigger: implementing or styling any screen, panel or component of the redesigned UI.
license: MIT
metadata:
  author: JeronimoRepetto
  version: '2.0'
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
— surface it in the PR or issue. `foundations.md` adds that where it and the product disagree,
the product's code wins until the difference is ruled on.

## Decisions already resolved — do not reopen them in code

Each is recorded in `foundations.md` or `decisions.md`.

- Tier order is **Bronze, Copper, Silver, Gold, Uranium** — the canonical order of the tier
  tokens.
- **`Copper` is the UI label** for the second tier, by maintainer ruling (#165, 2026-09-03). The
  generated docs still list "Cropper" as an open question inherited from the retired source; the
  app, the prototype and the `--tier-copper` token all say `Copper`. Never restore `Cropper`.
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
- A permission offers exactly **Allow and Deny**, in that order. UI copy is English.

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

## Getting it wrong

- Editing a file under `docs/dwarfai-miners-design/` to match the code. The next sync reverts it,
  and the design repository never learns what changed.
- Following a link or memory to `traceability.md`, `references/pages/`, `assets/` or the PDF.
  They are gone from the generated docs; building from the archived v4 source ships decisions the
  redesign has since replaced, 12px radius first among them.
- Shipping a **Proposal** value as if it were Decided because it has a hex code beside it.
- "Restoring" `Cropper` in copy, tests or fixtures because the generated docs still list it as a
  question (#165).
- Hardcoding `#d19831` and friends inline across components, so a palette correction becomes a
  repo-wide hunt instead of one token edit.

## References

All of these live **outside version control**, in the maintainer's main checkout only; the links
resolve there and nowhere else. If they are missing, ask — do not proceed without them.

- [`docs/dwarfai-miners-design/README.md`](../../docs/dwarfai-miners-design/README.md) — the routing map
- [`docs/dwarfai-miners-design/foundations.md`](../../docs/dwarfai-miners-design/foundations.md) — tokens, type, spacing, shape
- [`docs/dwarfai-miners-design/components.md`](../../docs/dwarfai-miners-design/components.md) — shared parts
- [`docs/dwarfai-miners-design/decisions.md`](../../docs/dwarfai-miners-design/decisions.md) — the binding decision log
