---
name: jev-capabilities
description: >
  How a launchable model earns a place in Jev's routing table, and the evidence rule every entry must meet.
  Trigger: before adding a provider or a model the app can launch, changing a model catalogue builder, editing a Jev question, criterion or confidence floor, or adding a provider whose models come from a live catalogue instead of a hand-verified list.
license: MIT
metadata:
  author: JeronimoRepetto
  version: '1.0'
  scope: [root]
  auto_invoke:
    - 'adding a provider or a model the app can launch'
    - 'changing a model catalogue builder'
    - 'editing a Jev question, criterion or confidence floor'
    - 'adding a provider whose models come from a live catalogue'
allowed-tools: Read, Edit, Write, Glob, Grep, Bash
---

# A model Jev can route to needs a sourced capability entry

Jev never sees a model name — that still holds, but since #608 the model step is no longer purely
local. Request 1 answers five questions about the prompt (`src/main/jev/routeRequest.ts`) and
resolves a provider and a tier; `decideLaunch` (`src/main/jev/routeDecision.ts`) then narrows that
provider's own table down to its live, launchable candidates at that tier (`candidatesAtTier`). With
two or more candidates, request 2 asks Jev to pick among them directly — one Noul "does it fit"
question per candidate plus a tie-breaking Choice, over the SAME sourced capability text this table
already carries (`what`/`notFor`/`examples`/`tier`/`relativeCost`/`contextWindowTokens`), never the
model's own id, name, alias or family (`buildJevModelRouteRequest`, `MODEL_TIE_BAND`,
`selectModelWinner`, `src/main/jev/routeDecision.ts`). With one candidate, or whenever request 2
cannot be sent, fails, or comes back unusable, the model is picked locally instead — what used to be
one `pickModel` function is now three, doing that same job: `candidatesAtTier` (the tier's own live
candidates), `cheapestOrPriciestCandidate` (the cost/profile pick among them, and request 2's own
tiebreak of last resort), and `finalizeModel` (the shared tail end — effort narrowing plus the launch
gate check — that both the local pick and request 2's own winner go through). Either path still ends
at `src/main/jev/capabilities/`: a catalogue id with no entry there is an id neither path can
route — and the exhaustiveness suite (`capabilities.test.ts`) fails, naming it, before that ever
ships.

## The rule

**Every id a real catalogue builder (`agentModelCatalog.ts`) can hand back needs an entry in
`MODEL_CAPABILITIES`, sourced and dated.** Add it in the same change that adds the id, in the
provider's own file under `src/main/jev/capabilities/`, and add the id to that provider's fixture
list in `capabilities.test.ts` so the suite actually exercises it.

## What an entry is

One `ModelCapabilityEntry` (`modelCapability.ts`), every field written for Jev to match a prompt
against — never the model's own name, which would make the question circular:

- **`tier`** — `fast-cheap` / `balanced` / `frontier` / `long-context` / `special-purpose`. Feeds the
  profile rule below directly; a wrong tier misroutes every prompt on every profile.
- **`what`** — what the model is FOR, in words a prompt's own text can be matched against.
- **`notFor`** — the contrastive half `what` alone can't carry.
- **`examples`** — exactly two short prompts this model is the right answer for.
- **`launchTarget`** — `false` for an id that must never be offered as a launch choice.
- **`effortLevels`** — `'all'` for the provider's own full ladder unchanged, `[]` for none, or an
  ordered subset when this model accepts fewer levels than the provider's ladder.
- **`contextWindowTokens`** — the documented window, omitted when unverified.
- **`relativeCost`** — `low` / `medium` / `high` / `very-high` / `unverified`, judged against the
  other entries in this table only, never an exact figure.
- **`alias`** — only for an id that resolves to something else, in words.
- **`sources`** / **`verifiedOn`** — see the evidence rule.

## The evidence rule

Every field traces to the provider's own official documentation, or to the installed CLI's own
output (e.g. Codex's `~/.codex/models_cache.json`) — never a third-party summary. Record the URL or
the command in `sources`, and the date it was checked in `verifiedOn`. A field this app could not
verify is `relativeCost: 'unverified'` (never omitted — the profile's cost tiebreak needs an answer
for every option) or left off entirely when the field is optional (`contextWindowTokens`, `alias`).
`antigravity.ts`'s own top comment is the worked example: the CLI is not installed on the machine
that wrote it, so the file says so, keys its entries off the docs page's display names instead of a
verified `agy models` id grammar, and names what the next verifier should check first.

Never guess a value to fill a gap. An unverifiable fact is recorded as unverified, with the reason,
not dressed up as a checked one.

## How tiers map to the routing profiles

`decideLaunch` (`routeDecision.ts`) reads `tier` against the person's chosen profile:

- A confident `trivial` answer always forces `fast-cheap`, on every profile — no tier, however
  capable, is ever handed a one-line prompt.
- **`economy`** never reaches `frontier`; a `frontier` answer caps at `balanced`.
- **`premium`** may promote a confident `balanced` answer to `frontier`, but only for work the
  effort rubric already calls multi-file or architectural, and never for a trivial prompt.
- Picking a model then steps DOWN from the resolved tier toward `balanced` then `fast-cheap` until a
  launchable, live-catalogued entry is found — never upward, and never past what the live catalogue
  actually offers today.

An entry's `tier` is therefore not description — it is the value every profile rule branches on.
`'special-purpose'` is the one tier a routing decision can never land on: it exists only so an
id that is not a launch target still has a real entry (see below).

## `launchTarget: false`

Set it for a catalogue id that is real but must never be a launch choice — Codex's own internal
`codex-auto-review` (`visibility: "hide"` in its cache) and Antigravity's `nano-banana-2` (an image
model, not a coding one) are the two entries today. Both still get a full entry: the exhaustiveness
suite must resolve every id a catalogue can hand back, whether or not a person may ever pick it.

## Per-model `effortLevels`

Default to `'all'` — the provider's full `PROVIDER_EFFORT_LEVELS` ladder (`launchTuning.ts`) — and
narrow it only when the provider's OWN evidence says this specific model accepts fewer levels.
Claude's Haiku takes `[]` (Anthropic's own comparison table lists its effort as "Not supported").
Codex's `gpt-5.6-luna` and `codex-auto-review` stop at `max`, with no `ultra`; `gpt-5.5` stops at
`xhigh`, with no `max` or `ultra` — all three read per-model from the cache's own
`supported_reasoning_levels`, not assumed from the provider's longest ladder. Never list a level
outside the provider's own ladder.

## What Jev never receives

The `state` object sent to Jev carries exactly `{ prompt, routing_profile }` — see
[`docs/privacy.md`](../../docs/privacy.md#what-it-transmits) for the full boundary. Two things are
never in it, on purpose:

- **Model names.** The first live run asked Jev to choose among model names directly and returned
  0.38 confidence over eleven near-identical options such as `Claude Code, running the "Sonnet"
model.` versus `... "Haiku" ...` — the consistency cookbook's own documented failure mode for a
  calibrated matcher shown near-identical option text. Every fact a routing decision needs has to be
  spelled out in this table's words instead, never in the model's own name.
- **Anything about the machine.** No path, hostname or username — only the prompt's own text and the
  three-word routing profile ever cross the wire.

## Adding a provider

1. A new file under `src/main/jev/capabilities/` (`claude.ts`, `codex.ts`, `antigravity.ts` are the
   pattern), one `ModelCapabilityEntry` per id, sourced per the evidence rule above.
2. Add the file's export to `MODEL_CAPABILITIES` in `modelCapability.ts`.
3. Add the provider's display name to `PRODUCT_NAME` (`src/main/domain/launchProviders.ts`) — Jev's
   `provider` question reads it, never the CLI's own binary name.
4. Add every id to that provider's fixture list in `capabilities.test.ts`
   (`CLAUDE_FIXTURE_IDS`/`CODEX_FIXTURE_IDS`/`ANTIGRAVITY_FIXTURE_IDS` are the pattern) so the
   exhaustiveness suite actually runs the real catalogue builder over them.

## A provider with a live catalogue: derive, do not curate (#547)

OpenCode's own catalogue moves with every `models.dev` update and every person's configured
provider keys, so a hand-maintained table would be stale on arrival. Its table is DERIVED at
route time from the installed CLI's own `opencode models --verbose`
(`src/main/providers/opencode/models.ts`), one `ModelCapabilityEntry` per model whose
`status === 'active'` — unlike `claude.ts`/`codex.ts`/`antigravity.ts`, which are hand-written.

- **The bands and the tier rule are written once, and pinned.** Cost bands (`$0.50` / `$2` / `$5`
  per million output tokens) and the tier rule (reasoning plus the top band → `frontier`; cheapest
  band, free included → `fast-cheap`, checked ahead of context so a free huge-context model still
  reads as cheap; ≥1,000,000-token context → `long-context`; else `balanced`) live once in
  `capabilities/opencodeDerived.ts` (`OPENCODE_COST_BAND_THRESHOLDS`, `opencodeTier`), boundaries
  pinned by tests rather than restated per model.
- **The overlay is the curated exception, and it wins.** `capabilities/opencode.ts`'s
  `OPENCODE_CAPABILITY_OVERLAY` (empty today) replaces a derived entry per id
  (`mergeOpenCodeCapabilityTable`, overlay spread last), for an id hand-verified well enough to
  earn real, sourced prose the way `claude.ts` does.
- **An absent CLI stays honest by omission.** `hasAnyLaunchTarget` (`routeRequest.ts`) drops a
  provider from Jev's `provider` question when its table has zero `launchTarget: true` entries —
  missing, timed-out or unparseable all read the same: nothing derived, nothing offered.

**Copy this for the next live-catalogue provider:** derive entries from the catalogue's own
facts, template `what`/`notFor`/`examples` from those facts, and cite the exact command plus the
catalogue's own source (`OPENCODE_CATALOGUE_SOURCES`). **Never invent per-model prose** — no
maintainer reviews a guess before it ships on the next install.

**Per-model, not just per-tier (#608 T1).** A tier-keyed template alone gives every model in a
tier byte-identical `notFor`/`examples` — the exact near-identical-option failure the "What Jev
never receives" section documents (0.38 confidence over eleven options). `templatedWhat` composes
`what` from THIS model's own `limit.output`, `cost.cacheRead` and `effortLevels`, on top of the
reasoning/context/cost facts `what` already carried — every one already parsed off the same
`--verbose` block, no new I/O added. `notFor` keeps the tier's shared sentence and appends this
model's own output ceiling. `examples` stays tier-keyed: the catalogue names costs and limits, not
worked prompts, so a per-model example would be invented prose, not a derived fact — the same
evidence rule forbids it. Exclude a catalogue field the same way `id`/`name` are excluded whenever
it is a lineage label rather than a capability: `family` is in the raw block
(`docs/opencode-format.md` Row 6) but reads as a second name to a matcher that must never see one,
so it is never rendered. Only render a field this catalogue has actually been observed to carry —
Row 6 names OpenCode's FULL top-level key set, and `capabilities` has only ever been measured to
hold `reasoning`; a `tool_call`/`attachment`/`temperature` sub-field with no measurement backing it
stays unwritten rather than guessed.

**Known limitation, pinned in `routeDecision.test.ts`:** the table carries cost _bands_, not
prices, so a free OpenCode model and a low-band curated model both land in `'low'` and tie;
`cheapestLaunchableProviderFor` cannot see $0 beat $1 and falls back to the contract's provider
order (`DWARF_PROVIDERS`), where `claude` comes first. A free OpenCode model is chosen only when
Jev names OpenCode directly, or OpenCode is the person's configured default provider.

## Getting it wrong

- **Adding a model id without an entry.** `capabilities.test.ts` fails, naming the id — this is the
  suite doing its job, not a flake to route around.
- **Writing `what`/`notFor`/`examples` around the model's own name.** Jev never sees the name; a
  criterion that only makes sense once you know it is the model this table is about will not read as
  a criterion to Jev either.
- **Guessing a `relativeCost` or `contextWindowTokens` to avoid an `'unverified'`/absent field.** The
  evidence rule exists because a guess dressed as a checked fact is worse than an honest gap.

## References

- [`src/main/jev/capabilities/modelCapability.ts`](../../src/main/jev/capabilities/modelCapability.ts) — `ModelCapabilityEntry`, `MODEL_CAPABILITIES`, `lookupModelCapability`
- [`src/main/jev/capabilities/capabilities.test.ts`](../../src/main/jev/capabilities/capabilities.test.ts) — the exhaustiveness suite
- [`src/main/jev/routeDecision.ts`](../../src/main/jev/routeDecision.ts) — the profile/tier rule that reads `tier`, plus #608's `candidatesAtTier`, `cheapestOrPriciestCandidate`, `finalizeModel`, `MODEL_TIE_BAND` and `selectModelWinner`
- [`src/main/jev/routeRequest.ts`](../../src/main/jev/routeRequest.ts) — `buildJevModelRouteRequest` and `candidateCapabilityFacts`, request 2's own builder
- [`src/main/jev/jevRouterPort.ts`](../../src/main/jev/jevRouterPort.ts) — `JevModelRouteRequest`/`JevModelRouteAnswers`, request 2's own wire shape
- [`src/main/jev/capabilities/opencodeDerived.ts`](../../src/main/jev/capabilities/opencodeDerived.ts) — the cost bands, tier rule and template OpenCode's derived table is built from
- [`src/main/jev/capabilities/opencode.ts`](../../src/main/jev/capabilities/opencode.ts) — the curated overlay, and the merge that lets it win per id
- [`src/main/jev/routeDecision.test.ts`](../../src/main/jev/routeDecision.test.ts) — the pinned cost-band tie between a free OpenCode model and a low-band curated one
- [`docs/privacy.md`](../../docs/privacy.md#what-it-transmits) — the full boundary of what Jev receives
