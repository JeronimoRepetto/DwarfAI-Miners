# DwarfAI-Miners — notes for AI agents

A floating Electron panel that shows AI coding sessions running on this machine as dwarfs working
in mines. Vue renderer, TypeScript throughout, vitest.

[`CONTRIBUTING.md`](CONTRIBUTING.md) is the contributor guide: setup, the checks CI runs, PR
workflow, the art pipeline, and what the project has decided **not** to build. Read it, and do not
expect it repeated here. This file carries only what an agent gets wrong that a human contributor
does not — mostly things that have already gone wrong at least once.

## How to use this file

- **The single source of truth.** `CLAUDE.md` imports it; every other tool reads it directly.
- **Budgeted under 200 lines** — a new section takes one out; duplicated prose goes first.
- **Three regions are generated** by `node skills/skill-sync/assets/sync.mjs` — skill tables from
  frontmatter, the `main/` tree bullet from the filesystem. Never hand-edit inside the markers.
- [`skills/README.md`](skills/README.md) is the spec for the skills system itself.

## Skills

<!-- BEGIN GENERATED: skill-catalogue -->

| Skill                                                  | What it covers                                                                                                                                                  |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`config-layering`](skills/config-layering/SKILL.md)   | The three configuration layers, why a packaged app never sees .env, and the deliberate split between a bad shape and a bad value                                |
| [`platform-ports`](skills/platform-ports/SKILL.md)     | How per-OS behaviour is isolated behind ports so that macOS and Linux assertions run on a Windows host                                                          |
| [`privacy-guard`](skills/privacy-guard/SKILL.md)       | Keeping machine-specific identifiers out of tracked files, and the CI step that fails the build when one gets in                                                |
| [`release`](skills/release/SKILL.md)                   | How an installer release is actually cut — pushing a v-prefixed tag — and the traps in the workflow that do the building                                        |
| [`simulated-valley`](skills/simulated-valley/SKILL.md) | The development-only simulated provider, for seeing the panel under load without launching real agent sessions                                                  |
| [`skill-creator`](skills/skill-creator/SKILL.md)       | How to add, change or retire a skill in this repository, and how to decide whether one is warranted at all                                                      |
| [`skill-sync`](skills/skill-sync/SKILL.md)             | Regenerating AGENTS.md's three generated regions — the skill catalogue, the auto-invoke table, and the main/ tree bullet                                        |
| [`tdd`](skills/tdd/SKILL.md)                           | The test-first workflow this repo holds agents to, and the house idioms for writing a test that belongs here                                                    |
| [`test-safety`](skills/test-safety/SKILL.md)           | Preserving tests that already exist — a test file you did not create is append-and-amend only, and every removal is stated out loud                             |
| [`ui-rebuild`](skills/ui-rebuild/SKILL.md)             | The local design source behind the interface rebuild, the reading route through it, and the source corrections already resolved there that code must not reopen |

<!-- END GENERATED: skill-catalogue -->

### Auto-invoke Skills

A `Trigger:` clause inside a skill is advisory, and advisory text loses to your default approach.
This table is the imperative form, and it is the one that binds.

<!-- BEGIN GENERATED: auto-invoke -->

| When you are about to…                                          | ALWAYS invoke this skill first                         |
| --------------------------------------------------------------- | ------------------------------------------------------ |
| adding art, icons or sprite assets for the new interface        | [`ui-rebuild`](skills/ui-rebuild/SKILL.md)             |
| adding behaviour that differs per operating system              | [`platform-ports`](skills/platform-ports/SKILL.md)     |
| adding or changing a configuration setting                      | [`config-layering`](skills/config-layering/SKILL.md)   |
| adding or changing a skill under skills/                        | [`skill-creator`](skills/skill-creator/SKILL.md)       |
| adding or editing a test fixture                                | [`privacy-guard`](skills/privacy-guard/SKILL.md)       |
| changing an existing test file                                  | [`test-safety`](skills/test-safety/SKILL.md)           |
| changing packaging or the release workflow                      | [`release`](skills/release/SKILL.md)                   |
| committing a screenshot or a captured terminal transcript       | [`privacy-guard`](skills/privacy-guard/SKILL.md)       |
| cutting a release or publishing installers                      | [`release`](skills/release/SKILL.md)                   |
| deleting or replacing a test                                    | [`test-safety`](skills/test-safety/SKILL.md)           |
| documenting a configuration option                              | [`config-layering`](skills/config-layering/SKILL.md)   |
| finishing a change under skills/                                | [`skill-sync`](skills/skill-sync/SKILL.md)             |
| fixing a bug                                                    | [`tdd`](skills/tdd/SKILL.md)                           |
| fixing a skill that is missing from a table in AGENTS.md        | [`skill-sync`](skills/skill-sync/SKILL.md)             |
| implementing a behaviour change                                 | [`tdd`](skills/tdd/SKILL.md)                           |
| implementing a screen, panel or component of the redesigned UI  | [`ui-rebuild`](skills/ui-rebuild/SKILL.md)             |
| making a failing test pass                                      | [`tdd`](skills/tdd/SKILL.md)                           |
| reading process.platform or shelling out to an OS command       | [`platform-ports`](skills/platform-ports/SKILL.md)     |
| reporting that a change with tests is finished                  | [`test-safety`](skills/test-safety/SKILL.md)           |
| reproducing a layout limit that needs many sessions             | [`simulated-valley`](skills/simulated-valley/SKILL.md) |
| styling renderer UI with colors, typography, spacing or borders | [`ui-rebuild`](skills/ui-rebuild/SKILL.md)             |
| verifying visual or performance behaviour at scale              | [`simulated-valley`](skills/simulated-valley/SKILL.md) |
| writing a path, hostname or username into a tracked file        | [`privacy-guard`](skills/privacy-guard/SKILL.md)       |
| writing down a rule an agent keeps getting wrong                | [`skill-creator`](skills/skill-creator/SKILL.md)       |

<!-- END GENERATED: auto-invoke -->

## Path-scoped rules

`.claude/rules/coordinates.md` (Claude) and `.agent/rules/coordinates.md` (other agent tools) load
automatically when you open a scene or map layout file. A rule rather than a skill on purpose: you
cannot add a point to either file without reading it first, so it reaches the failure in time.

## Rules with a scar behind them

**One writer per zone.** Several agents work this repository at once with disjoint file surfaces
agreed up front. Stage, revert and edit only files in your own zone. If a file you need is being
changed by someone else, say so and stop — do not "fix" it in passing. `git status` in this repo
routinely shows other agents' work in flight; none of it is yours.

**Verify against what CI will see.** A working tree in this repo often holds other agents'
uncommitted changes, so a check you ran locally may have been run against a tree nobody will ever
commit. When a build is red, read the name of the failing step before diagnosing anything.

## Before you report done

Run the seven checks `CONTRIBUTING.md` lists, in CI's order — then **the per-file test census** it
does not ask for, on every test file you touched: [`test-safety`](skills/test-safety/SKILL.md).

## Boundaries that must survive

**`src/shared/contracts.ts` is the single declaration point for data crossing main ↔ preload ↔
renderer** — payloads, domain shapes, and the `IPC_CHANNELS` table. It must stay free of Electron
and Node imports. Two things deliberately live outside it: the API method signatures
(`DwarfAiMinersApi` in the preload entry point, surfaced through its `.d.ts`) and
`ShortcutPlatform` in `accelerator.ts`, re-exported through contracts.

Every file but the two IPC endpoints reads it through a barrel — `types.ts` in the main domain and
in the renderer — which re-exports contracts and adds that process's own local state types. So:
**add a wire symbol to `contracts.ts`, then re-export it from the barrel**, values as well as
types; one the barrel omits sends the whole import statement past it, not just itself (#77).
`main/index.ts` and `preload/index.ts` read it directly because they _are_ the endpoints. Do not
let a renderer-only type into contracts, and never copy a shape across the boundary.

## Domain invariants that are easy to break by accident

Each is documented at its definition. Read the comment there before changing it — they explain the
reasoning, and this list is only the index. None of these is enforced by the type system.

- **Materials never convert into one another.** `MATERIAL_TOKENS_PER_UNIT` is a per-material grain
  size, not an exchange rate; each material owns an independent counter. Nothing converts one into
  another and nothing sums _units_ across materials — `materialUnits()` is always per-material,
  because the grain size differs. Raw _tokens_ are the one substrate a sum may cross. Tokens yes,
  units no. The renderer's vault tests pin this (`lib/vault/vault.ts`); the ledger never needs the
  sum.
- **Delivered and reacted are different facts.** `delivered` means the relay exited 0 and the
  message reached the session's _queue_ — not that anything acted on it. A ✓ says handed over, ✓✓
  says the session was seen acting, and a session reads its queue between tool calls. When in
  doubt, stay pending: a marker that wrongly claims a reaction is worse than one admitting it saw
  none. Expiry decays to "handed over", never to a claimed reaction. See `reaction.ts`.
- **A provisional tier must never seal a value.** `tierOf()` always returns a tier, falling back to
  a `'bronze'` placeholder indistinguishable from a measured one, and is for **drawing**.
  `knownTierOf()` returns `undefined` until a mine has actually been measured, and is for anything
  that **records** a decision — crediting the ledger above all, where a delta sealed with the
  placeholder is wrong forever. A stale measurement still counts as known; only "never walked" is
  unknown. Nothing in the type system stops you passing the wrong one. See `tierService.ts`
  (issue #41).
- **Claude's `pendingBackgroundAgentCount` is authoritative, and binds in both directions.** It is
  Claude Code stating how many background agents it has, so it is the answer rather than a lead: a
  count _higher_ than what is known triggers a deeper read to adopt missed launches, and a count
  _lower_ prunes surplus ones. A third reading treats zero as evicting everything older than the
  tail. That deeper read takes only endings, never adoptions. It says how many, never which.
  Absence of a count is not a count of zero. See `claudeProvider.ts` (issues #36, #45).
- **Silence windows differ by who can answer, not by rank.** The long one belongs to a session a
  human can type into, never to a `foreman` — rank is topology, and a headless `claude -p` run is a
  root too. Choose only via `dwarfSilenceWindowMs`; unproven keeps the long window, `'unknown'`
  stays distinct from `'attended'`, and both windows still elapse over an idle registry status
  before anything drops. See `contracts.ts` (#47, #68).
- **Anchors: check which coordinate space the file uses.** The map and the cave use _opposite_
  conventions, on purpose. Getting this wrong slides things off their rock when the panel resizes.
  The path-scoped rule above covers it.

## Comments

Comments state the constraint and the _why_ — never what the next line does. Match the register of
`contracts.ts`, `reaction.ts` or `sceneGeometry.ts` rather than inventing one.

## Commits

Conventional commits, imperative mood, no AI attribution trailers — see `CONTRIBUTING.md`. One
unstated convention: the subject says what the change achieves and ends with its issue number.

```
fix(vault): never credit ore from a tier that is still a guess (#41)
```

**Commit bodies are the best documentation in this repository** — several decisions live only
there. When a document and the history disagree, the history is usually right: run
`git log --format='%B' -n 20` before trusting a claim you cannot verify in code.

## The tree

[`src/README.md`](src/README.md) has the path map and the filing rule in full; read it before
adding a file. This is the index — one line per group, so you can tell what a thing is _for_.

- **`shared/`** — the wire boundary: `contracts.ts`, `accelerator.ts`, `truncate.ts`,
  `externalLink.ts`. No Electron and no Node imports anywhere in it.
- **`preload/`** — the one typed API surface handed to the renderer.

<!-- BEGIN GENERATED: main-tree -->

- **`main/`** — `index.ts` is the composition root, and the only file that owns Electron's
  `ipcMain` and `globalShortcut`. Beside it, one directory per subject: `adapters` (fs and sqlite
  seams with their fakes), `appDatabase` (the one SQLite file), `config`, `domain` (pure rules and
  the type barrel), `history`, `hooks` (the opt-in Claude push channel), `ledger` (mined,
  persisted), `platform` (composed once in `platformAdapters.ts`), `projects`, `providers` (one per
  agent CLI plus the simulated one), `runtime` (the poll loop), `sessionLaunch` (starting a session
  and holding one), `shell` (window, tray, autostart, shortcuts), `textDelivery`, `tier`.

<!-- END GENERATED: main-tree -->

- **`renderer/src/`** — TWO roots, one entry: `App.vue` is the shell and `MessagePanelWindow.vue` the
  message panel's own window beside it (`lib/shell/surface.ts` picks). `components/` is thin and
  decides nothing, `lib/` framework-agnostic; `composables/` is Vue-bound state, `types.ts` the barrel.

**Where the next file goes:** name a directory for the subject it is about, never for the kind of
module it holds — `utils/`, `helpers/`, `types/` are refused on sight.

## Verified versus assumed

Everything above was checked against the code — and claims here have still been wrong: one rule
file had inherited an inaccurate claim from a source comment. Verify before you restate, and
prefer "three call sites (four occurrences)" to "about three".
