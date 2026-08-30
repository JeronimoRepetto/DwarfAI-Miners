# DwarfAI-Miners — notes for agents

A floating Electron panel that shows AI coding sessions running on this machine as dwarfs
working in mines. Vue renderer, TypeScript throughout, vitest.

[`CONTRIBUTING.md`](CONTRIBUTING.md) is the contributor guide: setup, the five checks CI runs,
PR workflow, the art pipeline, and what the project has decided **not** to build. Read it, and
do not expect it repeated here. This file carries only what an agent gets wrong that a human
contributor does not — mostly things that have already gone wrong at least once.

## Rules with a scar behind them

**A test file you did not create is append-and-amend only.** An agent once used `Write` on two
existing test files and destroyed 40 committed tests belonging to three different issues. The
suite went green: it had added more than it deleted, so the total rose and the loss was
invisible. Never `Write` over an existing test file — `Edit` it. Then report the per-file
before/after count for every test file you touched:

```bash
node .claude/scripts/test-census.mjs        # working tree vs HEAD, exits 1 on any loss
```

Removing a test is still allowed — it is _silent_ removal that is banned. When a test goes
because its subject went, say so where it stood: `src/renderer/src/lib/economy.test.ts` keeps
two worked examples, each naming the issue that removed the function and the file where the
coverage now lives.

**Never weaken an expectation to make it pass.** Failing test first, watch it fail, then make
it pass. When a test resists, the test is usually right — several bugs here were found by
agents that refused to relax one.

**Never commit a path from the machine you are running on.** CI fails the build if
`Users/jeron`, `home/jeron`, `m435tr0` or `claude-multitec` appears in any tracked file
(`.github/workflows/ci.yml`, issue #32). Fixtures and defaults use `j`, `placeholder-host` and
`~/.claude-work`. An agent working on the maintainer's own machine is the most likely source of
a real username in a test fixture, which is exactly why the guard exists.

**One writer per zone.** Several agents work this repository at once with disjoint file
surfaces agreed up front. Stage, revert and edit only files in your own zone. If a file you
need is being changed by someone else, say so and stop — do not "fix" it in passing. `git
status` in this repo routinely shows other agents' work in flight; none of it is yours.

**Prove a decision that carries weight.** When a choice is load-bearing, break it deliberately
and confirm the _specific_ test that should fail does fail. Two designs that looked fine were
caught this way. Undo the break immediately.

## Boundaries that must survive

**`src/shared/contracts.ts` is the single declaration point for data crossing
main ↔ preload ↔ renderer** — payloads, domain shapes, and the `IPC_CHANNELS` table. It must
stay free of Electron and Node imports. Two things deliberately live outside it: the API method
signatures (`DwarfAiMinersApi` in `src/preload/index.ts`, surfaced to the renderer through
`src/preload/index.d.ts`) and `ShortcutPlatform` (`src/shared/accelerator.ts`, re-exported
through contracts).

Neither side imports contracts directly in most files. Each process reads it through a barrel —
`src/main/domain/types.ts` and `src/renderer/src/types.ts` — which re-export contracts and add
that process's own local state types. So: **add a wire type to `contracts.ts`, then re-export it
from the barrel.** Do not let a renderer-only type into contracts, and never copy a shape across
the boundary.

**Per-OS behaviour goes behind a port.** Focus, text delivery, process probing and autostart are
composed in `src/main/platform/platformAdapters.ts`. Everything else takes a `Platform` as a
parameter — often defaulting to `currentPlatform()` — so tests pass the OS in explicitly and
macOS and Linux assertions run on a Windows host.

Be accurate about the shape of this: the running OS is read in exactly three production places —
`currentPlatform()` in `src/main/platform/platform.ts`, and two in `src/main/index.ts` (shortcut
key names, and the platform handed to `HookChannel`). New code should add a fourth only with a
reason. `AgentRuntime` carries a comment claiming to be "the one place the operating system is
consulted"; that is true within `AgentRuntime` and false for the app — do not repeat it.

**Pure builders, thin runners.** Anything OS-specific produces a testable value — a command's
argv, a file's exact bytes — and a thin runner executes it. `src/main/textDelivery/port.ts` is
the exemplar: a pure interface whose `supportsConsoleInput` capability flag lets callers ask
"can you?" instead of "which OS?".

**Deterministic fakes, injected clocks, injected fs.** `CONTRIBUTING.md` names the fakes. The
house idioms worth copying: where a module takes a `now`, tests pass a mutable `{ now }` object
and advance it by hand (`clock.now += 601_000`); where the module owns its own timers, tests use
`vi.useFakeTimers`. Fakes are hand-written, not `vi.mock` — 2 uses in the whole suite. Vitest
globals are off, so import `describe`/`it`/`expect` explicitly, and jsdom is opt-in per file via
a `// @vitest-environment jsdom` docblock.

There is no network in any test, and the one honest exception to "no real disk" is the adapter
tests that exist to prove the real adapter works (`fsAdapter`, `sqliteAdapter`), which use a
temp dir. Everywhere else, a real path or a real timer in a unit test is a bug.

## Domain invariants that are easy to break by accident

Each of these is documented at its definition. Read the comment there before changing it — they
explain the reasoning, and this list is only the index.

- **Materials never convert into one another.** `MATERIAL_TOKENS_PER_UNIT` is a per-material
  grain size, not an exchange rate; each material owns an independent counter. Nothing converts
  one into another and nothing sums _units_ across materials — `materialUnits()` is always
  per-material, because the grain size differs. (Raw _tokens_ are a common substrate and are
  summed, in `totalMaterialTokens`. Tokens yes, units no.) See `MaterialTotals` in
  `contracts.ts` and `src/main/domain/materials.ts`.
- **Delivered and reacted are different facts.** `delivered` means the relay exited 0 and the
  message reached the session's _queue_ — not that anything acted on it. A ✓ says handed over,
  ✓✓ says the session was seen acting. When in doubt, stay pending: a marker that wrongly claims
  a reaction is worse than one admitting it saw none. See `src/renderer/src/lib/reaction.ts`.
- **A provisional tier must never seal a value.** `tierOf()` always returns a tier, falling back
  to a `'bronze'` placeholder, and is for **drawing**. `knownTierOf()` returns `undefined` until
  a mine has actually been measured, and is for anything that **records** a decision — crediting
  the ledger above all. A stale measurement still counts as known; only "never walked" is
  unknown. Nothing in the type system stops you passing the wrong one, so this is on you. See
  `src/main/tier/tierService.ts` (issue #41).
- **Claude's `pendingBackgroundAgentCount` is authoritative, and binds in both directions.** It
  is Claude Code stating how many background agents it has, so it is the answer rather than a
  lead: a count _higher_ than what is known triggers a deeper read to adopt missed launches, and
  a count _lower_ prunes surplus ones. It says how many, never which. Absence of a count is not
  a count of zero. See `src/main/providers/claude/claudeProvider.ts` (issues #36, #45).
- **Anchors: check which coordinate space the file uses.** `mapSites.ts` and `sceneLayout.ts`
  use _opposite_ conventions, on purpose. Getting this wrong slides things off their rock when
  the panel resizes. `.claude/rules/coordinates.md` loads automatically when you open one of
  those files.

## Comments

Comments state the constraint and the _why_ — never what the next line does. Match the existing
register rather than inventing one: `src/shared/contracts.ts`, `src/renderer/src/lib/reaction.ts`
and `src/renderer/src/lib/sceneGeometry.ts` are good samples to read before writing any.

## Commits

Conventional commits, imperative mood, no AI attribution trailers of any kind — see
`CONTRIBUTING.md`. One convention it does not state: the subject says what the change achieves
in plain language and ends with its issue number. 52 of the last 60 commits do this.

```
fix(vault): never credit ore from a tier that is still a guess (#41)
fix(providers): treat Claude's pending count as a hard ceiling (#45)
```

<!-- ─────────────────────────────────────────────────────────────────────────
     PLACEHOLDER — fill in after issue #49 Part 1 (the directory regrouping).
     Part 1 had not landed when this file was written, so the tree below is
     deliberately empty rather than guessed.

     What belongs here:
       1. A short map of the grouped tree — one line per group, saying what
          the group is FOR, not listing its files. Two levels under src/ is
          enough; the point is that a reader can see the shape.
       2. The rule that decides where the next new file goes. Issue #49 asks
          for this explicitly, and it is the half that keeps the tree from
          going flat again.
       3. A re-check of the paths named ABOVE in this file. Part 1 keeps
          module names and moves directories, so basenames survive but paths
          like src/renderer/src/lib/reaction.ts may not. The path globs in
          .claude/rules/coordinates.md were written as **/name.ts so they
          survive the move; the prose paths in this file were not.

     Keep it short. This file is budgeted under 200 lines because adherence
     drops as it grows, and a directory listing is the first thing worth
     cutting — a reader can always run `git ls-files`.
     ───────────────────────────────────────────────────────────────────── -->

## The tree

_To be filled in after the Part 1 regrouping lands._

## Verified versus assumed

Everything above was checked against the code on 2026-08-30, in the spirit of the README's
support matrix. Two notes on confidence:

- The rules in "a scar behind them" are history, not theory — each one names the incident or the
  enforcement that produced it.
- The domain invariants are enforced by comments and regression tests, not by types. `tierOf`
  vs `knownTierOf` in particular type-checks either way. Treat them as rules you must hold, not
  rails that will catch you.
