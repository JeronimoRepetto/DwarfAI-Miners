---
name: jev-capabilities
description: >
  How a launchable model earns a place in Jev's routing table, and the evidence rule every entry must meet.
  Trigger: before adding a provider or a model the app can launch, changing a model catalogue builder, or editing a Jev question, criterion or confidence floor.
license: MIT
metadata:
  author: JeronimoRepetto
  version: '1.0'
  scope: [root]
  auto_invoke:
    - 'adding a provider or a model the app can launch'
    - 'changing a model catalogue builder'
    - 'editing a Jev question, criterion or confidence floor'
allowed-tools: Read, Edit, Write, Glob, Grep, Bash
---

# A model Jev can route to needs a sourced capability entry

Jev never sees a model name. It answers five questions about the prompt (`src/main/jev/routeRequest.ts`)
and the local decision (`src/main/jev/routeDecision.ts`) resolves those answers to a concrete model
through `src/main/jev/capabilities/`. A catalogue id with no entry there is an id `decideLaunch` cannot
route — and the exhaustiveness suite (`capabilities.test.ts`) fails, naming it, before that ever ships.

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
- [`src/main/jev/routeDecision.ts`](../../src/main/jev/routeDecision.ts) — the profile/tier rule that reads `tier`
- [`docs/privacy.md`](../../docs/privacy.md#what-it-transmits) — the full boundary of what Jev receives
