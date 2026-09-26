---
name: ui-rebuild
description: >
  The generated, read-only design docs behind the interface rebuild, the reading route through
  them, and the decisions resolved there that code must not reopen.
  Trigger: implementing or styling any screen, panel or component of the redesigned UI.
license: MIT
metadata:
  author: JeronimoRepetto
  version: '2.3'
  scope: [root]
  auto_invoke:
    - 'implementing a screen, panel or component of the redesigned UI'
    - 'styling renderer UI with colors, typography, spacing or borders'
    - 'adding art, icons or sprite assets for the new interface'
    - 'writing or running a golden UI test'
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
  memory or taste, do not copy or link the folder into the worktree, and never write its local
  path into a tracked file ([`privacy-guard`](../privacy-guard/SKILL.md)).
- **No reference images either.** Every state's PNG lives only in the design repository's
  `docs/reference/` — never copy, commit or link one here, screenshot included (PO ruling,
  2026-09-26). Ask the maintainer to compare a build against one (Accepting a built piece, below).

| Building                                  | Read first                                                                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Anything                                  | `README.md` — the routing map and the read-only rule                                                                                                                                                   |
| Anything visual                           | `foundations.md` — tokens, materials, type, spacing, shape, icons, attention                                                                                                                           |
| A shared part                             | `components.md` — every component's states, its public constructor, options and methods, "Shown when" rules, anatomy, accessibility, and its drawn and minimum widths with container conflicts flagged |
| Anything already argued                   | `decisions.md` — the binding decision log                                                                                                                                                              |
| One screen                                | `screens/{shell,browse,mine,message,map,settings,launch}.md`                                                                                                                                           |
| A mode or a hidden guild area             | `screens/{veta,valle}.md`, `screens/{lab,market,laboral-union}.md`                                                                                                                                     |
| History                                   | `screens/mine.md` — there is no separate history screen                                                                                                                                                |
| Motion, sound, focus and keyboard, or art | `motion.md` (the transitions table, and the CSS it writes at run time), `sound.md`, `accessibility.md`, `art-bible.md`                                                                                 |
| Text, per-OS behaviour, or porting        | `copy.md` (every UI string, and the whole templates built at run time with named `{value}` slots), `platforms.md`, `handoff.md` — where each token and component lives now                             |
| Why the redesign exists                   | `brief.md`                                                                                                                                                                                             |

## Status words

Every rule in the docs carries one (`docs/README.md` defines them). **Decided** is binding.
**Proposal** is the design system's recommendation awaiting a ruling. **Question** is open.
**Implementation** is developer guidance — a rename, a measurement, a check in the app code — and
awaits no design ruling. **Planned** is an agreed asset not drawn or sourced yet. **Missing** is an
asset that does not exist and has no plan recorded. Implement Decided, Implementation and Planned
rows; for a Proposal or a Question, implement nothing silently — see Accepting a built piece below
for what to do instead. Where the docs and today's code disagree, **the docs win**: the decision
log is binding for the redesign, and today's code is the baseline only where the docs say nothing.

## Accepting a built piece

The PO's acceptance rule, checked against the state's reference image captured under the
documented conditions (`docs/README.md`, "Reference images"): the same size, **under 1%** of
pixels differing, and **no 3×3 (or larger) cluster** of differing pixels anywhere. The maintainer
runs `tools/compare-ref.js` in the design repository, which checks exactly those two and prints
`PASS` or `FAIL`. The third half is never pixels: **no silent guess**. When a value or behaviour
the state needs is not in the docs, do not assume it — write down the question, the assumption
you would otherwise make, and where it applies, and ask the maintainer; the designer rules on it
in the design repository, which regenerates the docs. A guess shipped as if it were documented
fails acceptance even at a perfect pixel score.

App issue #634's golden UI tests apply this rule in code, but run only on the maintainer's
machine, against the private references — CI never runs them, because the references never leave
the design repository.

## Golden first

App issue #634's goldens (`pnpm test:golden`, `scripts/golden/`) apply that rule in code. For a
state you rebuild: add its golden first and watch it fail, build it from the Markdown, then watch it
pass — never tune the component or the stage until the pixels agree. The harness only counts once
its loopback passes: a reference shown as a plain image must capture back at 0%, with the recorded
browser build. Nothing of the design enters this repository to make a golden work — no image, no
sample data, no kit CSS; the run reads them from the design repository, and state ids such as
`organisms/nav#default` are the only design text a test may carry. In a worktree, run
`pnpm golden:design` first for a real copy in `.design/`; never link one in. Goldens are one
renderer's pixel baseline: they say nothing about macOS or Linux behaviour. `CONTRIBUTING.md`
("Golden UI tests") has the fail-versus-skip rule and where output goes.

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
from: how every component looks, every state, and how every transition moves. Ask the maintainer
for access and replicate its behaviour, rather than eyeballing a screenshot.

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
- Filling a gap with a guess instead of a question: it can pass a pixel compare and still fail
  acceptance. Copying, committing or linking a reference image here fails the same rule, even for
  a screenshot meant to illustrate a PR comment.

## References

All of these live **outside version control**, in the maintainer's main checkout only; the links
resolve there and nowhere else. If they are missing, ask — do not proceed without them.

- [`docs/dwarfai-miners-design/README.md`](../../docs/dwarfai-miners-design/README.md) — the routing map
- [`docs/dwarfai-miners-design/foundations.md`](../../docs/dwarfai-miners-design/foundations.md) — tokens, type, spacing, shape
- [`docs/dwarfai-miners-design/components.md`](../../docs/dwarfai-miners-design/components.md) — shared parts
- [`docs/dwarfai-miners-design/decisions.md`](../../docs/dwarfai-miners-design/decisions.md) — the binding decision log
