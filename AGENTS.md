# DwarfAI-Miners — notes for agents

A floating Electron panel that shows AI coding sessions running on this machine as dwarfs working
in mines. Vue renderer, TypeScript throughout, vitest.

[`CONTRIBUTING.md`](CONTRIBUTING.md) is the contributor guide: setup, the checks CI runs, PR
workflow, the art pipeline, and what the project has decided **not** to build. Read it, and do not
expect it repeated here. This file carries only what an agent gets wrong that a human contributor
does not — mostly things that have already gone wrong at least once.

## How to use this file

- **This file is the single source of truth.** `CLAUDE.md` is three lines that import it; every
  other tool reads this file directly. Nothing here is duplicated anywhere else.
- **Read it at runtime; do not memorise paths.** The `src/` tree is being regrouped under issue
  #49, so modules are named by basename here rather than by path wherever that is enough to find
  them.
- **The two tables below are generated** from the skills' own frontmatter by
  `node skills/skill-sync/assets/sync.mjs`. Never hand-edit anything between a
  `BEGIN GENERATED` marker and its `END GENERATED` marker.
- [`skills/README.md`](skills/README.md) is the spec for the skills system itself.

## Skills

<!-- BEGIN GENERATED: skill-catalogue -->

| Skill                                                  | What it covers                                                                                                                      |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| [`config-layering`](skills/config-layering/SKILL.md)   | The three configuration layers, why a packaged app never sees .env, and the deliberate split between a bad shape and a bad value    |
| [`platform-ports`](skills/platform-ports/SKILL.md)     | How per-OS behaviour is isolated behind ports so that macOS and Linux assertions run on a Windows host                              |
| [`privacy-guard`](skills/privacy-guard/SKILL.md)       | Keeping machine-specific identifiers out of tracked files, and the CI step that fails the build when one gets in                    |
| [`release`](skills/release/SKILL.md)                   | How an installer release is actually cut — pushing a v-prefixed tag — and the traps in the workflow that do the building            |
| [`simulated-valley`](skills/simulated-valley/SKILL.md) | The development-only simulated provider, for seeing the panel under load without launching real agent sessions                      |
| [`skill-creator`](skills/skill-creator/SKILL.md)       | How to add, change or retire a skill in this repository, and how to decide whether one is warranted at all                          |
| [`skill-sync`](skills/skill-sync/SKILL.md)             | Regenerating the skill catalogue and the imperative auto-invoke table in AGENTS.md from skill frontmatter                           |
| [`tdd`](skills/tdd/SKILL.md)                           | The test-first workflow this repo holds agents to, and the house idioms for writing a test that belongs here                        |
| [`test-safety`](skills/test-safety/SKILL.md)           | Preserving tests that already exist — a test file you did not create is append-and-amend only, and every removal is stated out loud |

<!-- END GENERATED: skill-catalogue -->

### Auto-invoke Skills

A `Trigger:` clause inside a skill is advisory, and advisory text loses to your default approach.
This table is the imperative form, and it is the one that binds.

<!-- BEGIN GENERATED: auto-invoke -->

| When you are about to…                                    | ALWAYS invoke this skill first                         |
| --------------------------------------------------------- | ------------------------------------------------------ |
| adding behaviour that differs per operating system        | [`platform-ports`](skills/platform-ports/SKILL.md)     |
| adding or changing a configuration setting                | [`config-layering`](skills/config-layering/SKILL.md)   |
| adding or changing a skill under skills/                  | [`skill-creator`](skills/skill-creator/SKILL.md)       |
| adding or editing a test fixture                          | [`privacy-guard`](skills/privacy-guard/SKILL.md)       |
| changing an existing test file                            | [`test-safety`](skills/test-safety/SKILL.md)           |
| changing packaging or the release workflow                | [`release`](skills/release/SKILL.md)                   |
| committing a screenshot or a captured terminal transcript | [`privacy-guard`](skills/privacy-guard/SKILL.md)       |
| cutting a release or publishing installers                | [`release`](skills/release/SKILL.md)                   |
| deleting or replacing a test                              | [`test-safety`](skills/test-safety/SKILL.md)           |
| documenting a configuration option                        | [`config-layering`](skills/config-layering/SKILL.md)   |
| finishing a change under skills/                          | [`skill-sync`](skills/skill-sync/SKILL.md)             |
| fixing a bug                                              | [`tdd`](skills/tdd/SKILL.md)                           |
| fixing a skill that is missing from a table in AGENTS.md  | [`skill-sync`](skills/skill-sync/SKILL.md)             |
| implementing a behaviour change                           | [`tdd`](skills/tdd/SKILL.md)                           |
| making a failing test pass                                | [`tdd`](skills/tdd/SKILL.md)                           |
| reading process.platform or shelling out to an OS command | [`platform-ports`](skills/platform-ports/SKILL.md)     |
| reporting that a change with tests is finished            | [`test-safety`](skills/test-safety/SKILL.md)           |
| reproducing a layout limit that needs many sessions       | [`simulated-valley`](skills/simulated-valley/SKILL.md) |
| verifying visual or performance behaviour at scale        | [`simulated-valley`](skills/simulated-valley/SKILL.md) |
| writing a path, hostname or username into a tracked file  | [`privacy-guard`](skills/privacy-guard/SKILL.md)       |
| writing down a rule an agent keeps getting wrong          | [`skill-creator`](skills/skill-creator/SKILL.md)       |

<!-- END GENERATED: auto-invoke -->

## Path-scoped rules

`.claude/rules/coordinates.md` loads automatically when you open one of the scene or map layout
files. It is a rule rather than a skill on purpose: you cannot add a point to either file without
reading it first, so a read-triggered rule reaches the failure in time.

Be aware of the limit of that mechanism. **A path-scoped rule fires when a matching file is read,
never before a write.** Anything that must survive a blind `Write` to a file you never opened has
to be a skill instead — which is exactly why test preservation is one.

## Rules with a scar behind them

**One writer per zone.** Several agents work this repository at once with disjoint file surfaces
agreed up front. Stage, revert and edit only files in your own zone. If a file you need is being
changed by someone else, say so and stop — do not "fix" it in passing. `git status` in this repo
routinely shows other agents' work in flight; none of it is yours.

**Verify against what CI will see.** A working tree in this repo often holds other agents'
uncommitted changes, so a check you ran locally may have been run against a tree nobody will ever
commit. When a build is red, read the name of the failing step before diagnosing anything.

## Before you report done

`CONTRIBUTING.md` lists the local checks to run; run those. Two things it does not tell you:

- **CI runs one more gate than that list, and it runs first.** A privacy guard fails the build
  before typecheck, lint, format or test get a chance. All the local checks can pass on a change
  that goes red — see [`privacy-guard`](skills/privacy-guard/SKILL.md).
- **Report the per-file test census** for every test file you touched, using the script in
  [`test-safety`](skills/test-safety/SKILL.md). A passing suite cannot tell you what is no longer
  in it.

## Boundaries that must survive

**`src/shared/contracts.ts` is the single declaration point for data crossing main ↔ preload ↔
renderer** — payloads, domain shapes, and the `IPC_CHANNELS` table. It must stay free of Electron
and Node imports. Two things deliberately live outside it: the API method signatures
(`DwarfAiMinersApi` in the preload entry point, surfaced through its `.d.ts`) and
`ShortcutPlatform` in `accelerator.ts`, re-exported through contracts.

Neither side imports contracts directly in most files. Each process reads it through a barrel —
`types.ts` in the main domain and in the renderer — which re-exports contracts and adds that
process's own local state types. So: **add a wire type to `contracts.ts`, then re-export it from
the barrel.** Do not let a renderer-only type into contracts, and never copy a shape across the
boundary.

Per-OS behaviour and the pure-builder/thin-runner pattern have their own skill; see
[`platform-ports`](skills/platform-ports/SKILL.md).

## Domain invariants that are easy to break by accident

Each is documented at its definition. Read the comment there before changing it — they explain the
reasoning, and this list is only the index. None of these is enforced by the type system.

- **Materials never convert into one another.** `MATERIAL_TOKENS_PER_UNIT` is a per-material grain
  size, not an exchange rate; each material owns an independent counter. Nothing converts one into
  another and nothing sums _units_ across materials — `materialUnits()` is always per-material,
  because the grain size differs. Raw _tokens_ are a common substrate and are summed, in
  `totalMaterialTokens`. Tokens yes, units no. Three renderer tests pin this; no main-process test
  does.
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

Comments state the constraint and the _why_ — never what the next line does. Match the existing
register rather than inventing one: `contracts.ts`, `reaction.ts` and `sceneGeometry.ts` are good
samples to read before writing any.

## Commits

Conventional commits, imperative mood, no AI attribution trailers of any kind — see
`CONTRIBUTING.md`. One convention it does not state: the subject says what the change achieves in
plain language and ends with its issue number. 52 of the last 60 commits do this.

```
fix(vault): never credit ore from a tier that is still a guess (#41)
```

**Commit bodies are the best documentation in this repository.** Several decisions are explained
in a commit body and nowhere else. When a document and the history disagree, the history is
usually right — `git log --format='%B' -n 20` before trusting a claim you cannot verify in code.

## The tree

_Still to be written._ The issue #49 regrouping landed in `ae9890c` while this file was being
drafted, so the map belongs here next: one line per group saying what the group is _for_, plus the
rule that decides where the next new file goes. Keep it short — this file is budgeted under 200
lines because adherence drops as it grows, and a directory listing is the first thing worth cutting
when a reader can always run `git ls-files`.

## Verified versus assumed

Everything above was checked against the code, in the spirit of the README's support matrix. Three
notes on confidence:

- The rules in "a scar behind them" are history, not theory — each one names the incident or the
  enforcement that produced it.
- The domain invariants are enforced by comments and regression tests, not by types. `tierOf` vs
  `knownTierOf` in particular type-checks either way. Treat them as rules you must hold, not rails
  that will catch you.
- Claims here have been wrong before. Writing this harness found a rule file that had inherited an
  inaccurate claim from a source comment, and several remembered details off by more than a little.
  Verify before you restate, and prefer "three call sites (four occurrences)" to "about three".
