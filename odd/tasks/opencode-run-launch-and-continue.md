# Launch OpenCode from the Add Panel, and reach any OpenCode session through `run --session` (#534)

## Objective

A person picks OpenCode in the Add Panel, chooses a model from a catalogue read live from their
install and, when the model has variants, an effort level; writes the first prompt; a dwarf
appears in the mine. A message typed into that dwarf's composer becomes the next turn of that same
session. The same composer works for an OpenCode session the person opened in a terminal.

## Problem

`'opencode'` is absent from `LAUNCHABLE_PROVIDERS` (`launchProviders.ts:53`) so the Add Panel
refuses it; `unavailableOpenCodeModelCatalog()` answers `source: 'none'`; and
`opencodeProvider.textDelivery()` returns `null` for every dwarf, so the composer shows the generic
no-channel copy (#507). #445 planned to fix all of it through a held session over the SDK; that
remains the route for questions, permissions and interruption. Launch, catalogue and messages need
none of it: the CLI ships `opencode models --verbose`, `opencode run -m … --variant …` and
`opencode run --session <id>`, all measured on 2026-09-21 (issue body, and the measurement report
the writer is handed).

## Why this shape and not another

- **Session id, not pid.** The continuation channel joins by the session id read from
  `opencode.db`, which is exact. #231's rule against acting on a guessed pid is untouched: nothing
  here guesses.
- **Mirror Codex, do not invent.** `codex exec` → `opencode run`; `codex-exec-resume` →
  `opencode-run-continue`; the Antigravity live catalogue spawn → the OpenCode one. Same
  `LaunchedSessionRegistry` correlation (mine + provider + first new root), same `resolveProgram`
  spawn, same `LaunchInvocation.stdin` rule.
- **Prompt on stdin, never argv** (`launch.ts:252`): measured to work for both `run` and
  `run --session`; positional and stdin concatenate, so the argv must carry no message.
- **No shell hop.** Spawning through `cmd.exe` recorded the session under the parent directory
  (2/2); direct spawn recorded it correctly (4/4). `resolveProgram` already spawns the shim's node
  entry directly; keep it that way and pin it with a test.
- **Close stdin.** An open stdin pipe hangs an already-finished `run` forever; write, then `end()`.
- **cwd = the session's own directory** for continuation. From another directory the CLI hung for
  120 s while the turn completed in the store in about 2.5 s.
- **One continuation in flight per session, and hold while working.** Two concurrent continuations
  race (three assistant rows for two prompts). Reuse the hold-while-busy behaviour #457 gave a
  launched Codex dwarf; never spawn a second `run --session` for the same id while one is alive.
- **`delivered` = handed over.** Process alive past the start window with stdin written, or exited
  0 inside it; failure = non-zero exit inside the window with the stderr tail. ✓✓ stays the
  renderer's reading of the store (working edge or new assistant message), exactly as for Codex.
- **Roots only.** A worker (child session) gets no channel of its own in this change; the foreman
  hop for OpenCode is unmeasured and out of scope.
- **Kick:** an observed OpenCode dwarf stays a dismissal; a launched `run` process is ended through
  `launched-process` as today for Codex.

## Scope

**Authorized:** `src/shared/contracts.ts` (one new `TextDeliveryChannel` member and its
`channelCarriesAttachments`/`ATTACHMENT_CHANNELS` treatment: none), `src/main/domain/`
(`launchProviders.ts`, `agentModelCatalog.ts`, `launchTuning.ts`), `src/main/sessionLaunch/`
(`launch.ts`, `launchRunner.ts` only if a provider-agnostic seam needs it), a new
`src/main/providers/opencode/models.ts` (catalogue spawn + parser) and the runtime arm in
`runtime.ts` `listAgentModels`, a new `src/main/textDelivery/opencodeContinue.ts` modeled on
`codexResume.ts`, `src/main/providers/opencode/opencodeProvider.ts` (`textDelivery()` for roots,
directory carried on the target), `src/main/textDelivery/resolve.ts` and `port.ts`
(`SendEndpoint`/`KickEndpoint` exclusions), `src/renderer/src/lib/delivery/actionBar.ts`
(`CHANNEL_HINT`, `LAUNCH_COMMAND` already truthful), their tests, `docs/opencode-format.md`,
`README.md` support matrix, `docs/guide.md`, `docs/console-hosting.md` (channel matrix, including
the missing `codex-exec-resume` row), `docs/privacy.md`, and this document. Renderer components
are expected to need **no** change (pickers and composer key off the catalogue and capabilities);
if one does, make the minimal change and say why.

**Out of scope:** held OpenCode sessions, questions, permissions, interruption (#445); attachments
on the new channel (`run -f`; measure later); a channel for worker dwarfs; changing how
`LaunchedSessionRegistry` correlates.

## Constraints

- Strict TDD (source: the maintainer's global configuration; runner `pnpm vitest run <file>`):
  RED observed before each implementation, GREEN after, refactor. Never a fake spawn that answers
  what the real one cannot (the #504 lesson): fakes for the runner must model exit code, stderr,
  and "still running at the window".
- `test-safety`: existing test files are append-and-amend only; census before/after per file; the
  `launchProviders.test.ts` pin "detected OpenCode is marked installed but not launchable" and the
  `opencodeProvider.test.ts` pin "textDelivery → null" are legitimately amended, with an
  `AMENDED for #534` note each.
- `platform-ports`: platform passed explicitly in every test; the shim resolution is win32-only and
  the POSIX bare name path must be asserted too.
- `privacy-guard`: invented paths and users only; the measurement rows in docs carry no pids, no
  usernames, no machine paths.
- `config-layering`: no new configuration key. `contracts.ts` stays free of Electron and Node
  imports; the new channel member is added there and re-exported through the barrels.
- Comments state the constraint and the why, in the register of `contracts.ts` and
  `codexResume.ts`. Technical artifacts in English. Conventional Commits, imperative, subject ends
  with `(#534)`, no attribution trailers. Prettier before every commit.

## Tasks

- [x] **T1 — Live model catalogue for OpenCode.** Route: delegated (writer).
      `src/main/providers/opencode/models.ts`: build the `opencode models --verbose` command, run
      it through an injected runner with the catalogue timeout, parse id-line + JSON blocks into
      `ModelOption[]` with `effortLevels = Object.keys(variants)` when non-empty; reject on
      unparseable output. `agentModelCatalog.ts`: replace `unavailableOpenCodeModelCatalog` with
      `source: 'provider'`; `launchTuning.ts` `PROVIDER_EFFORT_LEVELS.opencode` becomes the union
      the picker may show, or stays per-model only (follow the Claude per-model precedent and say
      which). `runtime.ts` `listAgentModels` gains the arm. Tests: parser fixtures with a
      variants model, a variant-less model, malformed output; catalogue shape; runtime arm with a
      fake runner and a timeout.
- [x] **T2 — Launch from the Add Panel.** Route: delegated (same writer). Code and unit tests
      done; the parent's own acceptance run (real app, real launch) is still pending — see below.
      `'opencode'` joins `LAUNCHABLE_PROVIDERS`; `buildOpenCodeLaunchArgs(tuning)` →
      `['run', '-m', model, ...(effort ? ['--variant', effort] : []), '--format', 'json']`, prompt
      on `stdin`; `buildLaunchArgs` arm replaces the refusal. Tests: argv with and without effort;
      the prompt never in argv; `launchRunner.test.ts` case that the spawn goes through
      `resolveProgram` with the mine as `cwd` and no shell; `launchProviders.test.ts` amended pin.
      Then the parent runs the real app once and launches an OpenCode session from a mine to
      confirm the dwarf appears and `launchId` is stamped (acceptance, recorded in Progress).
- [ ] **T3 — `opencode-run-continue` channel.** Route: delegated (same writer).
      `contracts.ts`: new `TextDeliveryChannel` member with a doc comment stating what ✓ means
      here (the turn was handed over, not read); not an attachment channel. `opencodeContinue.ts`:
      `buildOpenCodeContinueArgs(sessionId)` → `['run', '--session', sessionId, '--format',
'json']`, `deliverViaOpenCodeContinue` spawning through `resolveProgram` with `cwd` = the
      target's `directory`, text on stdin then `end()`, start-window verdict as in
      `codexResume.ts`, and a per-session in-flight guard so a second send while one runs is
      held, not spawned. `opencodeProvider.ts`: `textDelivery()` returns the target for every root
      session (`sessionId`, `directory`), still `null` for workers. `resolve.ts`/`port.ts`:
      `SendEndpoint` gains the channel, `KickEndpoint` excludes it. `actionBar.ts`
      `CHANNEL_HINT['opencode-run-continue']`: "Starts the next turn on this OpenCode session, with
      your message as its prompt." Reuse the hold-while-working behaviour for a busy dwarf (#457)
      and state in a comment why (M6 race). Tests: args, spawn cwd, stdin closed, verdicts
      (alive past window / exit 0 / non-zero with stderr tail / spawn throws), in-flight guard,
      provider target for root vs worker, resolve matrix rows, hint present.
- [ ] **T4 — Docs.** Route: delegated (same writer, may ride with T2 and T3 commits).
      `docs/opencode-format.md`: the measurements as `[V]` rows (models --verbose shape and
      variants; `run` on stdin and the DB timing; `--session` continuation, cross-directory hang,
      model swap, concurrency race; the shell-hop directory trap; the open-stdin hang), and the
      "What this settles" table updated (delivery channel no longer None). `README.md` support
      matrix row for OpenCode launch and message; `docs/guide.md`; `docs/console-hosting.md`
      channel matrix gains `codex-exec-resume` (missing today) and `opencode-run-continue`;
      `docs/privacy.md` names the launch and the continuation as processes this app starts.

## Acceptance

On Windows with OpenCode 1.18.31: the Add Panel offers OpenCode with the live model list and an
effort picker for a model with variants; launching creates exactly one dwarf, found by the observer
in the mine with `launchId` stamped; a message typed into its composer appears as the next user
turn of the same session and the reply arrives; the same composer works on an OpenCode session the
person opened in a terminal in that mine; two quick messages become two turns, not a race; no
`opencode` process is left hanging after the turn ends. All seven CI checks green; no test touches
a live CLI or the real store.

## Checks

The seven checks `CONTRIBUTING.md` lists, in CI's order, plus the per-file test census from
`skills/test-safety/SKILL.md` on every test file touched. No known environmental failures.

## Delivery

Strategy: `ask-on-risk`, chain strategy cached from this session: **stacked to main**. Slice 1 =
T1 + T2 (+ their docs); slice 2 = T3 + T4 remainder, based on slice 1. Forecast: ~450 lines for
slice 1, ~500 for slice 2, most of it tests and docs; the code itself is small and mirrors Codex.
RDD is off on this machine; verification is writer self-verification plus an independent verifier
per slice (the `high` tier's off path), plus the parent's spot check and the acceptance run.

## Progress

Created 2026-09-21. Worktree `DwarfAI-Miners-worktrees/feat-opencode-run`, branch
`feat/opencode-run-launch-and-continue` off `main` ee21d9c. Measurement report (outside the repo):
the writer receives its path; its facts land in `docs/opencode-format.md` under T4.

### T1 — done, 2026-09-21

RED (observed, then reverted): `src/main/providers/opencode/models.test.ts` failed on
`Cannot find module './models'` before `models.ts` existed. `src/main/runtime/runtime.test.ts`'s
two most load-bearing new cases ("asks the CLI for OpenCode's own live models when installed",
"...outruns its bound") were re-proven RED by temporarily `git stash`-ing the `runtime.ts` arm and
restoring it afterward — `expected "vi.fn()" to be called ... Number of calls: 0` /
`expected "warn" to be called once, but got 0 times`. GREEN: all touched suites pass; full
`pnpm test` is green (7898 passed, 5 skipped).

Decision — `PROVIDER_EFFORT_LEVELS.opencode`: **not** per-model only. The renderer's effort
picker (`effortPicker` in `src/renderer/src/lib/launch/modelTuning.ts`, read by
`AddPanel.vue`'s effort `<select>`) draws its options from `AgentModelCatalog.efforts` alone —
never from a chosen model's own `ModelOption.effortLevels` — for every provider today, Claude
included. Leaving `PROVIDER_EFFORT_LEVELS.opencode` at `[]` would have kept the effort row hidden
for every OpenCode model regardless of the live catalogue, contradicting the acceptance
criterion. Set to the union of every key M1 observed across the 19 of 34 models carrying a
non-empty `variants` map: `['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
'thinking']`. `ModelOption.effortLevels` is still carried per model (honest wire data, matching
Claude/Antigravity precedent) even though the renderer does not narrow by it yet — documented in
both `agentModelCatalog.ts` and `launchTuning.ts`.

Ripple found and fixed (mechanical, not a scope change): `PROVIDER_EFFORT_LEVELS.opencode` going
non-empty broke two `src/main/jev/routeRequest.test.ts` cases that had used OpenCode's
then-empty entry as their "provider with no effort ladder" example (comment there already
flagged this as a synthetic shortcut, "for the day one does"). Fixed by building a local
synthetic `{ ...PROVIDER_EFFORT_LEVELS, opencode: [] }` table in those two tests instead of
relying on a real provider's gap — no production `jev/` code changed.

Files touched: `src/main/providers/opencode/models.ts` (new), `models.test.ts` (new),
`src/main/domain/agentModelCatalog.ts`, `agentModelCatalog.test.ts`, `src/main/domain/launchTuning.ts`,
`launchTuning.test.ts`, `src/main/runtime/runtime.ts`, `runtime.test.ts`,
`src/main/jev/routeRequest.test.ts`.

Census (`node skills/test-safety/assets/test-census.mjs`, working tree vs HEAD, taken before
commit): `agentModelCatalog.test.ts` 19→23 (+4), `launchTuning.test.ts` 32→32 (0, one pin
replaced in place), `routeRequest.test.ts` 14→14 (0, two pins amended in place), `models.test.ts`
0→14 (+14, new file), `runtime.test.ts` 415→420 (+5). Net +23 across 5 files; exit 0, no file
lost test statements.

Amended assertions (test-safety, `AMENDED for #534` in each): `agentModelCatalog.test.ts`'s
`unavailableOpenCodeModelCatalog` pin (was permanent `source: 'none'`/`efforts: []`, now the
failure-fallback shape with the non-empty boundary); `launchTuning.test.ts`'s
`PROVIDER_EFFORT_LEVELS.opencode` pin (was `[]`); `routeRequest.test.ts`'s two "empty effort
ladder" cases (now build a synthetic table instead of reading OpenCode's real entry).

Checks run for T1 alone: `pnpm typecheck` clean; `pnpm lint` clean; `pnpm exec prettier --write`
on every touched file; `pnpm format:check` clean (only the untracked feature doc itself flagged,
fixed below); `node skills/skill-sync/assets/sync.mjs --check` — AGENTS.md already up to date;
full `pnpm test` green.

Commit: T1 committed as `feat(agents): ask OpenCode's own CLI live for its model catalogue (#534)`.

### T2 — code and unit tests done, 2026-09-21; acceptance pending

RED (observed): `launch.test.ts`'s new `buildOpenCodeLaunchArgs` cases failed with
`TypeError: buildOpenCodeLaunchArgs is not a function` before `launch.ts` carried it;
`launchProviders.test.ts`'s two amended cases failed on the old `['claude', 'codex',
'antigravity']` / refused-with-`NOT_LAUNCHABLE` shapes. `launchRunner.test.ts`'s 8 new/amended
"launching OpenCode" cases were proven RED by temporarily `git stash`-ing `launch.ts` and
`launchProviders.ts` and restoring afterward — all 8 failed for the expected reasons (`TypeError:
buildOpenCodeLaunchArgs is not a function`, `error: 'That agent cannot be started from the panel
yet.'`, `Cannot read properties of undefined (reading '0')` for a `run` that was never called).
GREEN: all touched suites pass after implementation.

Two further ripples found only by running the **full** suite (not visible from the touched files
alone), both mechanical consequences of `'opencode'` joining `LAUNCHABLE_PROVIDERS`, both fixed:

1. `src/main/jev/routeRequest.test.ts` — already fixed under T1 (`PROVIDER_EFFORT_LEVELS.opencode`
   going non-empty), no further change needed here.
2. `src/main/runtime/runtime.test.ts > AgentRuntime.launchAgent > refuses to launch OpenCode
before ever probing its own detector` — a real hazard, not just a stale assertion. This test
   built `AgentRuntime` with **no injected `launchSession`**, deliberately exercising the real
   default composition (`launchClaudeSession` + the real `runLaunchProcess`) to prove
   `launchRunner.ts`'s old gate refused OpenCode before `cliDetector.detect` was ever called. Once
   the gate stopped refusing, this same test — unchanged — actually attempted a **real
   `child_process.spawn`** for the path `/opt/opencode` it invents, observed live as `error:
"OpenCode could not be started: /opt/opencode — ENOENT."` (a real ENOENT from the OS, not a
   mock). Fixed by changing the injected detection verdict to `installed: false` instead of a
   fabricated installed path: this keeps the test on the REAL default composition (still proving
   `cliDetector.detect('opencode')` is now reached, which is the fact that changed) while
   returning from `launchClaudeSession`'s "not installed" branch before `resolveProgram`/`run` are
   ever reached — no real spawn, on the same safety terms every other "not installed" case in that
   file already relies on. Renamed to `reaches its own detector for OpenCode now, refusing only
because it is not installed`.

`LaunchedSessionRegistry.observe` correlation — confirmed needs no change. `observe()` matches a
launch record to a mine by plain string equality (`mine.path === record.minePath`), not by any
provider-derived path; both sides are this app's own already-known mine path (the mine the user
picked before launching), never a raw value from a provider's own cwd column. The provider's own
cwd only participates in `aggregate.ts`'s EARLIER step — grouping `ProviderSnapshot`s into mines
by `normalizePathKey(trimTrailingSlashes(snapshot.cwd), platform)` — which already runs
identically for every provider, including OpenCode (`opencodeProvider.ts`'s existing,
unchanged-by-this-slice `cwd: normalize(session.cwd)`, itself already folded again by
`normalizePathKey` in `aggregate.ts`, which handles the forward-slash-on-Windows case the
measurement report flags). So a launched OpenCode session aggregates into the same `Mine` object a
declared project already has, on the same terms Codex's and Antigravity's launched dwarfs already
do, with no provider-specific fix needed. No code change; no new test added (the acceptance run
below is the live proof).

`runLaunchProcess`/`buildLaunchSpawn` — confirmed needs no change. Neither branches on provider;
`stdio: ['pipe', 'ignore', stderrFd]` and no `shell: true` are already unconditional, which is
exactly what Row 8 (`docs/opencode-format.md`) needed proven — no shell hop, ever — so OpenCode
inherits it for free.

Files touched: `src/main/sessionLaunch/launch.ts`, `launch.test.ts`,
`src/main/domain/launchProviders.ts`, `launchProviders.test.ts`,
`src/main/sessionLaunch/launchRunner.test.ts`, `src/main/runtime/runtime.test.ts` (the
`launchAgent` ripple fix), `src/renderer/src/lib/delivery/actionBar.ts` (comment only, no test
change — `LAUNCH_COMMAND.opencode`'s own comment said OpenCode's launch was unreachable, which
`'opencode'` joining `LAUNCHABLE_PROVIDERS` made false). Docs (T4 partial, riding with this
commit): `docs/opencode-format.md` (Rows 6–9, "What this settles" table, two accuracy amendments
to Rows 5/5b whose stated consequences the new rows changed), `README.md` (provider support
matrix), `docs/guide.md` (launchable-providers summary, the effort-levels enumeration, the
OpenCode paragraph rewritten for its new launch capability).

Census (working tree vs HEAD, taken before commit): `launchProviders.test.ts` 13→13 (0, one pin
replaced in place), `runtime.test.ts` 420→420 (0, one case renamed/restructured in place),
`launch.test.ts` 36→44 (+8), `launchRunner.test.ts` 59→66 (+7). Net +15 across 4 files; exit 0, no
file lost test statements.

Amended assertions (test-safety, `AMENDED for #534` in each): `launch.test.ts`'s
`buildLaunchArgs('opencode')` refusal pin (was a throw); `launchProviders.test.ts`'s "detected
OpenCode is marked installed but not launchable" pin (now the opposite) and its
`LAUNCHABLE_PROVIDERS` contents pin; `launchRunner.test.ts`'s "refuses OpenCode before ever
probing the disk for it" pin (now proves a successful launch instead); `runtime.test.ts`'s
`launchAgent` OpenCode case (restructured as above, for safety, not just to flip an assertion).

Checks run for T2 + docs: `pnpm typecheck` clean; `pnpm lint` clean; `pnpm exec prettier --write`
on every touched file; `pnpm format:check` clean; `node skills/skill-sync/assets/sync.mjs --check`
— AGENTS.md already up to date; full `pnpm test` green (7913 passed, 5 skipped); `pnpm build`
green (main, preload and renderer all built).

**Pending for the parent (acceptance, per the task contract):** run the real app on Windows with
OpenCode 1.18.31 installed, launch an OpenCode session from a mine, and confirm (a) the Add Panel
offers OpenCode with a live model list and an effort picker for a model with variants, and (b) the
launch produces exactly one dwarf, found by the observer in the mine with `launchId` stamped. Not
run by this writer — no live OpenCode CLI round trip is authorized inside a unit test, and the
task assigns this specific check to the parent.

Decision on `runLaunchProcess`/`buildLaunchSpawn` and the provider's `cwd` derivation: neither
needed a change (see above) — both were already provider-agnostic in exactly the shape OpenCode
needed.

Commit: T2 (+ docs) committed as
`feat(agents): launch OpenCode from the Add Panel via \`run\` (#534)`.

### Slice 1 verification of record, 2026-09-21

**Parent spot check.** Two Conventional Commits (`c480060`, `0e2a2d7`), no attribution trailers,
clean tree; 19 files, 1613 insertions and 135 deletions against the merge base `ee21d9c`
(`origin/main` had moved on with unrelated work; two-dot diffs against it are misleading here).
Privacy scan of the merge-base diff clean. Re-ran `models.test.ts`, `launch.test.ts`,
`launchProviders.test.ts`, `agentModelCatalog.test.ts`: 94 passed, 0 failed.
`gentle-ai review assess --base-ref ee21d9c`: `high` (process boundary in `agentModelCatalog.ts`);
RDD is off, so the off path applies: writer self-verification plus an independent verifier.

**Independent verifier (Sonnet, read-only): `pass-with-follow-ups`.** Parser fixtures confirmed
representative against a fresh live capture (same keys, nested `api` object, `variants` shape);
malformed and empty output throw. Spawn path confirmed: `resolveProgram`, no `shell`, prompt on
stdin written and closed in one call (`launchRunner.ts:534`), `cwd` = the mine. Registry
correlation confirmed with no OpenCode-specific gap: `observe` compares this app's own mine paths,
and the provider already normalises the store's forward slashes before aggregation. The
`runtime.test.ts` hazard fix is a legitimate behaviour migration (the detector is now reached and
the launch refuses on `installed: false`), with the installed path covered in `launchRunner.test.ts`.
Census against `ee21d9c`: net +38 across 8 files, no file lost a test.

**Live measurement by the verifier (free model, scratch directory):** `opencode run --variant high`
on a model with `variants: {}` and `--variant xhigh` on a model whose list lacks it both exit 0,
reply normally, and record the variant in `session.model.variant`. The CLI never refuses an
unrecognised variant, so the union ladder cannot fail a launch.

**Follow-up, not blocking:** a person can pick an effort the chosen model ignores, with no
feedback. Narrowing the effort picker per selected model needs the renderer to read
`ModelOption.effortLevels`, which no provider does today. Worth its own issue.

**Acceptance run pending (parent/maintainer):** launch OpenCode from the Add Panel of the running
app, confirm one dwarf appears in the mine with `launchId` stamped and the live model list shown.
