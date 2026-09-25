# Privacy and data boundary

DwarfAI-Miners is a local desktop app. Almost everything it does happens on your machine: it reads
the local files Claude Code, Codex, Antigravity and OpenCode already write, renders them in a
floating panel, and keeps a handful of small files of its own. The one exception is Jev, an
optional launch assist that calls out to TypeSafe's API — off unless you turn it on, and covered
in full in [What it transmits](#what-it-transmits). This document states exactly what is read,
what is stored, and what is transmitted. Every claim names the source that implements it, so it
can be checked rather than trusted.

## What it reads

- **Claude Code session registries.** Every configured Claude root (default `~/.claude`, plus
  any further roots configured via `CLAUDE_CONFIG_DIRS`) is scanned for
  `sessions/*.json` entries — small per-session files carrying the pid, session id, project
  directory, and status. An entry counts as alive only while its pid exists, and it is dropped
  when the running process's real start time contradicts the one the entry recorded, so a
  recycled pid is caught wherever that start time can be read. Where it cannot be — no start
  time in the entry, or a probe that fails — the pid check stands alone
  (`src/main/providers/claude/claudeProvider.ts`).
- **Claude transcripts, tail only.** For live sessions the provider tail-reads the session's
  transcript `.jsonl`, and each running subagent's own
  `projects/<dir>/<sessionId>/subagents/agent-<id>.jsonl` — a bounded number of bytes from the
  end, never the whole file — to derive status, the last message, and the activity feed
  (`src/main/providers/claude/claudeProvider.ts`).
- **Codex rollouts and registries.** The Codex sessions root (default `~/.codex/sessions`,
  overridable with `CODEX_SESSIONS_ROOT`) is scanned for recent rollout `.jsonl` files, with
  bounded head and tail reads. When present, Codex's own SQLite databases
  (`~/.codex/state_5.sqlite` and `~/.codex/logs_2.sqlite`) are opened **read-only** for
  thread relationships and liveness heartbeats (`src/main/providers/codex/codexProvider.ts`,
  `src/main/adapters/sqliteLike.ts`).
- **Antigravity's own store.** The `agy` CLI's directory (default `~/.gemini/antigravity-cli`,
  overridable with `ANTIGRAVITY_STORE_ROOT`) is read for three things: the presence lock the CLI
  writes per running conversation, `history.jsonl` for which workspace a conversation belongs to,
  and the conversation's `transcript.jsonl` for the feed and for whether a turn is still open
  (`src/main/providers/antigravity/antigravityProvider.ts`, `discovery.ts`, `parse.ts`). Read-only,
  bounded, and in place.
- **`opencode.db`, read-only.** The OpenCode CLI's SQLite store (default
  `~/.local/share/opencode`, overridable with `OPENCODE_STORE_ROOT`) is opened **read-only** for
  session rows, an event log used only for liveness, and message/part rows for the feed — the
  same read-only seam Codex's own databases go through. No other file under that store is ever
  listed or read (`src/main/providers/opencode/opencodeProvider.ts`, `state.ts`,
  `src/main/adapters/sqliteLike.ts`).
- **Project directories: names, sizes, and the first 4 KB of every source file counted.** To
  pick a mine's tier, the tier service walks the project directory and adds up the byte size
  of the source files it finds — a bounded, capped walk that skips `node_modules`, `.git`,
  `dist`, `out`, `.venv`, `target`, `release`, and `build`. It also reads the first 4 KB of
  each file it counts and hashes that sample, so a file copied into several places is counted
  once instead of inflating the tier. Neither the sample nor its hash outlives the walk: both
  are held in memory for that one walk, and nothing about them is stored, displayed, or sent
  (`src/main/tier/tierService.ts`).
- **Process lists, and process start times.** Liveness probes ask the operating system whether
  a pid is alive, when that process started, and whether a `codex` process is running —
  PowerShell `Get-CimInstance Win32_Process` on Windows, `pgrep -f` and `ps -o lstart=`
  elsewhere (`src/main/platform/processProbe.ts`).
- **Two small git files, to tell a worktree from its project.** To fold every git worktree of a
  repository into its main working tree's mine, a session's `cwd` is walked upward for a `.git`
  entry; where that entry is a file (a worktree checkout, never a main one) its `gitdir:` pointer
  is read, then the `commondir` file beside the directory it names, and — once a worktree is
  confirmed — the `HEAD` file, for the branch it has checked out. Each read is capped at 4 KB, no
  `git` binary is ever run, and a folder that is not a worktree costs one stat and nothing more
  (`src/main/projects/worktree.ts`).

- **Files you attach to a message, and only those.** Attaching a file — by dropping it on the
  composer or through the picker — lets the app measure it (its size, and whether it is a folder),
  and, for an image inside the size limit, decode it once to draw the 40px chip you see. Nothing is
  copied anywhere: the path you chose is the path handed to the session, and for a session this app
  holds open the image's bytes are read at send time and go to that session and nowhere else — see
  [What it transmits](#what-it-transmits) for the turn that carries them off this machine. No
  directory is walked, no sibling file is looked at, and a file you removed from the composer before
  pressing Enter is never read again (`src/main/textDelivery/attachmentFiles.ts`, #408).

### The one-time history scan

The widest read this app performs happens on its first launches, and you should know about it
before you install. To fill the coal pile — the material standing for every token burned
_before_ DwarfAI-Miners existed on your machine — it walks **every Claude project directory
under every configured Claude root, every day directory under the Codex sessions root, and every
session row in the OpenCode store**, not only the sessions that are live. In each Claude and Codex
file it reads only the transcripts and rollouts whose last write pre-dates that first launch: 64 KB
from the end of a Claude transcript, and 16 KB from the start plus 128 KB from the end of a Codex
rollout. The OpenCode read is a single SQL query over `opencode.db` instead of individual files,
since one session row already carries its own token counters and its own last-write time; a
session still being written to at that first launch is skipped the same way a Claude or Codex file
still being written to is. From each source it keeps two things — the project path it records, and
its final token count. Message text is parsed and discarded (`src/main/ledger/coalBackfill.ts`,
`src/main/ledger/coalScan.ts`).

Antigravity is not part of that scan, and not by choice: its format records no token usage at all,
so there is nothing in it to count.

The scan is bounded rather than instantaneous: at most 1 500 files or 8 seconds per launch,
and never more than 400 files out of any single directory. It therefore resumes across
launches until it has been round the whole tree once, and then never runs again. What it
produces is a floor on your past usage rather than an audit — subagent transcripts, anything
past the per-directory limit, and any transcript carrying no project path are all left out.

## What it stores, and where

Everything the app keeps lives in Electron's per-user data directory:

| Platform | Directory                                      |
| -------- | ---------------------------------------------- |
| Windows  | `%APPDATA%\DwarfAI-Miners`                     |
| macOS    | `~/Library/Application Support/DwarfAI-Miners` |
| Linux    | `~/.config/DwarfAI-Miners`                     |

Fourteen entries: thirteen the app writes, and one (`config-v1.json`) it only reads. All but
`hook-token` and the SQLite database are plain JSON or an empty marker, so you can read them in any
text editor.

**Your preferences** — one tiny JSON document each, so a corrupt one can only cost you that one
setting:

| File                             | Purpose                                                                                                                                                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pin-preference-v1.json`         | Whether you left the panel pinned always-on-top (`src/main/shell/pinPreference.ts`).                                                                                                                                                   |
| `shortcut-preference-v1.json`    | The global panel-toggle accelerator you chose (`src/main/shell/shortcutPreference.ts`).                                                                                                                                                |
| `panel-edge-v1.json`             | Which screen edge the docked shell opens on (`src/main/shell/panelEdgePreference.ts`).                                                                                                                                                 |
| `message-panel-position-v1.json` | Where you last dragged the message panel's window (`src/main/shell/messagePanelPosition.ts`).                                                                                                                                          |
| `audio-preferences-v1.json`      | Whether music starts on launch, and the three volumes (`src/main/shell/audioPreference.ts`).                                                                                                                                           |
| `jev-preferences-v1.json`        | Your Jev routing profile (`economy` / `balanced` / `premium`) and default launch (provider, model, effort) — plain JSON, not a secret; re-validated against the launch gate before it is written (`src/main/shell/jevPreferences.ts`). |

**Markers and secrets:**

| File                               | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autostart-default-v1.marker`      | Remembers that the packaged app already applied its one-time autostart default, so a tray opt-out is never overridden (`src/main/index.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `hooks-enabled.marker`             | Remembers that you opted into instant updates (`src/main/hooks/hookChannel.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `hook-token`                       | The per-install random secret that authenticates hook requests, shared by the Claude hooks channel and the OpenCode permission relay below. It is embedded in the hook commands in your own Claude config and, when you opt into the relay, in the OpenCode plugin file too — goes nowhere else. Written owner-only (`0600` on macOS/Linux; a harmless no-op on Windows, whose per-user profile directory the OS already restricts) since #588 T6 (`src/main/hooks/hookToken.ts`, `src/main/hooks/hookFs.ts`'s `writeSecretText`).                                                                 |
| `opencode-plugin-enabled.marker`   | Remembers that you opted into the OpenCode permission relay, exactly like `hooks-enabled.marker` above (`src/main/opencodePermissions/openCodePluginChannel.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `opencode-server-password-v1.json` | The optional OpenCode server password you type into Settings' OpenCode section, stored the same way as the Jev key below — Electron `safeStorage` ciphertext only, `{}` when cleared, no plaintext fallback where encryption is unavailable (`src/main/opencodePermissions/openCodeServerPassword.ts`). See [What it transmits](#what-it-transmits) for what it is used for.                                                                                                                                                                                                                       |
| `jev-api-key-v1.json`              | The TypeSafe API key you type into Settings for Jev, holding only Electron `safeStorage` ciphertext — base64 in `{ "encrypted": "..." }` — never the plaintext key. Clearing the key rewrites the file to `{}`. There is no plaintext fallback: on a machine (typically Linux, with no real keyring behind it) where `safeStorage.isEncryptionAvailable()` reads false, nothing is ever written here and the option shows why it is off instead (`src/main/shell/jevApiKey.ts`, `src/main/adapters/safeStorageLike.ts`). See [What it transmits](#what-it-transmits) for what the key is used for. |

**Read, never written:**

| File             | Purpose                                                                                                                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config-v1.json` | Settings for an installed app, which has no repository `.env` to read. It is read on every launch; no screen in the app writes it, so it exists only if you created it by hand (`src/main/config/configFile.ts`). |

**Your history** — the two entries that accumulate, and the ones worth reading the next section
about:

| File                    | Purpose                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projects-v1.db`        | One SQLite file holding the projects list (name, **absolute path**, measured tier, when it was added, when it was last active, and whether you have removed it from the list), the material vault, and the sessions this app has launched (`src/main/appDatabase/appDatabase.ts`, `src/main/projects/projectsStore.ts`, `src/main/ledger/sqliteLedgerStore.ts`). Opened read-write; nothing else reads it. |
| `coal-backfill-v1.json` | The history scan's bookmark: when it first ran, whether it has finished, and — while it has not — the absolute paths of the transcript directories it has already read (`src/main/ledger/coalBackfill.ts`).                                                                                                                                                                                                |

One more file may be there from an older version. `material-ledger-v1.json` was the vault before it
moved into the database. It holds the same thing — cumulative tokens per material, keyed by absolute
project path, plus a last-seen counter per session id. On the first launch after the move it is read
once and then **kept as a backup and ignored forever**; nothing in the app ever writes to, renames,
or deletes it (`src/main/ledger/ledgerMigration.ts`). It becomes the live vault again only on a run
where the database will not open, which the app says in its log
(`src/main/ledger/openLedgerStore.ts`). Delete it yourself if you would rather it not sit there —
after the move, nothing needs it.

Every JSON document above is rewritten through a sibling `.tmp` file and a rename, so an
interrupted write can only leave the previous file intact, plus at worst a stray `.tmp` beside
it.

Outside that directory, and only if you opt into **Instant updates (Claude hooks)**:

- one hook entry per event in each Claude root's `settings.json`, every entry carrying the
  `dwarfai-miners-hook` marker so install and uninstall can never touch another tool's hooks
  (`src/main/hooks/hookInstaller.ts`);
- a one-time pristine backup of each modified `settings.json`, saved beside it as
  `settings.json.dwarfai-backup` and never overwritten afterwards.

And only if you opt into the **OpenCode permission relay**, in Settings' OpenCode section (#588 T6):

- one file, `dwarfai-miners-permission.ts`, written into OpenCode's own **global** plugin
  directory — `$XDG_CONFIG_HOME/opencode/plugin` when that variable is set to an absolute path,
  else `~/.config/opencode/plugin`, the same rule on every platform since OpenCode itself resolves
  it with no OS branch (`src/main/opencodePermissions/openCodePluginInstaller.ts`,
  `openCodeGlobalPluginDir`);
- that file carries, in plain text, the exact same per-install token the Claude hooks channel
  trusts (see the `hook-token` row above) — a coupling Settings itself states before you turn the
  relay on, not only here — and is written owner-only, the same as `hook-token`
  (`installOpenCodePlugin`, `src/main/hooks/hookFs.ts`'s `writeSecretText`);
- written only when you turn the relay on, rewritten in place if OpenCode's listening port or this
  app's token has changed since, and removed the moment you turn it off — a file at that path this
  app did not write is left untouched either way
  (`src/main/opencodePermissions/openCodePluginChannel.ts`, `openCodePluginInstaller.ts`).

When autostart is on, the platform's standard autostart entry also exists — the HKCU `Run`
key, a LaunchAgents plist, or an XDG autostart desktop entry; the README's startup section
lists the exact locations.

**The vault is a durable record of your projects, and it is worth being plain about it.**
`projects-v1.db` holds one row per project you have run an agent in, named by its absolute path,
with a running token total beside it — so it says which projects exist on this machine and roughly
how much work each has had. Nothing prunes it by project: a project you deleted a year ago keeps its
row and its totals, and **removing a mine from the Mines list does not remove it either** — that
control sets a "you stopped tracking this" timestamp, which is exactly why adding the folder again
brings the mine back with its ore. Settings' **Reset metrics** wipes the material totals; it is the
only thing in the app that does. While the history scan is unfinished, `coal-backfill-v1.json`
likewise lists transcript directory paths.

Beyond those files nothing is copied. Transcripts, rollouts, and Codex's SQLite files are read
in place, and no message text the panel displays is written to disk by this app.

**A finished turn's own conclusion, kept in memory only (#510).** A held session (Claude,
Antigravity) keeps its most recently finished turn's outcome: whether it concluded, was capped,
errored, or was interrupted; the provider's own word for what happened; the turn's own final
text, when the provider handed one over, bounded to the same 250,000-character ceiling every
message on this wire answers to; and when it ended (`Dwarf.lastTurn`, the `TurnOutcome` type in
`src/shared/contracts.ts`, read off the provider's own end-of-turn message by
`claudeTurnOutcome.ts`'s `resultTurnOutcome` and `antigravityHeldSession.ts`'s `turnOutcomeOf`). A
held Claude session's own subagent crew keeps the same shape for the last 50 conclusions it has
sealed (`HeldCrew`, `MAX_ENDED_CONCLUSIONS`, `heldCrew.ts`). A one-shot launch this app started and
is still watching — Codex or OpenCode today — keeps one outcome the same way, read off its own
exit status and stdout (`oneShotTurnOutcome.ts`, kept on the launch's own record in
`LaunchedSessionRegistry`, `launchedSessions.ts`). None of it reaches `projects-v1.db` or any
preference file: it lives only in this process's memory, for as long as the session or the launch
record does, and is gone the moment the app restarts.

That does not loosen the promise just above. A held session's turn text is still never written to
disk — it is the same conversation text this app already keeps only in memory, carried one field
further. A one-shot launch is where that promise now has one transient, honest exception. To read
back what its own process actually wrote, this app captures that process's stdout to a temp file
it creates beside the stderr file it already captured for early-failure detection
(`StdoutFile`/`StderrFile`, `launchRunner.ts`) — both under Node's own OS temp directory, never
this app's own data directory — reads back a bounded tail of it once the process exits (16 KB,
`STDOUT_TAIL_BYTES`), and deletes it. Codex's own `--output-last-message` file, which Codex writes
itself with just the turn's clean final message, is read back and deleted the same way whenever it
has anything in it. Both happen only if this app is still running to see the process exit: a
detached launch is built to survive the panel quitting, so a launch that outlives the panel leaves
its temp file behind in the OS temp directory, orphaned — exactly as its stderr counterpart
already could, before this app ever read either back.

## What it transmits

The application code contains exactly one outbound HTTP client, and it exists for exactly one
reason: Jev, an optional launch assist that asks TypeSafe's API to pick a provider, model and
effort for a prompt before you launch it (#509). Outside of Jev there is still no telemetry, no
analytics, no crash reporting, and no auto-updater — session data, transcripts, and project paths
are never sent anywhere by DwarfAI-Miners. What follows says exactly what that one client's own
traffic carries — one request always, a second sometimes (#608) — then the boundaries that keep
everything else local.

### Jev: the outbound calls

Jev fires only when both are true: you have entered your own TypeSafe key in Settings, and turned
on **Let Jev choose** in the Add Panel. With both true, pressing Enter on the composer sends **one
or two** requests to `https://api.typesafe.ai/v1/systemone`, over TypeSafe's own `@typesafe-ai/sdk`
(`createTypesafeJevRouter`, `src/main/jev/typesafeJevRouter.ts`; the exact URL is pinned in
`typesafeJevRouter.test.ts`), before the launch itself goes out
(`submit`, `src/renderer/src/composables/useAgentLaunch.ts`). The first request is always sent when
Jev fires at all; the second is sent only when the first resolves a provider and tier with two or
more live, launchable candidate models to choose between (#608) — see "Request 2" below for exactly
when and what it sends.

### Request 1: five questions about the prompt

**What leaves:** the `state` object is exactly `{ prompt, routing_profile }` — the prompt as typed,
and the routing profile you chose in Settings (`economy`, `balanced` or `premium`, one of those
three words and nothing else about this machine). Jev answers **five fixed questions about the
prompt**, asked in one request, with criteria written by this project rather than read off any
model's own description (`buildJevRouteRequest`, `src/main/jev/routeRequest.ts`):

- **`is_trivial`** — is this small talk or a one-line factual question, or a real request to write,
  read, debug, explain or change code.
- **`needs_large_context`** — does this need many files, modules or a large pasted corpus, or is it
  scoped to one file or function.
- **`provider`** — which agent CLI this machine can launch right now is the best tooling fit, judged
  on tooling and ecosystem fit only, never cost.
- **`model_tier`** — how capable a model this needs (`fast-cheap` / `balanced` / `frontier` /
  `long-context`), judged against the chosen routing profile's own rule.
- **`effort`** — a fixed four-level difficulty rubric, asked the same way regardless of which
  provider ends up chosen (`EFFORT_RUBRIC`, `src/main/jev/routeRequest.ts`).

No model id or name is ever asked for or sent in this request. Which live, launchable models this
provider and tier actually resolve to is worked out afterward, locally, and — since #608 — sometimes
asked about in a second request; see the next section.

**What comes back, in that one response:** five answers — a probability for each of the two yes/no
questions, a choice and Jev's own confidence for `provider` and `model_tier`, and a score for
`effort` — never a model name, since none was ever offered as an option
(`JevRouteAnswers`, `src/main/jev/jevRouterPort.ts`).

**Request size, as observed.** TypeSafe publishes no fixed per-request token count, so this is a
measurement from the maintainer's own `JEV_DEBUG` traces on this machine, not a guarantee: a live
request 1 ran **about 1,550–1,650 input tokens**, observed 2026-09-21, before #608 added request 2.
A future change to the question set, the criteria copy, or the launchable-provider count will move
this figure; re-measure from a live trace rather than trusting this number to stay current. This
figure is for request 1 only — request 2's own size has not been separately measured here; see its
own token-budget discipline below.

### Request 2: choosing the model among the tier's candidates (#608)

Request 1 never asks about a concrete model, and never did. What changed in #608 is what decides
one: once request 1 resolves a provider and a tier, this app looks up that provider's own live,
launchable, catalogued models at that tier — stepping down toward `balanced` then `fast-cheap` when
the resolved tier has none (`candidatesAtTier`, `src/main/jev/routeDecision.ts`). What happens next
depends on how many candidates that step-down walk finds:

- **Zero candidates.** Nothing to choose between — the launch falls back to your own configured
  default or the pickers' current values, the same as any other Jev fallback.
- **Exactly one candidate.** It is used directly, with no second request sent at all — there is
  nothing to ask Jev about (`resolveModelPart`, `src/main/jev/routeLaunch.ts`).
- **Two or more candidates.** A second request is sent, over those candidates only, sharing the
  15-second total launch budget request 1 already had — it is skipped, never sent, once nothing is
  left of that shared budget (`DEFAULT_TOTAL_BUDGET_MS`, `src/main/jev/routeLaunch.ts`).

**What leaves, in the second request:** the exact same `state` object as request 1 — the same prompt
(or its own truncated form, independently trimmed to the same token budget) and the same routing
profile — plus, for each candidate, its own capability text: **`what`**, **`notFor`**, **`examples`**,
its **`tier`**, its **`relativeCost`** band, and its **`contextWindowTokens`** when known
(`candidateCapabilityFacts`, `src/main/jev/routeRequest.ts`). Candidates are keyed by index (`'0'`,
`'1'`, …) in both questions the request asks — one yes/no "does this fit" question per candidate,
plus one Choice over the same set — never by the candidate's own model id
(`buildJevModelRouteRequest`, `src/main/jev/routeRequest.ts`; `JevModelRouteRequest`,
`src/main/jev/jevRouterPort.ts`; pinned by `routeRequest.test.ts`'s own `'carries what/notFor/examples
plus tier, relativeCost and contextWindowTokens — never the model id'` and `'keys every candidate by
index — never by its own model id — in both the fits and the choice questions'`).
**The model's own id, name, alias or family is never sent** — every candidate's description is the
same sourced capability text the [`jev-capabilities`](../skills/jev-capabilities/SKILL.md) skill's
evidence rule already governs for request 1's own criteria, never a label a matcher could read as a
name. That skill's own "What Jev never receives" section says why: the first live run that asked Jev
to choose among model names directly returned 0.38 confidence over eleven near-identical options.

**What comes back, in that response:** one "fits" probability per candidate, and the tie-breaking
Choice's own winning index plus its full probability distribution over the same candidates — never a
model name, since none was ever offered as one (`JevModelRouteAnswers`,
`src/main/jev/jevRouterPort.ts`). The winner is the candidate with the highest fit probability,
unless one or more others land within `MODEL_TIE_BAND` (0.02) of it — indistinguishable from the
measured run-to-run Noul noise the consistency cookbook documents — in which case the Choice's own
probabilities break the tie among that group, and a cost/profile rule breaks it again on an exact
Choice tie too (`selectModelWinner`, `src/main/jev/routeDecision.ts`).

**When request 2 cannot be used** — no key, unreachable, rate-limited, unauthorized, timed out, an
unusable answer, too large for TypeSafe's own budget, or simply no time left in the shared 15-second
launch budget — the launch falls back to the identical local cost/profile pick the local decision
always had (`candidatesAtTier` plus `cheapestOrPriciestCandidate`, `src/main/jev/routeDecision.ts`),
and the launch card says so by name rather than crediting Jev with a choice it did not make — see
"What comes back from the local decision" just below, and the [guide](guide.md#jev) for how the card
reads.

**The TypeSafe API key** rides every request as its bearer token — read from the encrypted store at
call time and never logged, for either request (`createTypesafeJevRouter`,
`src/main/jev/typesafeJevRouter.ts`).

**What never leaves, in either request:** project paths, session data, transcripts, usernames, model
names or ids, or anything else about this machine beyond the prompt's own text, the three-word
routing profile, and — in request 2 only — the sourced capability text above.
`routeRequest.test.ts` pins exactly that for the prompt: a test builds a request from a prompt
containing a fake local path and asserts the path appears in the prompt state and nowhere else in
the request (`'carries nothing about this machine but the prompt itself'`,
`src/main/jev/routeRequest.test.ts`).

**What comes back from the local decision, and what is done with it:** one decision on the wire — a
provider, an optional model, an optional effort level, the tier the local decision landed on, and a
per-part breakdown naming which parts were Jev's own answer versus a safe default a confidence floor
or the routing profile substituted — or a typed reason it could not decide, carrying your own
configured default launch when one is set (`JevRouteLaunchResult`, `src/shared/contracts.ts`). Before
that answer ever reaches the renderer, main checks it against the same gate every launch goes through
(`parseLaunchTuning`) — nothing crosses that `agent:launch` could not itself carry out
(`createJevLaunchRouter`, `src/main/jev/routeLaunch.ts`; `decideLaunch`,
`src/main/jev/routeDecision.ts`). The decision is then shown in a card that states the plain fact of
what is about to launch (provider, model, effort) and, only when a part actually has one, Jev's own
least certain confidence — never crediting Jev with a part it did not answer (`jevDecisionSummary`,
`src/renderer/src/components/launch/AddPanel.vue`). Below that, the card says part by part what Jev
answered and what fell to a safe value for the provider and the tier, and — since #608 — its own
sentence for the model step: which candidate Jev's second request picked and its fit percentage (plus
any Choice tiebreak), that only one candidate existed so no second question was asked, or which
reason the second request could not be used and that the local pick was used instead
(`jevPartsSummary`, `jevModelPartSentence`, `src/renderer/src/components/launch/AddPanel.vue`). The
card also notes whether the prompt was treated as trivial or a large-context model was preferred. It
is applied to the pickers, and can be overridden or dismissed; it is never a launch by itself;
pressing Launch again is what actually starts the session
(`src/renderer/src/composables/useAgentLaunch.ts`).

**When it does not happen:** no key is configured, the toggle is off, or the option is hidden
outright (no key) or shown disabled with the reason (this machine has no encrypted place to keep
one) — `JevSettings`/`JevUnavailableReason`, `src/shared/contracts.ts`. Whatever goes wrong after
that — unreachable, rate-limited, unauthorized, timed out, an unusable answer, no launchable
provider, or a request too large for TypeSafe's own budget — degrades to a typed fallback reason,
and the launch still happens on the pickers' current values, saying that it did (`classifyError`,
`src/main/jev/typesafeJevRouter.ts`; `createJevLaunchRouter`, `src/main/jev/routeLaunch.ts`).
`'low-confidence'` is still a named reason on the wire, kept for a distinguishable low-confidence
failure worth naming again in the future, but no path produces it today: every per-question floor
now resolves to a safe default instead — see the
[`jev-capabilities`](../skills/jev-capabilities/SKILL.md) skill's own tier-routing section. When you
have set a default provider, model or effort in Settings
(see [What it stores](#what-it-stores-and-where)), main attaches it to the fallback on the wire
(`fallbackTo`, `JevRouteLaunchResult`), and the panel applies it to the pickers exactly as it would
a decision, names it in the fallback line ("Your default, … is set below — press Launch again or
change it"), and waits for your Enter unless Auto-accept is on (`jevAnswered`,
`src/renderer/src/lib/launch/launchState.ts`; `AddPanel.vue`). Without a default, a chosen provider
launches on the pickers' current values; with none chosen either, nothing launches and the prompt is
kept (#523). The whole call is bounded at 15 seconds of this app's own wall-clock time
(`DEFAULT_TOTAL_BUDGET_MS`, `src/main/jev/routeLaunch.ts`), whatever TypeSafe's own retries do
underneath, so Jev can delay a launch but never hang one.

**Retention on TypeSafe's side.** This app controls only what it sends, not what TypeSafe keeps
once it has been sent, and this document states only what TypeSafe's own primary sources say
rather than paraphrasing beyond them. TypeSafe's [Privacy Policy](https://typesafe.ai/legal/privacy-policy)
states it will not "train or fine tune any artificial intelligence or machine learning models on
your prompts or other Input," and that it retains personal data "for as long as reasonably
necessary to provide you with the Services, or otherwise in support of our business or commercial
purposes" — no fixed number of days is published there. Its
[Data Processing Agreement](https://typesafe.ai/legal/data-processing) states the same open-ended
standard for data it processes on a customer's behalf: retained "for as long as necessary taking
into account the purpose of the Processing." Neither document verifies a specific retention period
for a System One request, so this document does not claim one. TypeSafe's
[legal index](https://docs.typesafe.ai/legal) separately names zero data retention as an option
for enterprise customers, reachable at `privacy@typesafe.ai`; this app makes no claim about which
tier its own requests fall under, and you would need to arrange that directly with TypeSafe.

### Subtask delegation

A session this app launches can hand a subtask back to the panel, which asks Jev which provider,
model and effort suit it, runs the subtask as its own session in the same mine, and returns what it
concluded (#511). It is off by default and stays off until three separate things are all true —
each is necessary and none is sufficient alone:

1. **A TypeSafe key is configured**, in Settings' Jev section.
2. **This launch was itself routed by an applied Jev decision** — "Let Jev choose" was on and Jev's
   choice was actually used, never a fallback onto a default (`AgentLaunchRequest.routedByJev`).
3. **Settings' own checkbox**, "Let Jev choose subagents by subtask complexity (BETA - CRITICAL WARNING)" — off by default,
   shown only once a key is configured (`JevSettings.vue`).

All three are re-checked at the moment of each real launch, never once per app session
(`delegationGate.ts`, `delegationEnabledFor`) — a session started on your own pickers, with Jev
merely available, is never handed the tool. Today this reaches Claude (held, and detached `claude
-p`), OpenCode and Codex; Antigravity is not in the list — see **Known limits** below.

**What runs locally.** With the gate open, this app's main process starts a SECOND loopback HTTP
listener — `127.0.0.1` only, an ephemeral port, never reachable from the network — separate from
the hooks channel described below, with its own token minted per launch rather than the one shared,
per-install token the hooks channel uses (`DelegationService`, `src/main/mcp/delegationService.ts`).
How a launched session actually reaches it differs by how that session runs:

- **A detached `claude -p` or OpenCode launch** gets a stdio MCP server child, started by the CLI
  itself through a documented per-invocation mechanism — Claude Code's own `--mcp-config` (a temp
  file, see below) and OpenCode's own `OPENCODE_CONFIG_CONTENT` environment variable — never a file
  this app writes into your own Claude or OpenCode configuration. That child is this app's own
  executable, restarted as plain Node (`ELECTRON_RUN_AS_NODE=1` on the child's own env, never on the
  CLI's) rather than a separately installed `node` this build cannot assume exists
  (`delegationServerCommand.ts`), and it reaches the loopback listener the same way any other local
  MCP server would.
- **A detached `codex exec` launch** gets the same server through Codex's own documented
  per-invocation mechanism instead: `-c mcp_servers.jev.<key>=<value>` overrides on Codex's own
  command line, never a file written into your Codex configuration. Measured end to end (2026-09-23,
  codex-cli 0.153.4): this registration reaches the model's own tool list, not merely Codex's
  resolved configuration — but the call itself was refused by Codex's own approval policy until this
  app also overrode the approval mode for exactly the two delegation tools,
  `mcp_servers.jev.tools.delegate_subtask.approval_mode="approve"` and the same key for
  `subtask_result` (`codexDelegationConfigArgs`, `src/main/mcp/delegationInjection.ts`). Per tool
  rather than server-wide, so nothing here pre-approves a tool this server does not have today; every
  other tool call a delegated Codex turn makes still follows your own ordinary Codex approval policy.
- **A held Claude session** — one this app keeps open through the Agent SDK — never spawns a second
  process for this at all: its two delegation tools run in-process, inside this app's own main
  process (`createSdkMcpServer`, `delegationHeldServer.ts`), with no loopback call and no token on
  any command line. This is a fix, not a shortcut taken loosely: an earlier draft handed a held
  session's endpoint and token to the classic `claude` process's own `--mcp-config`, which the Agent
  SDK turns into that process's own `--mcp-config` argv — visible in `ps`/Task Manager to any other
  local account on the machine. The in-process server exists specifically so a held session's token
  never leaves this process and is never serialized to any child's argv or environment.

**What is written to disk.** Only a detached `claude -p` launch writes a file for this: a temporary
`--mcp-config` JSON document, created with mode `0600` and an exclusive-create flag so it can never
silently overwrite a colliding name (`createNodeDelegationConfigFile`, `launchRunner.ts`). It is
removed the moment that launch ends, on every exit path — a clean exit, an early failure, or a spawn
that never started at all — through the same temp-file cleanup the launch's own stdout/stderr
capture files already use. It lives under the OS temp directory, the same place those capture files
do (see [What it stores](#what-it-stores-and-where)), never in this app's own user-data directory,
never in your own Claude configuration, and never in the project. OpenCode's own
`OPENCODE_CONFIG_CONTENT` and a held session's in-process server write no file at all.

**What data moves.** The subtask's own text — a `task` string, and an optional `context` — is sent
to TypeSafe's Jev API to decide a provider, model and effort for it: the exact same
[Jev disclosure](#jev-the-outbound-calls) above, for a routing call this app makes on the
subtask's behalf rather than on your own typed prompt. Once routed, the delegated child is an
ordinary session of whichever provider was chosen, so its own provider traffic is that provider's,
exactly as any launch's already is. Nothing else new leaves the machine: the loopback listener
itself is unreachable from the network, and delegation depth is 1 — a delegated child is launched
without the server at all, so it cannot delegate again. That holds structurally rather than by
convention: `delegationService.ts` builds a delegated child's own launch request in main and never
sets `routedByJev` on it, so the same gate has nothing to read a second time.

**Known limits, stated rather than left implicit:**

- **OpenCode.** `OPENCODE_CONFIG_CONTENT` is an environment variable, and an environment variable is
  inherited by the WHOLE process it is set on, not only the one child this app means it for. An
  OpenCode parent's own subprocesses inherit it too, and could in principle delegate again within the
  same per-parent (2) and global (4) concurrency caps until that parent launch itself ends — no
  narrower, documented OpenCode mechanism was found that would keep this env off the CLI's own
  process without also keeping it off the server process that needs it. The token involved is still
  scoped to, and lives only as long as, that one launch.
- **Codex.** Enabled (2026-09-23 measurement, codex-cli 0.153.4). The per-invocation
  `-c mcp_servers.jev...` override was measured exposing the server's tools to the model, not merely
  listing it — the fact `codex … mcp list` alone cannot answer — but the tool call itself needed the
  two per-tool approval overrides described above before it went through end to end. Those two
  overrides are the only approval this app grants on your behalf; nothing else about your Codex
  configuration or approval policy is changed.
- **Antigravity.** Excluded outright, and not waiting on a measurement. Its documented MCP
  registration is a global or project-local `mcp_config.json` file, never a per-invocation
  mechanism — and writing a server registration into a project's own file on your behalf was decided
  against.

### The OpenCode permission relay

Off by default, opt-in from Settings' OpenCode section (#588). With the plugin installed (see
[What it stores](#what-it-stores-and-where)), any OpenCode session on this machine — one the panel
launched, or one you started yourself at a terminal — has its permission dialog forwarded here
instead of only ever appearing somewhere the panel cannot see it.

**What the plugin sends, and to where.** The plugin subscribes to OpenCode's own `event` hook and
forwards exactly two event types it sees fire — `permission.asked` and `permission.replied` —
everything else a turn raises (dozens of events) is dropped before it ever reaches the network
(`src/main/opencodePermissions/opencodePermissionPlugin.ts`). What is sent is that event, verbatim,
plus the server's own `ctx.serverUrl`: the permission kind (e.g. `bash`), the command text and glob
patterns when the blocked call carried them, that call's own id, and the session id — authenticated
with the same per-install token the Claude hooks channel uses, sent as `x-dwarfai-token` rather than
that channel's own `Authorization` header. It goes to exactly one place: this app's own loopback
listener, shared with the Claude hooks channel but answering only the route this consent opened —
turning the relay on never requires turning Claude's hooks on too, and vice versa
(`src/main/hooks/hookListener.ts`, #588 T6 finding F5). A push the listener cannot reach — the app
closed, or the relay switched off — fails silently; the plugin never throws into the session it is
watching.

**What reaches your screen.** Before an ask is drawn on its dwarf's card, its command/pattern summary
is capped at 240 characters and passed through the same secret-redaction pass every other transcript
line goes through (`permissionInputLine`, `src/main/domain/permissionSummary.ts`, read by
`src/main/providers/opencode/opencodeProvider.ts`). The push itself, arriving over the loopback
listener, carries the raw text — redaction happens once, at the boundary before the panel draws it.

**Answering it.** Pressing Allow or Deny on that card sends one request —
`POST {serverUrl}session/{id}/permissions/{id}` with `{"response":"once"}` or
`{"response":"reject"}` — to the exact server address the push named, and nowhere else
(`src/main/opencodePermissions/answerOpenCodePermission.ts`, #588 T5). OpenCode's own third answer,
`always`, is never sent — the same restraint the Claude permission card already holds, since it
writes a standing rule into the session rather than answering the one prompt in front of you.

**The optional server password.** If you started OpenCode yourself with `OPENCODE_SERVER_PASSWORD`
set, its server refuses an unauthenticated decision. Settings' OpenCode section offers an optional
password field for exactly that case — read
[`config-layering`](../skills/config-layering/SKILL.md) for why this is a secret rather than a
setting, and why it is never read from this app's own environment (the terminal that started
OpenCode owns that variable, not the desktop session this app launches from). Typed once, it is
stored the same way the Jev API key is: Electron `safeStorage` ciphertext only, in its own tiny
`userData` document, never plaintext, with no fallback where this machine offers no real encryption
(`src/main/opencodePermissions/openCodeServerPassword.ts`). It is sent as HTTP Basic auth
(`opencode:<password>`) on every answer, and only when the ask's own `serverUrl` names a loopback
host — `127.0.0.1`, `localhost`, or `[::1]` — never to an address anywhere else, even one a
compromised push tried to name. Leaving it blank sends no `Authorization` header at all, matching
OpenCode's own default of taking no auth. **Stated as unverified, deliberately**: HTTP Basic auth
against OpenCode's own server has never been exercised live against a real `401` — every server this
project has measured so far ran with no password set — so this path is implemented and unit-tested
against a fake connection, not yet watched succeed against a live one
(`answerOpenCodePermission.ts`'s own module comment).

### Signing in to an OpenCode provider

An OpenCode model belongs to a provider — the part of its id before the `/`, `opencode-go` in
`opencode-go/kimi-k2`. When a launch names a model whose provider has no credential, the session
could never have worked, so the panel asks for the login before it starts anything (#597).

**Knowing a credential is missing, without reading one.** Before an OpenCode launch that names a
model, this app asks OpenCode's own server `GET /provider` and reads one field of the answer,
`connected`: the list of provider **ids** that have a usable credential. It is a list of names and
nothing else — no key, no token, no account. The launch goes ahead when the model's provider is in
it; the free built-in `opencode` provider always is, so a person using only free `opencode/*`
models is never asked anything. This app never opens OpenCode's credential file (`auth.json`) or
any other part of its credential store, and never runs `opencode providers login`
(`src/main/opencodeLogin/credentialCheck.ts`, `launchCredentialGate.ts`). If the check itself cannot
run — OpenCode missing, its server slow to start — the launch proceeds exactly as it did before
this check existed, and one line naming the failure (never a secret) goes to the app's log.

**A launch with no model chosen is checked too.** Naming no model does not mean nothing runs:
OpenCode itself picks one from its own configuration in that case, so the check asks the same
server `GET /config`, resolved for the mine's own folder — a project's `opencode.json` there can
name a different model than the rest of the machine. Exactly one field of that answer is ever
read, `model`; everything else in the response — which can include provider settings such as API
keys — is discarded unread and never logged, stored or returned. No model configured there either
means OpenCode falls back to its own free default, and the launch proceeds without asking anyone
anything.

**The server that answers is one this app starts for itself.** No OpenCode server is reachable
before a session exists, so the check starts your own `opencode` binary as
`opencode serve --pure`, listening on `127.0.0.1` only (`src/main/opencodeLogin/controlServer.ts`).
`--pure` means no external plugin loads into it — not this app's permission relay, not any
third-party plugin you installed. Each start is locked with a fresh random password, handed to that
process through its environment (never its command line, where other programs could read it),
held only in memory, and sent as HTTP Basic auth on this app's own requests. The server is stopped,
with every process it started, after five minutes unused and when the app quits.

**Completing the login in the panel.** The dialog lists the login methods OpenCode's server offers
for that provider (`GET /provider/auth`) and does one of two things, both over the same local
server (`src/main/opencodeLogin/loginService.ts`):

- **An API key.** Typed into a password field, it crosses from the panel to the main process once,
  straight into one request, `PUT /auth/{provider}` with `{"type":"api","key":…}`. OpenCode then
  stores it in its own credential store, exactly where `opencode providers login` would have put
  it. This app does not log it, write it anywhere of its own, keep it after the request, or return
  it in any answer the panel sees; the field is cleared the moment it is sent.
- **A browser sign-in (OAuth).** OpenCode's server hands back the sign-in address and its
  instructions (`POST /provider/{provider}/oauth/authorize`); the address opens in your system
  browser under the same `http:`/`https:` rule every other link here follows, checked by the
  renderer and again by main (`src/shared/externalLink.ts`). The sign-in itself happens between
  your browser, OpenCode and that provider — this app never sees your password there. A code the
  provider asks you to paste back is handled like the key: once, into
  `POST /provider/{provider}/oauth/callback`, never kept. A wait for the browser gives up after five
  minutes, and closing the dialog cancels it.

A provider id is accepted only in the shape OpenCode's own model ids use (letters, digits, `.`, `_`,
`-`, and never `.` or `..` alone), so no value from the panel can steer one of these requests to a
different route on that server.

### Everything else stays local

Three boundaries keep the rest of this app from opening a socket of its own:

- **The hooks channel is inbound and loopback-only.** The listener binds `127.0.0.1` and is
  never reachable from the network; requests without the per-install token are dropped before
  their body is read, and bodies are capped at 4 KB (`src/main/hooks/hookServer.ts`). The
  hook command written into your Claude config POSTs the hook's own JSON to
  `http://127.0.0.1:<port>` with `--noproxy 127.0.0.1`, so not even a configured proxy can
  route it off the machine (`src/main/hooks/hookCommand.ts`).
- **The Send action never opens a socket of its own; what it does depends on the channel.** Writing
  into a console (the default where the panel can reach one) is entirely local: the message is put
  into the input buffer of the console your session's own process is attached to, addressed by
  process id — no window is raised and nothing is put on your clipboard — see the next section. On
  macOS, writing a message into a Terminal.app tab asks the OS for one new permission, **Automation
  control of Terminal** — prompted once, the first time a message is sent, and used for nothing
  else. Answering a multi-select question or the "Other Thing" prompt there is a different act, a
  keystroke at the foreground window, and that one needs **Accessibility** permission instead; the
  app cannot detect either grant and will not prompt in advance for Accessibility. Neither
  permission lets DwarfAI-Miners read anything from Terminal — both are write-only reach into a
  window you already own. Handing a message to a Codex
  thread's queue spawns your own `codex` binary with the thread id and the text as argv. The relay
  spawns one throwaway `claude -p` turn from `~/.local/bin/claude` (or `claude.exe` under the same
  path on Windows), in `--safe-mode`, restricted to the `ListAgents` and `SendMessage` tools
  (`src/main/textDelivery/relay.ts`, `relayRunner.ts`). That turn runs under your Claude account,
  and its network behavior is Claude Code's — the text you typed travels to Anthropic the same way
  anything you type into Claude Code does, and DwarfAI-Miners itself opens no connection.
- **Launching or continuing OpenCode spawns your own `opencode` binary, and never puts your words
  on its command line.** Pressing Launch starts `opencode run` in the mine's folder with your first
  prompt written to its stdin and the pipe closed right after — the same detached shape Codex's and
  Antigravity's own launches already run on (`src/main/sessionLaunch/launchRunner.ts`). Sending a
  message to a root OpenCode session afterwards — launched by this panel or opened in your own
  terminal — spawns `opencode run --session <id>` again, your message on its stdin the same way; a
  message typed while a turn is already running waits here and is sent once that turn ends, rather
  than starting a second process on the same session
  (`src/main/textDelivery/opencodeContinue.ts`). Codex's own resumed-thread channel,
  `codex-exec-resume`, spawns `codex exec resume <id> -` on the identical terms — the model's
  reply, in both cases, is read back from the CLI's own local store on the next poll, the same way
  every other session's reply already is; neither process is a second network connection this app
  opens. The one OpenCode process this app starts without a session — `opencode serve --pure`, for
  the credential check and the login dialog above — listens on `127.0.0.1` only; any connection to a
  model provider it makes during a sign-in is OpenCode's, as it would be from your terminal.
- **An attached image, on a held session, leaves inside that same turn.** A session this app holds
  runs on the Agent SDK, driving the `claude` binary you already installed and logged into, exactly
  as the relay's turn does. Since #408 an attachment's image bytes ride along as one more content
  block in that turn rather than a second connection of their own — they leave the machine at the
  moment you press Enter, in the same turn your typed words were already taking
  (`src/main/textDelivery/attachmentDelivery.ts`, `src/main/sessionLaunch/sdkHeldSession.ts`).
- **External links open in your browser.** A link that asks for a _new window_ is refused and
  its URL handed to the system browser instead (`setWindowOpenHandler` in
  `src/main/shell/window.ts`). That is the whole of it: there is no `will-navigate` handler,
  so nothing stops the panel's own frame being navigated somewhere else. In practice the
  renderer is a local bundle that navigates nowhere, but the guard is narrower than "all
  navigation is denied" and should not be relied on as if it were that.
- **A link inside a message bubble goes through the same rule, checked twice.** Markdown in a
  bubble can draw a link, but never as a real `<a href>` the panel's own frame could be navigated
  by — it draws a button, and pressing it asks main to open the address (`shell:openExternalLink`).
  Only `http:` and `https:` addresses under 2048 characters pass; the renderer checks this before
  drawing the link at all, and main checks the same raw string again before it ever reaches
  `shell.openExternal`, because a renderer's word is never treated as a permission
  (`src/shared/externalLink.ts`, `src/main/shell/openExternalLink.ts`).

## Your clipboard: nothing borrows it any more

**This section used to say the opposite, and the change is worth stating rather than quietly
deleting.** Until #371, sending a message into a session's console put that message on your
**system clipboard**, pasted it with Ctrl+V into the window it had just brought forward, and
restored what was there before. For the length of that focus and keystroke your clipboard held the
message you had just sent, and anything that wrote to the clipboard in the same instant lost its
value to the restore. Both were accepted deliberately and stated here.

Neither happens now. The message is written straight into the input buffer of the console your
session's own process is attached to, found by **process id**
(`src/main/textDelivery/consoleInputWrite.ts`, `windowsTextDelivery.ts`): no window is brought
forward, no keystroke is synthesized, and **your clipboard is not read or written at all**. The
app no longer holds a clipboard port of any kind — nothing in it reads or writes one, on any
channel.

The text does still leave the app on that path, and it always did: it is handed to the console of
the session you addressed, which is a program running as you on your own machine. What is gone is
the second copy that sat on a system-wide clipboard on its way there.

## What is shown on screen

The panel is an always-on-top window, so whatever it displays can land in screenshots and
screen shares. Transcript **message text** is therefore passed through a redaction pass at the
provider boundary, before it ever reaches the renderer: GitHub tokens, `sk-` keys, Google API
keys, Slack tokens, JWTs, long hex runs, and long entropic runs are replaced with `[redacted]`
(`src/main/domain/redactSecrets.ts`). The pass is deliberately lossy — it will sometimes
redact an innocent git SHA, because a false positive costs a copy-paste while a false
negative costs a key — and it is display hardening, not a guarantee. The files on disk are
untouched either way.

That pass covers message text and nothing else. Three things reach the panel exactly as they
were found:

- **Project paths.** A mine is labelled with its full path above the cave (`MineScene.vue`). The
  world map no longer shows one: since #136 its hover tooltip carries the tier, the project NAME
  and the agent count, which is what the design specifies — so the folder a project sits in is not
  on screen there any more, only what it is called.
- **Session names**, as the Claude session registry records them.
- **Subagent task descriptions**, taken from the `Agent` tool call that launched each worker
  and used as that worker's name and its tooltip line (`claudeProvider.ts`).
- **A worktree's branch name**, beside a dwarf's name in the message panel header, for a session
  running in a git worktree of a project rather than its main folder — the folder name instead,
  when that worktree's checkout is detached (`src/renderer/src/lib/worktree.ts`). The dialog
  offered when you add a worktree folder also names the project's full path, no differently from
  the path already shown above every mine's cave.

A description is free text the orchestrating session wrote, so it is transcript-derived text
that reaches the screen without going through the redaction pass. Read the panel as showing
your project paths and your task descriptions to anyone who can see your screen.

## Where DwarfAI-Miners' responsibility ends

DwarfAI-Miners observes the files other tools write; it does not control what those tools do:

- **Claude Code and Codex** talk to their own backends under your accounts. What they
  transmit, log, or retain is governed by their vendors' terms and privacy policies, not by
  this document.
- **Installers** are downloaded from GitHub Releases — that download is an interaction with
  GitHub, under GitHub's policies.
- **Building from source** makes pnpm fetch dependencies from the npm registry. The packaged
  app fetches nothing.

Anything this document does not cover, the source does — start at `src/main/`.
