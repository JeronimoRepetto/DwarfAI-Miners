# Session topology and dwarf roles

Research for issue #62. **Nothing here is implemented.** It exists so the next backend — Gemini,
OpenCode, a local LLM — does not have to guess what `foreman` means, and so the two backends that
already ship stop disagreeing about it.

Every claim below carries the file and line it was read from, on `cc75a89`. Where the issue's own
account differs from the code, the code wins and the difference is named.

---

## 1. What the three providers do today

Three providers, three unrelated rules. The issue names two of them.

| Provider  | Rule                                                                    | Where                           |
| --------- | ----------------------------------------------------------------------- | ------------------------------- |
| Claude    | Main session is **always** `foreman`; every subagent is `worker`        | `claudeProvider.ts:532`, `:591` |
| Codex     | Every `mainDwarf` starts `worker`; a parent is **mutated** to `foreman` | `codexProvider.ts:483`, `:597`  |
| Simulated | Roster index 0 is `foreman`, everyone else `worker`                     | `world.ts:293`                  |

The simulated provider is the tell. It is not modelling topology at all — it is picking the first
element of an array — and nothing stopped it, because there is no place in the codebase where the
meaning of `foreman` is written down.

**Codex's promotion is narrower than "has a child".** `linkSubagents` (`codexProvider.ts:586-602`)
requires all four of:

1. the child's snapshot status is `busy` (`:592`),
2. a parent id from the child's own rollout head or from `thread_spawn_edges` (`:593`),
3. the parent was discovered in the **same scan** (`:595-596`),
4. and then it writes `parent.mainDwarf.role = 'foreman'` (`:597`).

So a Codex session that spawned a subagent which has since gone quiet falls back to `worker` on the
next tick. The rank flickers. That is precisely the defect Claude fixed and pinned:

> The main session is the orchestrator: it is the foreman whether or not it currently has agents
> out. Deriving the role from the headcount instead made the same dwarf swap identity mid-session.
> — `claudeProvider.ts:529-531`, pinned by `claudeProvider.test.ts:143` and `:156`

Codex is running the rule Claude already retired. It just spells the headcount as an edge.

**Where the issue's account needed tightening:** it says `linkSubagents()` promotes "when a busy
child and a real parent edge are both observed in the same scan", which is right, but it omits that
the same function is also what puts an _idle_ parent on the board at all (`:598-600`, and the
`DiscoveredCodexSnapshot.mainDwarf` comment at `:95`). An idle Codex session contributes no dwarfs
of its own — `dwarfs: busy ? [mainDwarf] : []` at `codexProvider.ts:514` — so `linkSubagents` today
carries two unrelated jobs on one line of reasoning. Any change has to keep the second one.

---

## 2. What `foreman` actually means

Three things in the tree already encode an answer, and they agree.

**The silence window.** `DWARF_SILENCE_WINDOW_MS` (`contracts.ts:108`) gives a foreman an hour and
a worker half an hour, and its comment says why:

> A FOREMAN legitimately sits idle for as long as it takes a human to type the next prompt, so its
> silence is weak evidence and gets the longer hour. A WORKER cannot wait on anyone: once launched
> it runs to completion. — `contracts.ts:100-104`

That justification is about **a human at the keyboard**, not about having children.

**The scene.** There is exactly one `post` anchor across all five tier layouts
(`sceneLayout.ts:170`; `CAVE_LAYOUT` is shared by every tier at `:220-229`), against four `vein`,
two `rest`, one `exit` and one `deposit`. `anchorKindFor` sends a foreman to it because "the
foreman does not dig" (`sceneAssignment.ts:65-66`). One post per mine means one supervisor per
mine, in the art's own vocabulary.

**The delivery vocabulary.** `foreman-relay` (`contracts.ts:124`) names _the addressable ancestor a
worker's message has to go through_. Claude sets it on every subagent, pointing at `mainDwarfId`
(`claudeProvider.ts:572-576`). A foreman, in that vocabulary, is the node that can be written to
directly.

### The semantic rule

> **A dwarf is a `foreman` when it is the root of its provider's spawn tree — the session a human
> could address directly. Everything spawned by another session is a `worker`, at any depth.**

Not "supervises children": a Claude session with zero agents out is a foreman today and must stay
one. Not a product role: nothing in the art, the anchors or the windows is Claude- or Codex-specific.

**Consequence for a top-level session with no children (issue question 2): it stays a foreman.**
Already true for Claude and pinned by two tests; the rule makes it true for everyone.

---

## 3. Topology is a fact; role is a verdict

The reason Codex has to _mutate_ `role` after the fact is that it has nowhere to put what it knows.
`Dwarf.role` is a rendering field, and `parent_thread_id` is a fact about the world, and the
provider has to launder one into the other on the way out.

This repository has solved exactly this shape once before. `tierOf()` always answers, with a
`bronze` placeholder, and is for **drawing**; `knownTierOf()` returns `undefined` until a walk has
really happened, and is for anything that **records** a decision (`tierService.ts:287-297`, issue
#41). And the `pendingBackgroundAgentCount` invariant states the other half: _absence of a count is
not a count of zero_ (`AGENTS.md`, "Domain invariants").

Applied here:

- **Topology** is what a provider observed: this node's id, and its parent's id when one was seen.
  It has three states, and `unknown` is one of them.
- **Role** is a verdict derived from topology, for drawing and for wording. It stays the binary
  union it is today.

Providers report the first. One domain function derives the second. **Yes** to both of the issue's
architectural questions (5 and 6).

---

## 4. The fallback policy

Topology is three-state, and the third state is not a synonym for either of the other two.

| State     | Meaning                                                            | Drawn as  |
| --------- | ------------------------------------------------------------------ | --------- |
| `root`    | Positively established: the provider has a signal saying no parent | `foreman` |
| `child`   | Positively established: a parent id, or a "this is a subagent" tag | `worker`  |
| `unknown` | No evidence either way                                             | `foreman` |

**Why `unknown` draws as `foreman`, not `worker`.** The two errors are not symmetric. A root wrongly
drawn as a worker gets the 30-minute window instead of the hour it needs, and the panel starts
calling a session silent while a human is simply still typing. A child wrongly drawn as a foreman
gets the hour, and the panel is slow to say something is wrong.

This repository has already chosen that side twice, and been burned on the other one:

- "When in doubt, stay pending: a marker that wrongly claims a reaction is worse than one admitting
  it saw none." (`reaction.ts`, via `AGENTS.md`)
- "Both stay generous anyway, because the opposite error is the false departure #28 exists to
  prevent." (`claudeProvider.ts:64-67`)

A false departure is the failure mode with two issues behind it (#28, #40). The generous fallback is
the consistent one.

**What `unknown` must never do is seal anything.** No consumer may record a decision from the
placeholder — the same rule `knownTierOf` exists to enforce. Today that costs nothing, because
**the main process reads `Dwarf.role` in exactly zero places** (§5); every read is in the renderer,
and every one of them draws. So the second accessor is not warranted yet, and building it now would
be building a function with no caller.

The trigger that changes that is specific, and worth writing down so it is recognised when it
arrives: **the moment anything role-derived prunes, retires or credits.** `pruneStaleLaunches`
(`claudeProvider.ts:666-688`) is the nearest candidate — it deletes a remembered launch permanently
and adds the id to `abandonedAgents`, from which nothing ever returns. It reads
`DWARF_SILENCE_WINDOW_MS.foreman` / `.worker` as **named constants against two known transcript
files** (`claudeProvider.ts:69-70`, `:677`, `:684`), never as `WINDOW[dwarf.role]`. If a normalized
model ever routes that lookup through a derived role, it needs the `undefined`-returning accessor
first, and a dwarf whose topology is unknown must be skipped rather than judged.

---

## 5. Blast-radius inventory

Counted on `cc75a89` with `git grep -o -E "'foreman'|'worker'|DwarfRole" -- 'src/**'`, plus
`git grep -n "\.role\b"` for member access.

**147 occurrences across 25 files: 28 in 11 non-test files, 119 in 14 test files.**

### Writes — 7 sites

| Site                               | What it writes                            |
| ---------------------------------- | ----------------------------------------- |
| `claudeProvider.ts:532`            | `'foreman'` — main session, unconditional |
| `claudeProvider.ts:591`            | `'worker'` — each in-flight subagent      |
| `codexProvider.ts:483`             | `'worker'` — every `mainDwarf`            |
| `codexProvider.ts:597`             | `'foreman'` — **mutation** after the fact |
| `world.ts:293`                     | roster index 0 → `'foreman'`              |
| `domain/types.ts:32`               | `defaultDwarf()` → `'worker'`             |
| `renderer/testing/factories.ts:17` | test factory → `'worker'`                 |

### Reads — 11 sites in 4 files, **all in the renderer**

`git grep -n "\.role\b\|DwarfRole\|\[role\]" -- 'src/main/**' 'src/preload/**' ':!*.test.ts'`
returns one type re-export (`domain/types.ts:13`), the Codex mutation above, and two hits on
`FeedMessage.role` in `codex/parse.ts` — an unrelated field. **No main-process code reads
`Dwarf.role` to decide anything.**

Seven of the eleven reads change an outcome:

| Site                    | Decides                                        | Kind      |
| ----------------------- | ---------------------------------------------- | --------- |
| `presentation.ts:134`   | `DWARF_SILENCE_WINDOW_MS[role]` — 60 vs 30 min | _belief_  |
| `presentation.ts:154`   | `SILENT[role]` / `WORKING[role]` frames        | drawing   |
| `presentation.ts:153`   | `WAITING[role]`                                | **inert** |
| `sceneAssignment.ts:66` | `'post'` vs `'vein'` anchor                    | drawing   |
| `DwarfTooltip.vue:14`   | the words "Foreman" / "Worker"                 | wording   |
| `DwarfSprite.vue:331`   | role name inside the aria label                | wording   |
| `DwarfSprite.vue:288`   | the `is-foreman` class                         | **dead**  |

The remaining four thread the value through without branching on it:
`presentation.ts:170` (`sceneDwarfAnimation` → `dwarfAnimation`), `sceneAssignment.ts:81`
(`assignScene` → `anchorKindFor`), `DwarfSprite.vue:248` and `:251`.

Two of the seven are worth naming out loud:

- **`WAITING[role]` decides nothing.** Both entries are `['rest-1','rest-2']` at 1400 ms
  (`presentation.ts:84-91`); the comment says dedicated foreman-waiting art is deferred. A waiting
  dwarf's animation is role-independent in fact, whatever the type says.
- **`is-foreman` is dead.** `git grep "is-foreman"` over the whole repository returns one hit — the
  line that sets it (`DwarfSprite.vue:292`). No stylesheet targets it. It looks like a role-driven
  visual and is not one.

So the true rendering blast radius of changing a dwarf's role is **three things**: which frames it
cycles, which anchor it stands on, and one word in a tooltip and an aria label. Plus one belief:
how long it may be quiet before the panel says so.

### What does **not** read role, and is worth knowing

- `aggregate.ts` — concatenates `snapshot.dwarfs` and sums tokens; no role, no hierarchy.
- `lifecycle.ts` — the arrive/leave grace tracker; no role.
- `runtime.ts`, `resolve.ts`, `port.ts` — Send and Kick route on `TextDeliveryTarget.kind`, which
  providers answer independently of role (`claudeProvider.ts:572-576`). `foreman-relay` is a _channel_,
  not a rank. **The delivery layer is already the capability-based design this document is arguing
  for**, and it needs no change.
- `ledger/`, `tier/`, `materials.ts` — nothing role-shaped.

### Test surface

119 occurrences across 14 files. Three carry the current semantics and would have to be amended
rather than passively updated:

- `claudeProvider.test.ts:143` — "keeps the main session dwarf a foreman even with no subagents"
- `claudeProvider.test.ts:156` — "keeps the main dwarf identical when its last agent finishes"
- `codexProvider.test.ts:138-154` — pins a standalone busy Codex session as `role: 'worker'`

The first two survive the proposed rule unchanged. **The third is the one that has to be amended**,
which means [`test-safety`](../skills/test-safety/SKILL.md) binds on any implementation.

---

## 6. Proposed provider contract

### On the wire — `src/shared/contracts.ts`

One optional field on `Dwarf`, and one small union. Both are plain TypeScript;
**`contracts.ts` must stay free of Electron and Node imports** (`AGENTS.md`, "Boundaries that must
survive"), and nothing proposed here needs either.

```ts
/**
 * What a provider observed about this dwarf's place in its session tree.
 *
 * Three states, because a provider that found no parent record has usually not
 * proved anything: 'root' and 'child' are both positive findings, and 'unknown'
 * is the absence of evidence — never a synonym for either (compare
 * pendingBackgroundAgentCount, which is a count and not a lead).
 *
 * A verdict for DRAWING is derived from this (see deriveRoles). Anything that
 * SEALS a decision must skip 'unknown' rather than resolve it.
 */
export type DwarfTopology = 'root' | 'child' | 'unknown'
```

added to `Dwarf` as:

```ts
  /**
   * This dwarf's place in its provider's spawn tree, as observed. Absent from
   * a provider that has not been taught to report it, which reads as 'unknown'.
   */
  topology?: DwarfTopology
  /**
   * The id of the dwarf that spawned this one, when the provider saw it —
   * always a Dwarf.id, never a raw provider session id, so one lookup crosses
   * no translation. Present only alongside topology 'child', and absent even
   * then when the parent is known to exist but was not observed (see §7,
   * "temporarily missing parent").
   */
  parentId?: string
```

`role` stays exactly as it is: `'foreman' | 'worker'`, required, and the field every renderer read
in §5 keeps using. **Do not widen the union.** §7 covers why the nested-supervisor case does not
need a third value.

Then, per `AGENTS.md`: add both names to the `export type { … }` block in
`src/main/domain/types.ts:7-24` and in `src/renderer/src/types.ts`. Neither side imports
`contracts.ts` directly.

### In the domain — a new pure module

`src/main/domain/topology.ts`, called from `poller.ts` between the scan and the aggregation
(`poller.ts:107-109`), which is the one seam where every provider's snapshots are in hand at once:

```ts
const snapshots = /* … as today … */
const rolesResolved = deriveRoles(snapshots)      // new
const mines = aggregateMines(rolesResolved, this.options.tierOf)
```

`deriveRoles` is pure and total:

- `topology === 'child'` → `'worker'`
- `topology === 'root'` → `'foreman'`
- `topology === 'unknown'` or absent → `'foreman'` (the §4 fallback)
- a `parentId` that resolves to a dwarf present in this tick is `'child'` regardless of what the
  provider said, so a provider may report the edge and let the domain conclude the rank

`parentId` must only ever be matched **within one provider's snapshots**. A Codex thread's parent is
always a Codex thread; `Dwarf.id` is already provider-prefixed (`claude:…`, `codex:…`), so this is
free, but it should be stated rather than left to the prefix.

### What providers stop doing

Providers stop deciding rank. They report what they read. `codexProvider.ts:597` — the mutation —
goes away entirely; `linkSubagents` keeps only its second job, putting an idle parent on the board
(`:598-600`), and should be renamed to say so.

---

## 7. The five cases

Snippets below are synthetic, shaped from the records documented in
[`provider-formats.md`](provider-formats.md) §1.5/§2.2 and [`codex-v2-format.md`](codex-v2-format.md).
No fixture files are added here on purpose: the implementing change writes its tests first
([`tdd`](../skills/tdd/SKILL.md)), and a fixture with no test loading it is a file that rots. The
one fixture that already covers a case is named where it does.

### Standalone root

_Codex, no SQLite. `session_meta.source` is a plain tag rather than a spawn blob._

```json
{
  "type": "session_meta",
  "payload": {
    "id": "01a0…",
    "cwd": "C:\\Users\\j\\Desktop\\Sample-Project",
    "source": "cli",
    "thread_source": "user"
  }
}
```

`parseCodexRolloutHead` (`codex/parse.ts:65-84`) already reaches for `source.subagent.thread_spawn`
and finds nothing. Today that yields `topology: 'root'` evidence and is **thrown away**, and the
dwarf renders as a worker. Under the rule: `topology: 'root'` → `foreman`.

Already fixture-backed: `__fixtures__/codex/rollout.jsonl` line 1 carries `"source":"vscode"` — a
known user-initiated tag — with no spawn blob.

_Claude:_ the equivalent evidence is that the session has a `~/.claude/sessions/<pid>.json` file at
all; per `provider-formats.md` §1.5 that is one file per live session, and `kind` names it
`interactive` or `bg` (`claude/parse.ts:28-33`). Either way it is a root.

### Root with child

```json
{
  "type": "session_meta",
  "payload": {
    "id": "01a1…",
    "source": {
      "subagent": {
        "thread_spawn": {
          "parent_thread_id": "01a0…",
          "depth": 1,
          "agent_path": "/root/focused-worker",
          "agent_nickname": "Focused worker",
          "agent_role": null
        }
      }
    }
  }
}
```

Child reports `topology: 'child'`, `parentId: 'codex:01a0…'`. Parent reports `topology: 'root'`.
Both facts are per-session and neither depends on the other being scanned. This is the case
`codexProvider.test.ts:238` and `codexProviderRegistry.test.ts:280` already pin — and the only one
where today's output happens to be right.

### Temporarily missing parent

The parent is scrolled out of the scan window, its rollout has aged past
`CODEX_LIVENESS_WINDOW_S`, or the registry row is archived. The child still says
`parent_thread_id: "01a0…"`.

Today this is silently the _standalone_ case: `linkSubagents` finds no parent in `bySessionId`
(`codexProvider.ts:596`), gives up, and the child keeps `worker` — which is right by accident,
while the absent parent renders as nothing at all.

Under the rule the child reports `topology: 'child'` and **omits `parentId`**, because the id it
holds points at nothing this tick. It is still a worker: knowing you were spawned does not require
seeing who spawned you. This is the case that makes `topology` and `parentId` two fields rather
than one nullable pointer — _"I have a parent"_ and _"here it is"_ are different facts, and the
first survives the second going missing.

### Nested supervisor

Codex records `depth` in the spawn blob (`"depth": 1` observed; `codex-v2-format.md` §
`state_5.sqlite`) and `agent_path` as a path (`/root/<slug>`), so `/root/a/b` is depth 2. Claude
records `spawnDepth` in `agent-<id>.meta.json` (`provider-formats.md` §1.4). Both providers can
already tell you the depth; neither has been observed producing anything below 1.

A node at depth 1 that itself spawned a child is a **child that supervises**. Under the rule it is a
`worker`, and that is the answer, not a gap:

- It has no human at the keyboard, so the worker's 30-minute window is the honest one — which is
  what the role actually keys (§2).
- There is one `post` anchor per mine. Drawing it as a foreman puts two dwarfs on one rock and tells
  the user a human is sitting at both.
- The fact that matters about it — _it has children_ — is better shown by the children being on
  screen than by changing the parent's sprite.
- The one place the chain genuinely matters is delivery, and delivery already walks it: `resolve.ts`
  follows `foreman-relay` hops up to `MAX_FOREMAN_HOPS = 4` (`:37`), accumulating an
  `[for agent X] [for agent Y] ` prefix per hop, and routes on `TextDeliveryTarget.kind` rather than
  on role. Its own comment says one hop is all a real crew needs _today_ — the bound is there
  because deeper trees are expected.

So: **carry `parentId` on the wire so depth is derivable by anything that needs it, and keep `role`
binary.** A third role value would need new art, a new anchor kind and a re-authored interior to
mean anything, and would still be lying about the human.

### A provider with no topology signal at all

The provider omits `topology` and `parentId` entirely. `deriveRoles` reads that as `unknown` and
draws every dwarf as a `foreman` (§4). Every mine's crew shares the one `post` anchor via
`SHARE_SPREAD_X` (`sceneAssignment.ts:36`), which is ugly at scale but honest, and no session is
wrongly hurried toward a silence claim.

The simulated provider is this case wearing a costume: `world.ts:293` reports a rank it has not
observed, because there is nothing to observe. It should report `topology` explicitly — index 0 is a
genuine `root` in that invented world — rather than continue writing `role` directly.

---

## 8. Which behaviours should stop reading role

Question 7 in the issue. The inventory in §5 answers most of it, and one live case answers the rest.

**Genuinely role, keep it:** the animation frames (`WORKING`/`SILENT`), the `post`-vs-`vein` anchor,
and the tooltip/aria wording. These are all "what does this dwarf look like and what is it called",
which is what a presentation verdict is for.

**Not role, and already right:** Send, Kick and the action menu. `DwarfCapabilities`
(`contracts.ts:191-206`) and `TextDeliveryTarget` (`port.ts:29-32`) are a per-dwarf capability
matrix resolved every poll, and they read no role at all. Copy this, do not change it.

**Role as a proxy that is already wrong today:** the silence window. It is keyed on rank
(`DWARF_SILENCE_WINDOW_MS`, `contracts.ts:108`) but justified by _"as long as it takes a human to
type the next prompt"_ (`:100`). Those are not the same predicate, and the tree already contains a
session where they part company:

- Claude's registry distinguishes `kind: 'interactive'` from `kind: 'bg'` — "a TUI the user is
  looking at" versus "a headless background job" — and the provider already reads it, for delivery:
  a `bg` session gets `claude-relay` instead of `terminal` (`claude/parse.ts:132-143`).
- `claudeProvider.ts` never filters on `kind`. So a headless `claude -p` session is scanned like any
  other, gets `role: 'foreman'` at `:532`, and therefore gets the 60-minute _human-is-typing_
  window — while no human is typing into it.
- Codex has the same shape from the other direction: `thread_source` takes the value `automation`
  (`codex-v2-format.md`, `threads` table; and `__fixtures__/codex/rollout.jsonl` line 1 carries
  exactly that). An automation thread is topologically a root and has no keyboard either.

The honest long-term shape is a `humanAttended` capability that both providers can already answer —
`kind !== 'bg'` for Claude, `thread_source ∉ {automation, subagent}` for Codex — with the window
keyed on that rather than on rank. **That is out of scope for #62 and should be its own issue**;
naming it here is enough, so that whoever adds the third backend does not read `DWARF_SILENCE_WINDOW_MS`
as settled.

**Dead, delete or use:** `is-foreman` (`DwarfSprite.vue:292`). Nothing styles it.

---

## 9. Migration

### Claude — no behaviour change

| Today                                       | After                                                         |
| ------------------------------------------- | ------------------------------------------------------------- |
| `role: 'foreman'` (`claudeProvider.ts:532`) | `topology: 'root'`; `deriveRoles` yields `foreman`            |
| `role: 'worker'` (`:591`)                   | `topology: 'child'`, `parentId: mainDwarfId`; yields `worker` |

Claude already knows both facts at both sites: the main dwarf is built from a registry entry, and
each worker is built inside a loop over that session's in-flight agents, where `mainDwarfId`
(`:508`) is already in scope and already used as that worker's relay target (`:572-576`). Output is byte-identical, and
`claudeProvider.test.ts:143`/`:156` pass unchanged. This provider is the reference implementation of
the rule; it is already correct and only moves the decision.

### Codex — behaviour changes, deliberately

| Today                                        | After                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| `role: 'worker'` for everything (`:483`)     | `topology` classified from `source` (below); no `role` written           |
| `parent.mainDwarf.role = 'foreman'` (`:597`) | **removed**; `linkSubagents` keeps only the idle-parent unshift (`:598`) |

Classification, in order, from evidence that already reaches the provider:

1. `session_meta.source.subagent.thread_spawn.parent_thread_id`, or a `thread_spawn_edges` row with
   this thread as `child_thread_id` → **`child`**, `parentId` set when the parent is in this scan.
2. `source.subagent` present but no `thread_spawn` — the shape `provider-formats.md` §2.2 warns
   carries no usable relationship → **`child`**, `parentId` omitted. It is a subagent; we just
   cannot name its parent.
3. `threads.thread_source === 'subagent'` → **`child`**, `parentId` omitted.
4. `source` is a known user-initiated tag (`'cli'`, `'vscode'`) → **`root`**.
5. anything else, including no registry row and no readable rollout head → **`unknown`**.

Rules 2 and 3 are the load-bearing ones and are **not** in the code today. `parseCodexRolloutHead`
discards a `subagent` object that lacks `thread_spawn` (`codex/parse.ts:71-80`), and `toThread`
never reads `thread_source` at all (`state.ts:105-130`) even though the column is in the schema
fixture (`__fixtures__/codex/state-schema.sql`). Without them, flipping the default to `foreman`
would render an unspawnable-parent subagent as a foreman — a regression today's rule avoids by
accident.

---

## 10. Decision: should standalone Codex become a foreman now, or only with the normalized model?

**Recommendation: now, as a scoped Codex-only fix, and only with rules 2 and 3 of §9 included.**

### Reasoning

The evidence Codex needs is **absolute and per-session**, not relative. A rollout's own
`session_meta.source` says whether that session was spawned, without any other session being in the
scan. Nothing about that verdict improves by waiting for a domain layer: the normalized model
changes _where_ the answer is computed, not _what it is_. Blocking the fix on the refactor keeps a
known-wrong rendering live and buys nothing.

The current behaviour is not merely inconsistent, it is a defect with a name. Codex's rank is
derived from a live headcount, so a session whose subagent finishes reverts from foreman to worker
mid-session — the exact identity swap Claude removed and pinned a test against
(`claudeProvider.ts:529-531`). Two providers should not be running opposite sides of a decision one
of them already made.

And the fix is small: one classification at `codexProvider.ts:483`, the deletion of the mutation at
`:597`, plus reading two fields the parsers already have in hand. Doing it now also produces the
one thing the normalized model most needs and does not have — a second provider that reports
topology as a fact — which makes §6 a refactor with two working examples instead of one.

### Risks

- **Rules 2 and 3 are not optional.** Without them the flip makes an unresolvable subagent render as
  a foreman. That is the one way this change is worse than the status quo, and it is entirely
  avoidable.
- **Two foremen per mine becomes common.** One `post` anchor means a Claude session and a Codex
  session in the same project share it, offset by `SHARE_SPREAD_X`. This is not new — two Claude
  sessions in one project already do it, and `sceneAssignment` handles sharing by design — but it
  moves from rare to typical, so it should be looked at on screen before merging
  ([`simulated-valley`](../skills/simulated-valley/SKILL.md) can stage it without real sessions).
- **The 60-minute window would apply to Codex sessions.** Currently harmless: Codex sets no
  `silentForMs` (`codexProvider.ts:480-500` writes no such field; Codex keeps no per-agent
  transcript), and `isDwarfSilent` returns `false` for `undefined` (`presentation.ts:134`). The risk
  is deferred, not incurred — but it becomes real the day Codex learns to report silence, which is
  the same day §8's `humanAttended` question has to be answered.
- **`codexProvider.test.ts:138-154` must be amended, not rewritten.**
  [`test-safety`](../skills/test-safety/SKILL.md) binds.

### The alternative, and why not

Waiting for the normalized model means one PR that touches `contracts.ts`, both barrels, three
providers, `poller.ts` and a new domain module, and changes Codex's visible output in the same
breath. That is one review where a rendering regression and a contract change cannot be told apart
— and this repository's own rule is one concern per PR (`CONTRIBUTING.md`). Fixing Codex first
keeps the behavioural change reviewable against real sessions, and leaves the refactor a pure move.

---

## 11. Verified versus assumed

- **Verified against the code** on `cc75a89`: every line number above, the three providers' rules,
  the counts in §5 (including "zero main-process reads" and the dead `is-foreman`), the single
  `post` anchor, the identical `WAITING` entries, and that delivery routes on channel rather than
  rank.
- **Verified against the tree, not a machine**: the Codex record shapes in §7 come from
  `docs/provider-formats.md`, `docs/codex-v2-format.md` and the committed fixtures. Those documents
  record real observations from 2026-08-29, but this document did not re-observe them. `depth` has
  never been seen above 1, so the nested-supervisor case is reasoned from the schema, not from a
  captured session.
- **Proposed, not measured**: the fallback direction in §4 is an argument from this repository's
  existing invariants, not from a reported incident. If a real one lands on the other side, it wins.
- **Explicitly out of scope**: Gemini, OpenCode and local providers. `CONTRIBUTING.md` requires
  verifiable session artifacts before a backend ships, and none exist here. This document is written
  so that when they do, the role question is already answered.

---

## 12. Addendum — since this was written (after `cc75a89`)

This document is pinned to `cc75a89` and its claims about the tree at that commit still hold.
One thing it argued for has since shipped, on a different axis than this document's subject
(role and topology, issue #62), and is recorded here so nobody re-derives or re-files it.

- **§8's `humanAttended` proposal has shipped, as `DwarfAttendance` (issue #68).** This
  document named it out of scope for #62 and said it "should be its own issue" — it now is one,
  and it is closed. `DWARF_SILENCE_WINDOW_MS` is no longer keyed on `role`; it is keyed on
  whether a session is attended, and chosen by `dwarfSilenceWindowMs(role, attendance)`. Role
  still narrows the window in one direction only — a worker can never lengthen it — which is
  consistent with, not a reversal of, §2's finding that the window was never really about rank.
- **§2's and §5's quotes describe the pre-#68 shape.** The `contracts.ts:100-104` blockquote in
  §2 no longer exists in that form, and §5's `DWARF_SILENCE_WINDOW_MS[role]` lookup is
  superseded by `isDwarfSilent`, which calls `dwarfSilenceWindowMs` rather than indexing the
  constant by role.
- **Ordinary line drift, unrelated to #68**: `claudeProvider.ts`'s role-write sites moved,
  because #68 inserted the `attendance` field earlier in the file. The quoted comment text is
  unchanged; only its line numbers moved.

Nothing above touches this document's actual subject — the role and topology proposal for #62
is still unimplemented, and sections 1 to 11 remain an accurate reading of `cc75a89`.
