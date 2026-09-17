# Proposal: OpenCode observer — draw OpenCode sessions as dwarfs

Change: `opencode-observer` · Phase: sdd-propose · Date: 2026-09-17 · Builds on `exploration.md` in this folder (shared research for both OpenCode changes). Follow-up change: `opencode-held` (launch-and-hold), out of scope here.

## Intent

**Outcome:** a person who starts `opencode` in any project folder, from any terminal, sees a dwarf appear in that folder's mine within one poll, working while a turn streams and resting between turns, with its last reply and feed readable in the message panel. Nothing else changes for them: the panel offers no Send, Kick or Launch for that dwarf, and says so in fixed copy.

**Problem and why now:** OpenCode is the most-used agent CLI among this panel's target users and the only major one it cannot read. `CONTRIBUTING.md` (§Scope and non-goals) bars a provider until its session artifacts are verified on a real machine; `docs/session-topology-and-roles.md` already anticipated OpenCode's `parentID` edge (§6). The maintainer is about to install OpenCode, so the evidence bar can finally be met.

**Maintainer decision already taken (not reopened here):** OpenCode ships as two changes. This one observes; `opencode-held` launches and holds.

## Scope

### In scope

- Measurement milestone on a native Windows install, producing committed, redacted fixtures and a dated, versioned format doc (`docs/opencode-format.md`), in the discipline `docs/codex-v2-format.md` holds: [V]/[I] legend, negative results recorded.
- `'opencode'` added to `DWARF_PROVIDERS` in `src/shared/contracts.ts` (cross-boundary: main, preload, renderer read it through the two barrels).
- `OpenCodeProvider` implementing `Provider` (`src/main/providers/provider.ts:10`), registered as one row of `PROVIDER_REGISTRY` (`src/main/providers/registry.ts:107`), reading through the existing `FsLike` and `SqliteLike` seams with `FakeFs` / `MemorySqlite` in tests.
- Tolerance of both storage shapes — `storage/{session,message,part}` JSON and `opencode.db` SQLite — with honest degradation: unknown schema reads as no rows, never a thrown poll tick (`sqliteLike.ts` error contract).
- Topology from `parentID` → `Dwarf.parentId` / `'foreman'` promotion, the `linkSubagents` shape `codexProvider.ts:954` already uses — **only if** measurement row 4 shows the field on disk.
- One setting, `providers.opencode.storeRoot` (env `OPENCODE_STORE_ROOT`, default `~/.local/share/opencode`), reachable from the `userData` config file as `config-layering` requires; never a hardcoded user.
- Doc rows: README status line, support matrix and Provider support table; `docs/guide.md` provider list, "Providers in depth" and config table; `docs/privacy.md` "What it reads"; a pointer row in `docs/provider-formats.md`.

### Out of scope (one line each: why, and where it goes)

| Item | Why not here | Where |
|---|---|---|
| Launch (`opencode run`, `opencode` TUI) | `buildLaunchArgs` demands a probed argv; none measured yet | `opencode-held` |
| Hold (SDK over `opencode serve`, or ACP) | No reference implementation; ACP drops subagents today (exploration §2.3) | `opencode-held` |
| Send / Kick (`textDelivery` returns `null`) | No pid↔session join exists (exploration §5 item 2); absent beats guessed | `opencode-held`, gated on measurement row 5 |
| Plugin push channel | A JS artifact this repo has never distributed; viability unmeasured (row 9) | Candidate third slice |
| SSE `/event` from `opencode serve` | Only sees servers this app started; no registry for a TUI opened elsewhere | Enrichment inside `opencode-held` |
| Mine History and coal backfill for OpenCode | Per-provider readers; history panel value unproven, tokens untrusted | Later refinement |
| Cost figures | Bug history upstream (#28494, #2891); advisory at best | Never on the wire until measured |

## Capabilities

> Contract with sdd-spec. No existing specs under `openspec/specs/`, so all are new.

### New capabilities

- `opencode-store-evidence`: what the measurement milestone must produce — dated, version-stamped, redacted fixtures for both storage shapes, negative rows recorded, and which design decisions each row unblocks.
- `opencode-session-detection`: discovering live OpenCode sessions from the store, liveness from file growth and row timestamps (never mtime alone — `codex-v2-format.md` §4), dedupe across shapes, degradation on a missing root or unknown schema, and the stated absence of any delivery channel.
- `opencode-session-feed`: last assistant text, `feed`/`feedPage` assembled from the store's per-message records (the single-file tail readers `readFeedWindow`/`readFeedPage` do not fit a one-row-per-message store; only their pure helpers are reused), `transcriptPath` only if measurement row 1 finds a single per-session file, redaction at the provider boundary.
- `opencode-session-topology`: `parentID` → `parentId`, root default `foreman` (an observed parent keeps the rank), worker rank, and the silence-window attendance rule (`'unknown'`, never `'attended'`, for an unproven root).

### Modified capabilities

- None.

## Approach

Mirror `CodexProvider`: a store-reading provider behind the `adapters` seams, built from committed fixtures before a live run, with the SQLite layer treated as a projection to be confirmed, not assumed.

### Milestones and what each proves

| # | Milestone | Proves | Waits on rows (exploration §6) |
|---|---|---|---|
| 1 | Measurements on the installed native Windows build | Which storage shape this version writes; real `opencode.db` schema; whether `parentID`, status and token fields are on disk; whether any pid join exists; whether the native binary runs clean | 1, 2, 3, 4, 5, 10 |
| 2 | Fixtures + `docs/opencode-format.md` | The evidence bar `CONTRIBUTING.md` sets; a parser can be written test-first against real shapes | 1–4 |
| 3 | `parse.ts` (JSON) and `state.ts` (SQL) with tests | Both shapes yield one session model; unknown schema degrades to no rows | 2 |
| 4 | `OpenCodeProvider` + registry row + contract growth + compile-time sites | A dwarf appears, works, rests, leaves; no channel is claimed | 3, 5 |
| 5 | Doc rows | Users and agents can tell what OpenCode support is and is not | 4 |

### Design decisions that wait on measurement

| Decision | Row | Default if the row is negative |
|---|---|---|
| Source of truth when JSON and `opencode.db` both exist | 1, 2 | **Measured 2026-09-17** (`measurements-2026-09-17.md`): 1.18.31 writes SQLite only, no JSON tree. SQLite is primary; the JSON tree is a compat path for older installs and adds only what the DB lacks |
| Liveness signal (size growth, row timestamp, process probe) | 3, 5 | Size growth plus a bounded staleness window; no process probe |
| Topology on disk | 4 | Every session a root `foreman`; no workers drawn |
| `tokensObserved` and ore | 3 | Field omitted; the dwarf mines no ore (Antigravity precedent, `docs/guide.md` §Providers in depth) |
| Default store root and XDG handling per OS | 1, 10 | `~/.local/share/opencode` on all three, `Platform` passed in |

### Business rules the provider must respect

- A provider that cannot prove blockage never reports `waiting` (`SessionStatus` comment, `contracts.ts:1489`).
- Unproven attendance keeps the long silence window; `'unknown'` stays distinct from `'attended'` (AGENTS.md invariant, #47/#68).
- `tokensObserved` is per-session raw tokens; nothing converts materials (AGENTS.md).
- `textDelivery` returns `null`, as `SimulatedProvider` does (`simulatedProvider.ts:160`); `LAUNCHABLE_PROVIDERS` and `HELDABLE_PROVIDERS` are unchanged, so the Add Panel chip shows `NOT_LAUNCHABLE` — the copy `launchProviders.ts:74` kept for exactly this case.

## Affected areas

| Area | Impact | Description |
|---|---|---|
| `src/shared/contracts.ts:135` | Modified (cross-boundary) | `'opencode'` in `DWARF_PROVIDERS`. No new wire symbol, so both barrels (`src/main/domain/types.ts`, `src/renderer/src/types.ts`) need no new line. |
| `src/main/config/config.ts:136` | Modified | `ProviderConfigs` gains `opencode.storeRoot`; env + file + default, precedence tests beside the existing ones. |
| `src/main/providers/registry.ts:107` | Modified | One factory row. |
| `src/main/providers/opencode/` | New | `opencodeProvider.ts`, `parse.ts`, `state.ts`, tests beside each. |
| `src/main/providers/__fixtures__/opencode/` | New | Redacted session/message/part JSON, `opencode-schema.sql`, `README.md` (as `antigravity/README.md`). |
| `src/main/domain/launchProviders.ts:91`, `launchTuning.ts:76` | Modified | `PRODUCT_NAME.opencode`, `PROVIDER_EFFORT_LEVELS.opencode: []`. |
| `src/main/sessionLaunch/launch.ts:258` | Modified | Exhaustive switch gains a refusing arm; no argv is invented. |
| `src/renderer/src/lib/delivery/actionBar.ts:50` | Modified | `LAUNCH_COMMAND` entry; design decides between a truthful shorthand and narrowing the record. |
| `src/main/platform/processProbe.ts` | Possibly modified | Only if row 5 justifies an `isOpenCodeProcessRunning` builder per OS (`platform-ports`). |
| `docs/opencode-format.md` | New | Format evidence, dated and versioned. |
| `README.md`, `docs/guide.md`, `docs/privacy.md`, `docs/provider-formats.md` | Modified | Rows named under In scope. |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Storage changes under the provider (mid-migration, tracker issue closed "not planned") | High | Fixtures stamped with the measured version; both shapes parsed; unknown schema degrades to no rows; `docs/opencode-format.md` records the build |
| Native Windows binary misbehaves (WSL is upstream's recommendation) | Medium | Row 10 first; if WSL is the reality, the store root and any probe change and the proposal is revisited before code |
| Duplicate dwarfs when JSON and DB describe one session | Medium | Dedupe by session id; test with a fixture holding both |
| Ghost dwarfs from stale rows or frozen mtimes | Medium | Size growth and row timestamps lead, mtime last (Codex §4 lesson); both silence windows elapse before a drop |
| Private identifiers in captured fixtures | Medium | `privacy-guard` placeholders (`j`, `placeholder-host`); fixture README states redaction; CI guard |
| Review load above the 800-line budget | High | Chained PRs (below) |

## Rollback plan

Revert the PR(s). No schema migration and no new persisted file: a `last_provider` of `'opencode'` left in `projects-v1.db` reads as "no provider" through `isDwarfProvider` (`contracts.ts:147`), and an `OPENCODE_STORE_ROOT` key left in the `userData` config file is an unread key. Fixtures and `docs/opencode-format.md` may stay as evidence.

## Dependencies

- OpenCode installed natively on the maintainer's Windows machine, with an account, and the exploration §6 rows 1–5 and 10 run read-only.
- `node:sqlite` read-only access (already proven for Codex on Electron 44).
- No new npm dependency.

## Proposal question round (maintainer)

Auto mode prevented a live round; these need the maintainer's answer before design is final.

1. Does the native Windows binary run on your machine (row 10), or is WSL the practical reality? WSL moves the store and the process picture entirely.
2. Which OpenCode build will you measure against, stable or nightly? It becomes the fixtures' version stamp and the doc's date line.
3. If token counts are on disk (row 3), should an observed OpenCode dwarf mine ore in this slice, or wait for a second measurement pass?
4. Is Mine History for OpenCode wanted in this slice, or deferred with the rest of the per-provider readers?

Assumptions taken meanwhile: SQLite primary, JSON as compat (measured 2026-09-17, rows 1–2); no ore until tokens are measured; every session a root until `parentID` is seen on disk; no process probe. Question 1 is partly answered: the native binary runs through `npx opencode-ai` (the pnpm global shim is a placeholder because pnpm skipped the postinstall), so PATH presence is not proof of a working install.

## Success criteria (Windows, OpenCode installed)

- [ ] Start `opencode` in a folder from any terminal, send one prompt: within one poll interval after the first write, a dwarf labelled `opencode` stands in that folder's mine; `working` while the reply streams, `waiting` after.
- [ ] The message panel shows the last reply and pages the feed; secrets are redacted; `transcriptPath` opens a terminal tail only if measurement row 1 found a single per-session file, otherwise the panel's own feed is the reading surface.
- [ ] Spawn a subagent: a worker appears beside a foreman — or, if row 4 is negative, the doc records that and no worker is drawn.
- [ ] Send and Kick show `NO_CHANNEL_REASON`; nothing is spawned, focused or signalled. The Add Panel chip reads installed, not launchable.
- [ ] Quit OpenCode: the dwarf leaves after the silence windows, never before.
- [ ] Machine without OpenCode: no chip, no warnings, one cheap listing of a missing root per poll.
- [ ] Both storage shapes, and a DB with an unknown schema, produce the same dwarf without duplicates or a thrown tick, proven by fixtures.
- [ ] All seven CI checks green; macOS/Linux path assertions run on the Windows host by passing `Platform`.

## Size forecast (against the 800-line review budget)

| Slice | Authored lines (est.) |
|---|---|
| PR 1 — `docs/opencode-format.md`, fixtures, fixture README | 300–450 |
| PR 2 — `parse.ts`, `state.ts`, tests (no contract change) | 400–550 |
| PR 3 — contract growth, config, provider, registry row, compile-time sites, tests | 700–850 |
| PR 4 — README, guide, privacy, provider-formats rows | 80–150 |

Total 1,500–2,000. **Chained PRs recommended: Yes.** PR 3 sits at the budget edge and is the one `sdd-tasks` must watch; the contract change cannot be split from the registry row because `PROVIDER_REGISTRY` is a `Record<DwarfProvider, …>`.
