# Jev routing profiles and the model capability table (#509 follow-up)

Branch: `feat/jev-routing-profiles` (from `main` at 10a3f4d), worktree
`../DwarfAI-Miners-worktrees/feat-jev-routing-profiles`. Engram mirror: topic
`odd/jev-routing-profiles/tasks`. Successor of `odd/tasks/jev-launch-routing.md` (#509, shipped) and
`odd/tasks/jev-direct-launch.md` (#523, shipped).

## Objective

Make Jev's routing decision land with confidence and honesty. Jev stops choosing among a dozen
near-identical model names and instead answers five atomic questions about the prompt; a
maintained, source-checked **model capability table** turns those answers plus the user's chosen
**routing profile** into a concrete provider, model and effort. Settings gains the profile picker
(economy / balanced / premium) and a user-defined **default provider, model and effort** used
whenever Jev cannot decide. None of it is offered without a configured TypeSafe key.

## Problem and why

First real run (2026-09-21): eleven options such as `Claude Code, running the "Sonnet" model.`
versus `... "Haiku" ...`, confidence 0.38, fallback `low-confidence`. Jev is a calibrated matcher
between the `state` text and each option's description; it knows nothing about model names, and
TypeSafe's docs say not to rely on knowledge in model weights. The knowledge has to live in our
descriptions, and the question has to be one Jev can separate. The consistency cookbook describes
our failure exactly: near-identical options flatten the distribution.

## Decisions (user, 2026-09-21)

- Profiles: **economy**, **balanced**, **premium**. Premium means the most capable model when the
  task warrants it; a trivial prompt never routes to a frontier model under any profile.
- Settings → Jev also holds a **default provider, model and effort**; when Jev cannot decide, the
  launch uses that default (and says so). If no default is set, today's behaviour stays.
- Profile, defaults and the Jev toggle are visible only when a key is configured.
- Every capability entry is verified against the model's own official documentation (or the
  installed CLI's own output), with the source recorded beside the entry. Every future provider or
  model integration must add its entry; a test enforces it.
- Orchestrator defaults accepted: confidence floors 0.6 (provider) / 0.7 (tier) / 0.75 (trivial =
  true) as starting points to tune from the JEV_DEBUG trace; a confident "trivial" forces
  fast-cheap; low confidence resolves to the safe value silently and the card says which part was
  unsure; provider "no preference" resolves to the cheapest capable provider under the profile.

## Design (from primary sources; see Engram `architecture/jev-routing-v2`)

- `state` becomes an object: `{ prompt, routing_profile }`. Nothing else about the machine.
- Five questions in one request (all parallel): `is_trivial` (Noul), `needs_large_context`
  (Noul), `provider` (Choice over launchable providers + `no_preference`, focus "tooling fit, not
  cost"), `model_tier` (Choice: `fast_cheap` / `balanced` / `frontier` with
  `not_for: trivial or simple prompts` / `long_context` / `no_preference`, `inspect:
routing_profile`), `effort` (Score, the existing 4-level rubric). Criteria are objects
  (`what` / `not_for` / `examples`), instructions are objects (`question` / `focus` / `inspect`).
- Local mapping: (provider, tier, profile, needs_large_context) → concrete model through the
  capability table; effort Score → provider ladder as today, honouring per-model effort support
  (Haiku accepts none; Codex `ultra` only where the table says so).
- Ids the table marks as not a launch target (e.g. `codex-auto-review`, hidden by Codex's own
  catalogue) are never offered and never chosen.
- No second-stage rerank, no hierarchical questions: under twenty options, one parallel request.

## Constraints

- Worktrees only; root stays on `main`. Stacked-to-main, one PR per task, push + PR after each.
- Strict TDD, hand-written fakes, English artifacts, comments in the register of `contracts.ts`,
  conventional commits ending with the issue number, no AI attribution.
- Evidence rule: official docs, specs or the installed binary's own output. Third-party posts are
  leads, never evidence. A claim that cannot be verified is written as unverified, not guessed.
- Wire types in `contracts.ts`, re-exported from both barrels. Settings values are per-setting
  stores; the profile and defaults are preferences (plain JSON), the key stays encrypted.
- Three platforms, any non-empty subset of providers.
- Nothing new leaves the machine beyond `routing_profile`; `docs/privacy.md` is updated in T5.

## TDD

Strict (user global policy, `skills/tdd`). Runner `pnpm test`; single file `pnpm vitest run <path>`.

## Checks per task (CI order)

```
pnpm typecheck
pnpm lint
pnpm format:check
node skills/skill-sync/assets/sync.mjs --check
pnpm test
pnpm build
```

Plus the test-safety census on every touched test file and the privacy guard.

## Delivery

Strategy `ask-on-risk`, chain `stacked-to-main` (carried from #509). Forecast ≈ 1800 authored
lines across five tasks. RDD off (user). High-tier tasks get an independent verifier.

## Tasks

- [x] **T1 — Model capability table.** `src/main/jev/capabilities/` with one file per provider
      (`claude.ts`, `codex.ts`, `antigravity.ts`), a shared `ModelCapabilityEntry` type (tier,
      what, not_for, examples, launchTarget, effort support, context window, relative cost, source
      URLs), a lookup with an explicit `unknown` result, and an **exhaustiveness test** that runs
      each existing catalogue builder over fixtures and fails naming any id without an entry. Every
      entry re-verified against official docs by the writer, source recorded beside it. Route:
      delegated writer (research + 4+ files).
- [ ] **T2 — Profile and defaults in Settings.** `JevSettings` gains `profile` and `defaults`
      (provider?, model?, effort?); a plain per-setting store `jev-preferences-v1.json`; IPC set;
      preload; `JevSettings.vue` shows the profile picker and the default pickers (reusing the
      launch catalogue and effort ladders) only when `configured`. Route: delegated writer.
- [ ] **T3 — Request v2.** State object, five questions with object criteria and instructions,
      per-question floors, local mapping through the table and profile, trivial override,
      not-a-launch-target exclusion, result carries per-part confidence and, on fallback, the
      user's default. Route: delegated writer.
- [ ] **T4 — Renderer.** Card shows tier and provider with their confidence and names the part
      that fell to a safe value; a fallback with a configured default applies it like a decision and
      says "your default"; copy updated. Route: delegated writer.
- [ ] **T5 — Docs and the maintenance rule.** `docs/privacy.md` (state now carries the profile),
      README, and a `jev-capabilities` skill with an auto-invoke trigger for "adding a provider or
      a model", synced into AGENTS.md. Route: delegated writer.

## Acceptance criteria

- The debug trace shows five questions, object criteria, and `routing_profile` in state.
- A trivial prompt on premium never yields a frontier model; a hard prompt on economy never yields
  one either; a hard prompt on premium does when the table has one for the chosen provider.
- Confidence on `provider` and `model_tier` for realistic prompts is visibly higher than 0.38 in
  the trace (measured, recorded here).
- `codex-auto-review` never appears as an option.
- With a default configured, a Jev failure launches (or applies) the default and says so.
- Without a key, Settings shows none of profile/defaults and AddPanel shows no toggle.
- A catalogue id without a capability entry fails the suite naming the id.

## Progress and evidence

### T1 (writer report)

`src/main/jev/capabilities/` — `modelCapability.ts` (`ModelTier`, `ModelCapabilityEntry`,
`MODEL_CAPABILITIES`, `lookupModelCapability`), `claude.ts`, `codex.ts`, `antigravity.ts`,
`capabilities.test.ts`.

TDD: `capabilities.test.ts` written first, run against no `modelCapability.ts` — RED
(`Cannot find module './modelCapability' imported from .../capabilities.test.ts`). Implemented the
four source files; `pnpm vitest run src/main/jev/capabilities/capabilities.test.ts` — GREEN (7
passed, 0 failed).

Evidence: Claude facts from `code.claude.com/docs/en/model-config` and
`platform.claude.com/docs/en/models/overview` (fetched live). Codex facts from this machine's own
`~/.codex/models_cache.json` (read-only) plus `developers.openai.com/api/docs/pricing`; the
`effortLevels` ladder is read PER MODEL from the cache's own `supported_reasoning_levels`, which
corrected two of the brief's own leads — `gpt-5.6-luna` caps at `max` (no `ultra`, 5 levels) and
`gpt-5.5` caps at `xhigh` (no `max`, no `ultra`, 4 levels); `codex-auto-review` also has no `ultra`
(5 levels). Antigravity facts from `antigravity.google/docs/models/`; `agy` is not installed on
this machine, so the eight entries are keyed by docs-derived slugs, NOT a verified `agy models` id
grammar — said so in the file's own comment, with a pointer for whoever verifies against a real
`agy models` answer first to rename the keys (the exhaustiveness suite will fail loudly if they
disagree).

Not verified (recorded as `relativeCost: 'unverified'` or the field omitted, never guessed):

- `claude:default`'s concrete resolved model/cost — depends on account plan, which this app cannot
  see; the entry states both possible resolutions in `alias` and reads the tier at the conservative
  (Sonnet) floor.
- `codex:codex-auto-review`'s cost — not in the cache and not a public SKU on the pricing page.
- Every `antigravity` entry's `contextWindowTokens` and `relativeCost` — the docs page names
  neither, and `agy --help` was not run (CLI absent on this machine).
- The exact `agy models` id grammar for all eight Antigravity entries — see `antigravity.ts`'s own
  comment.

Decision beyond the brief: `gpt-5.5`'s `relativeCost` is `'high'`, not `'medium'` — OpenAI's own
rate card prices it at $5/$30 per Mtok, ABOVE `gpt-5.6-sol`'s current $4/$20, because Sol is
carrying a temporary promotional discount through 2026-11-21. Recorded as a live figure rather than
the brief's unstated assumption that a retiring model is automatically the cheaper choice.

Checks: `pnpm typecheck` — clean. `pnpm lint` — no issues. `pnpm format:check` — clean for the four
files this task touched (`odd/tasks/jev-routing-profiles.md` itself still warns; outside this
task's zone, left untouched). `node skills/skill-sync/assets/sync.mjs --check` — up to date, no
change needed: `src/README.md`'s tree does not expand `main/jev/`'s own contents (single bullet,
same as every other `main/` subject folder), so the brief's conditional "add capabilities/ to the
map" does not apply. `pnpm test` — 285 files, 7882 passed, 5 skipped (pre-existing), 0 failed.
`pnpm build` — clean. Test-safety census (`node skills/test-safety/assets/test-census.mjs`) —
`capabilities.test.ts` is a new file (+5 `it(` statements as written), no file lost test statements.

## Next step

T2 — Profile and defaults in Settings.
