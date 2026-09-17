# Exploration: OpenCode compatibility for DwarfAI-Miners

Change: `opencode-provider` · Phase: sdd-explore · Date: 2026-09-17 · Persisted by the orchestrator from the exploration agent's report (the agent had no write tool in its session).

## 0. Constraint and a citation correction

**OpenCode is not installed on this machine.** No binary on PATH, no `~/.local/share/opencode` or `~/.local/state/opencode`, and `~/.config/opencode` only holds skills/plugins installed by another tool. Every claim below is source- or docs-based, dated, and marked by confidence tier (see the legend in §2). Section 6 is a measurement plan, not a report of what was seen.

**Correction to the brief:** the upstream repository has moved from `sst/opencode` to `anomalyco/opencode` (org rebrand from SST to Anomaly; the old slug 302-redirects). Citations below use the current name. npm package `opencode-ai`, SDK `@opencode-ai/sdk`, both current as of **v1.18.30/v1.18.31, Sept 14–16, 2026**.

---

## 1. What Anvil does (read-only reference, local clone of `lucaspiritogit/anvil`, release 1.2.6, 2026-09-16)

Anvil drives OpenCode two ways, never overlapping:

| Purpose            | Mechanism                                         | File                                                              |
| ------------------ | ------------------------------------------------- | ----------------------------------------------------------------- |
| Run one turn, held | ACP over stdio                                    | `src/server/agents/opencode-acp.ts`, `opencode-acp-connection.ts` |
| Discover models    | HTTP `opencode serve` + `@opencode-ai/sdk` client | `opencode-sdk.ts`, `opencode-models.ts`                           |

**Spawn.** `opencode acp --port 0 --hostname 127.0.0.1 --mdns=false` (`opencode-workspace.ts:3`, `OPEN_CODE_ACP_ARGS`), stdio piped (`['pipe','pipe','pipe']`), `windowsHide: true`, `detached: process.platform !== 'win32'` (`opencode-acp-connection.ts:44`). Environment is a workspace-isolated one it builds itself (`openCodeWorkspaceEnvironment`), setting `OPENCODE_PURE=true` and `OPENCODE_CONFIG_CONTENT` inline JSON restricting `enabled_providers` to `openai|anthropic|openrouter|opencode|opencode-go` and `permission.external_directory: allow` (`opencode-workspace.ts:16-24`).

**Transport.** `@agentclientprotocol/sdk`'s `ClientSideConnection` over `ndJsonStream(child.stdin, child.stdout)` (`opencode-acp-connection.ts:60-63`). `rpc.initialize({ protocolVersion: PROTOCOL_VERSION, clientInfo, clientCapabilities: {} })`, then reads back `agentCapabilities.mcpCapabilities.http`, `.promptCapabilities.image`, `.loadSession` as booleans it gates behaviour on (`:76-78`) — a capability-declared-by-presence pattern identical to this repo's own `platform-ports` house rule.

**Methods used, one lazy server, one session per turn.** `rpc.newSession({ cwd, mcpServers })`, `rpc.loadSession({ sessionId, cwd, mcpServers })` (only if `supportsLoadSession`), `rpc.setSessionConfigOption({ sessionId, configId, value })` for model (`configId: 'model'`) and reasoning effort (found by scanning `configOptions` for `category === 'thought_level'` or `id === 'effort'`), `rpc.prompt({ sessionId, prompt: [...] })` with `{type:'text'}` and `{type:'image', mimeType, data: base64}` blocks, `rpc.cancel({ sessionId })` for interrupt with a 2 s grace timer before the connection is force-failed (`opencode-acp.ts:69`), and a fire-and-forget `rpc.prompt` again for **steering** — sending a message into an already-running turn (`opencode-acp.ts:88`, comment: "ACP answers session/prompt only once the session goes idle... OpenCode queues the message into the running turn").

**Permission callback.** `client.requestPermission` (`opencode-acp.ts:99`) picks the `allow_once` option if offered and denies (`cancelled`) otherwise — **Anvil auto-approves every tool call**, it does not put a human in the loop the way this repo's `canUseTool`/`onAsk`/`onPermission` does for Claude. Confirmed by the registry's own adapter label: "Default. ACP server over stdio, auto-approves tool use for each call." Anvil's `requestPermission` never surfaces a real question/ask tool to a person.

**Session update stream.** `AcpOutput.update()` switches on `session.sessionUpdate`: `agent_message_chunk`/`agent_thought_chunk` (text deltas, keyed by an optional `messageId`), `tool_call`/`tool_call_update` (id, name, status, `content[]` of `diff`/`text`, `locations[]`), `plan` (todo-list entries), `usage_update` (context occupancy `used`/`size`, and a session-cumulative `cost`). **No subagent/task union member appears in this switch at all** — see §2.3.

**Model discovery is a second, separate process.** `discoverOpenCodeModels` spawns `opencode serve --hostname=127.0.0.1 --port=0 --mdns=false` (`opencode-sdk.ts:47-51`), scrapes the listening URL out of combined stdout/stderr with a regex, asserts the hostname is `127.0.0.1` (refuses anything else), then calls `createOpencodeClient({ baseUrl, directory, throwOnError: true }).provider.list(...)` and shuts the server down when done. A short-lived, throwaway server for one read, not the turn's own server.

**What Anvil deliberately does NOT do**, confirmed by grep across `src/`:

- **Never reads OpenCode's on-disk session storage.** No hit for `storage/session`, `.local/share/opencode`, `readdir`/`fs.watch` against anything OpenCode-shaped.
- **Never observes a session it did not start.** Every OpenCode interaction traces back to a process Anvil itself spawned. There is no code path that attaches to, lists, or reads an independently-started `opencode`/TUI session.
- **No pid-based end.** Cancellation is `rpc.cancel` or killing the child process Anvil itself owns — never a signal aimed at a pid discovered by inference.
- **SECURITY.md** states: "Opencode runs through its ACP server and follows its own permission settings" — Anvil trusts OpenCode's own approval model rather than sandboxing it itself.

---

## 2. OpenCode surfaces, primary-source dated

Confidence legend: **[V]** = quoted/paraphrased directly from `opencode.ai/docs` or GitHub, dated; **[I]** = inferred by triangulating secondary sources (WebFetch summarisation of a live page, or search snippets) — **not yet verified against real files**, only against public text.

### 2.1 Storage — volatile, and mid-migration as of today's date

- **Historical/documented shape**: `${XDG_DATA_HOME:-$HOME/.local/share}/opencode/storage/{session,message,part}/` — one JSON file per session, per message, per message part **[I, multiple GitHub issue excerpts, still cited as current in recent issues]**.
- **A SQLite layer exists in shipped builds and is actively migrating JSON in**: `opencode.db` at `~/.local/share/opencode/opencode.db` (`%USERPROFILE%\.local\share\opencode\opencode.db` on Windows — OpenCode builds a POSIX-shaped `.local/share` tree **under the Windows user profile**, not `%LOCALAPPDATA%`) **[I]**. Users report databases growing to 627 MB (issue #29855, 2026-05-29) and to ~9 GB from oversized `message.updated.1` event snapshots (#46833) **[I]**.
- **The migration is documented as flaky, not settled.** Open issues describe: the JSON→SQLite migration silently skipping for incremental upgrades because the gate only checks "does `opencode.db` exist" (#13654); message parts missing after migration (#13818); the migration re-running against channel-specific DBs (#16885); and "SQLite Migration Ate My Sessions!" (#13636). A tracking issue proposing the SQLite table design (project/workspace/session/message/part) was **closed "not planned"** (#13202) even though the behaviour it describes is what users are hitting — either it shipped under a different issue/PR, or the label describes the proposal's shape rather than the feature's existence. **Unresolved; flagged for §6.**
- **`storage/session_diff/`** is a directory distinct from `storage/session/` that survives in at least one report after migration (#29855) — undocumented purpose, worth checking live.
- **`parentID`** is confirmed on the session's own shape ("Subagent sessions have a parentID field in their JSON" — #5734) and as `session.info.parentID`, populated in `tool/task.ts` when a subagent session is created (#30043, 2026). This is the OpenCode analogue of this repo's `parentId`/`DwarfTopology` model in `docs/session-topology-and-roles.md` §6 — a very close conceptual match.
- **What this means for the observer**: this repo already survived a mid-life format change (`docs/codex-v2-format.md` exists because Codex changed under it). OpenCode's storage is **more volatile right now** than Codex's was at any documented point, so a file-based provider should treat the SQLite DB as the source of truth once confirmed live, with the JSON directories treated the way Codex's SQLite-vs-rollout split is treated today — **until the real machine says otherwise (§6)**.

### 2.2 Server / SDK — `opencode serve` + `@opencode-ai/sdk`

- `opencode serve [--port <n>] [--hostname <s>] [--cors <origin>] [--mdns] [--mdns-domain]`, default `127.0.0.1:4096` **[V, opencode.ai/docs/server/, 2026-09-16]**.
- **`OPENCODE_SERVER_PASSWORD`** (+ `OPENCODE_SERVER_USERNAME`, default `opencode`) gates both `serve` and `web` with HTTP basic auth **[V]**.
- OpenAPI 3.1 spec self-published at `http://<host>:<port>/doc` **[V]**.
- `/event` is an SSE stream: "the first event is `server.connected`, then bus events follow" **[V]**. `session.created`/`session.updated` carry `parentID`; `session.status` currently does **not** (#30043) **[I]**.
- **Critical for the observer: the bare `opencode` TUI also starts its own embedded server, on a randomly assigned port and hostname, that a separate process cannot discover without already knowing the port** **[V, opencode.ai/docs/server/: "When you run `opencode` it starts a TUI and a server"; "it randomly assigns a port and hostname"]**. **No server registry exists today**: #8948 ("Server Registry & Auto-Discovery for Persistent Sessions") proposed registration files under `~/.local/state/opencode` keyed by a SHA-256 of the working directory — **closed**, no visible evidence it shipped **[I]**. #37060 ("TUI hangs on default port — works with --port flag") and a third-party bridge issue ("Auto-start on 127.0.0.1:4096 conflicts with running opencode TUI instances") corroborate: no discovery, and default-port collisions are a live nuisance.
- SDK: `createOpencode()` boots server+client together; `createOpencodeClient({ baseUrl, directory, throwOnError })` attaches to an existing one (Anvil's use). `client.session.{create,prompt,message,messages,abort}`, `client.event.subscribe()` for SSE, `client.provider.list()` for the model catalogue, and a permission-reply endpoint `postSessionByIdPermissionsByPermissionId` ("Respond to a permission request") **[V, opencode.ai/docs/sdk/, 2026-09-16]**. npm **1.18.30**, matching Anvil's lockfile.

### 2.3 ACP — `opencode acp`

`opencode acp [--cwd] [--port] [--hostname] [--mdns] [--mdns-domain]`, "starts OpenCode as an ACP-compatible subprocess that communicates with your editor over JSON-RPC via stdio" **[V, opencode.ai/docs/acp/, 2026-09-16]**. Documented clients: Zed, JetBrains, Avante.nvim, CodeCompanion.nvim. The page does not compare `acp` vs `serve` and says nothing about subagent visibility beyond "Agents and permissions system" — the detail lives in the ACP spec (agentclientprotocol.com) and in Anvil's consumption of it (§1).

**A confirmed, currently open gap: ACP loses subagents.** Independent 2026 issues: **#32388** "ACP subagents are invisible and can hang forever on permission prompts", **#48232** "ACP drops permission requests from Task subagent sessions", **#46685** "Subagent permission/error events leave external integrations no way to see root-session progress", and a third-party issue **#11894** "subagents spawned via delegation never appear (no task.* events)". One excerpt names the mechanism: "child opencode sessions (`session.created` with `parentID`) are tracked just for permission/question routing (`relatedSessionIds`), never promoted to `task.*` events." This matches Anvil's own `AcpOutput.update()` switch (§1): no subagent case, because ACP does not send one today.

### 2.4 `opencode run` — headless

`opencode run [message..]` **[V, opencode.ai/docs/cli/, 2026-09-16]**:

| Flag              | Meaning                                                      |
| ----------------- | ------------------------------------------------------------ |
| `--format`        | `default` or `json` (raw JSON events to stdout)              |
| `--model`/`-m`    | `provider/model`                                             |
| `--continue`/`-c` | resume last session                                          |
| `--session`/`-s`  | resume a specific session id                                 |
| `--fork`          | branch a session when continuing                             |
| `--attach`        | connect to an already-running server instead of spawning one |
| `--dir`           | working directory                                            |
| `--port`          | local server port                                            |
| `--auto`          | auto-approve non-denied permissions                          |

The closest analogue to this repo's `claude -p`/`codex exec` relay. **The same subagent gap reproduces here**: **#49300** ("`run --format json` drops every subagent part") attributes it to `packages/opencode/src/cli/cmd/run.ts` on **v1.18.30**: "the loop tracks child sessions, honours them for permissions, and filters parts against the root session". So neither subprocess surface (ACP, `run --format json`) currently surfaces subagent activity; only the raw SSE `/event` stream from `serve` is confirmed to carry the edge, and even there `session.status` omits it.

### 2.5 Plugins — `@opencode-ai/plugin`

Hooks a plugin module can export **[V, opencode.ai/docs/plugins/, 2026-09-16]**: `session.created`, `session.compacted`, `session.deleted`, `session.updated`, `session.idle`, `session.error`; `message.updated`, `message.removed`, `message.part.updated`; `tool.execute.before`, `tool.execute.after`; `permission.asked`, `permission.replied`; `file.edited`, `file.watcher.updated`. Installed via `opencode.json`'s `"plugin"` key or a global/project plugin directory. A **richer, more structured event vocabulary than Claude Code's hook matchers**, but it runs differently: an OpenCode plugin is **JavaScript/TypeScript loaded in-process** by the `opencode` process (Bun runtime), not a separate process spawned per event. To forward events to this app's loopback listener the plugin body itself would make the HTTP call — nothing in the docs demonstrates this pattern. **Scope is per-process, same as Claude hooks**: only sessions **started after** install carry it — the same "cannot retrofit a running session" caveat `main/hooks` already lives with.

### 2.6 Config — `opencode.json`

Discovery walks the current directory upward to the nearest Git root; precedence (later overrides earlier, merged) **[V, opencode.ai/docs/config/, 2026-09-16]**: remote `.well-known/opencode` → global `~/.config/opencode/opencode.json` → `OPENCODE_CONFIG` → project `opencode.json` → `.opencode/` directories → `OPENCODE_CONFIG_CONTENT` inline → OS-managed config (`/etc/opencode/`, `%ProgramData%\opencode`, macOS `/Library/Application Support/opencode/`) → macOS MDM (highest). Env vars: `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG_CONTENT`, `OPENCODE_TUI_CONFIG`. Anvil's `OPENCODE_CONFIG_CONTENT` use (§1) sits at the inline layer, which is why it composes with a user's own `opencode.json` — close to this repo's `config-layering` shape, lowering the risk that a launched session clobbers user settings.

### 2.7 Versioning and platform

Current release **v1.18.31** (2026-09-14), frequent cadence, issue numbers into the high 40,000s — orders of magnitude more tracker volume than Claude Code or Codex have shown this repo. **Windows support is real but secondary**: docs recommend WSL "for the best experience" and list WSL-specific troubleshooting. This repo's Windows-first constraint means a native install (`opencode-windows-x64.zip`, Scoop, Chocolatey) is required, and the native path has shipped real defects (#28920: the npm wrapper's `opencode.ps1` pointed at the wrong `opencode.exe` on v1.15.9; a general assumption that the wrapper expects `/bin/sh`).

---

## 3. Candidate architectures

### 3.1 Observer

| Architecture                                | What it needs                                                                                                                                      | Fits this repo's rules?                                                                                                                                                                                                                                                                                                                                                                      | Effort                                                                                                              |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **File/DB-tail** (à la Claude/Codex today)  | Read `storage/{session,message,part}` JSON and/or `opencode.db`, poll on the same loop, resolve liveness from mtime/size growth or a process probe | **Yes** — matches `docs/provider-formats.md`/`docs/codex-v2-format.md`'s discipline: verifiable artifacts, no screen scraping, absent beats guessed. Storage volatility (§2.1) needs the same "SQLite is the projection, degrade gracefully" posture Codex earned                                                                                                                            | **Medium-High** — the parser must tolerate a JSON-only install and a migrated one; the SQLite schema is unconfirmed |
| **SSE from a server this app starts**       | Spawn `opencode serve`, subscribe to `/event`                                                                                                      | **No, as the primary mechanism** — it only sees sessions on servers this app started or was told the port of. No registry (#8948) to discover a TUI opened from an unrelated terminal, which is capability 1's whole point. Same verdict `docs/console-hosting.md` reached for Herdr: additive enrichment for sessions this app launched, never the mechanism for observing an arbitrary one | **Low** for the narrow case, **not applicable** for the general one                                                 |
| **Plugin push channel** (à la `main/hooks`) | Author a JS/TS plugin, install globally, have it POST `session.*`/`tool.*`/`permission.*` to the loopback listener                                 | **Partially** — richer vocabulary, genuinely per-session, but a JS module this repo authors and keeps version-compatible with OpenCode's plugin API, not a declarative settings edit. Same "only sessions started after install" gap as hooks                                                                                                                                                | **Medium** — a new artifact class this repo has never distributed                                                   |

**Recommendation: file/DB-tail first**, mirroring Claude and Codex, with the plugin channel as a plausible **second slice** once storage is confirmed stable, and SSE scoped out except as enrichment for sessions this app launched itself.

### 3.2 Launch and hold

| Architecture                                 | Subagent visibility                                                                         | Question/permission loop                                                                                                         | Maturity                                                                                    | Effort                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **ACP** (Anvil's path)                       | **Confirmed broken today** for Task subagents (#32388, #48232, #46685, #11894)              | Real: `session/update` `tool_call`, a genuine `requestPermission` RPC this app could route to a person instead of auto-approving | Proven in a shipping product (Anvil 1.2.6)                                                  | **Low** — a third `HeldSessionPort` implementation beside `sdkHeldSession.ts`/`antigravityHeldSession.ts`, reusing Anvil's shape |
| **SDK over a self-started `opencode serve`** | `session.created`/`.updated` carry `parentID` — the one surface documented to keep the edge | Real: dedicated permission-reply SDK method                                                                                      | Vendor's first-party client, but this app would be the first to hold a full turn through it | **Medium** — no reference implementation; this repo authors the SSE-to-`HeldSessionStartRequest` mapping                         |
| **`opencode run` relay**                     | **Confirmed broken** (#49300, v1.18.30)                                                     | Coarse only (`--auto`)                                                                                                           | Simple, one-shot                                                                            | **Low**, weakest — matches "relay is the fallback, never the primary, for anything with a real question"                         |

**Anvil's choice should not be copied uncritically here.** Anvil auto-approves every permission and never needed subagent visibility; this repo's topology model (`docs/session-topology-and-roles.md`) is built around exactly the fact ACP throws away. **Recommendation: prototype launch-and-hold against the SDK/`serve` route first**, because it is the only one where docs and tracker agree the subagent edge survives, at the cost of an extra process this app must manage (as `createSdkHeldSession` manages the Agent SDK's `query()` and `antigravityHeldSession.ts` a raw child). ACP stays a credible fallback if the SDK route shows its own gap once measured (§6).

---

## 4. Where the existing provider contract fits, and where it must grow

**Fits with no change:**

- `DwarfProvider`/`DWARF_PROVIDERS` — adding `'opencode'` is one entry in `src/shared/contracts.ts`, re-exported from both barrels (`src/main/domain/types.ts`, `src/renderer/src/types.ts`) per AGENTS.md.
- `Provider` (scan/feed/feedPage/transcriptPath/textDelivery) — an `OpenCodeProvider` wired into `registry.ts` beside `CodexProvider`/`ClaudeProvider` is a drop-in for the observer half.
- `HeldSessionPort`/`HeldSessionStartRequest`/`HeldSessionHandle` — the callback shape (`onSessionId`, `onTelemetry`, `onAsk`, `onPermission`, `onSubagent`, `onMessage`, `onEnd`) already models what an ACP or SDK connection would translate into. `HELDABLE_PROVIDERS` gains `'opencode'` once a live round trip is measured, the gate its own comment states.
- `parentId`/`DwarfTopology` (designed, not yet implemented per `docs/session-topology-and-roles.md` §6) matches OpenCode's `session.info.parentID`; the design doc explicitly anticipated OpenCode.

**Must grow:**

- `TextDeliveryTarget.kind`: for launch-and-hold **likely no new kind** — `held-session`'s row already describes a held OpenCode session.
- **The observer's delivery story needs a stated absence**: an _observed_ OpenCode session has no proven pid-to-session mapping (§6) and no verifiable console channel. Until measured, an observed OpenCode dwarf ships with **no send/kick channel** (`textDelivery` returns `null`, as `SimulatedProvider` does) — "absent beats guessed" (#10).
- `AgentProviderOption`/`AgentModelCatalog`/`ModelOption` — OpenCode's `provider/model` strings and reasoning `variants` map onto the existing `AgentModelCatalog`/`ModelOption.effortLevels` shape; a new `source` and adapter, no wire redesign.
- `ProviderSnapshot`/`Dwarf` need nothing new structurally; usage/cost fields slot into the existing telemetry shape, **with cost treated as untrusted until measured live** (#28494 cache-read pricing ignored; #2891 cost sometimes `0`).

---

## 5. Risks and open questions for the maintainer

1. **Storage is mid-migration and its tracking issue was closed "not planned"** (#13202) while migration bugs continue through 2026. Building against this risks the "worked at capture, broke next release" failure this repo already lived through with Codex — and OpenCode changes faster.
2. **No pid↔session join exists today** (#8948 closed, not shipped) — Kick/end for an observed OpenCode dwarf has no verified act, the same gap Codex has and this repo refuses to guess around (`codex-v2-format.md` §8's five gates).
3. **ACP drops subagents right now** on v1.18.30/31. Shipping launch-and-hold on ACP would visibly regress topology relative to Claude's held sessions until upstream fixes it.
4. **`opencode run --format json` has the identical gap**, so there is no "simpler headless mode" escape hatch.
5. **Windows is OpenCode's secondary platform** (WSL recommended); the native binary must be verified working before anything is built on it (`platform-ports`).
6. **Cost accuracy has a bug history** — if this feeds the Laboral Union (#335), cost needs an explicit "measured live, else advisory" caveat.
7. **Open question for the maintainer**: does the plugin push channel deserve a slice at all, given it requires shipping and maintaining a JS artifact this repo has never distributed, or should the first cut be observer (file/DB-tail) + held (SDK-over-`serve`) only, with the plugin deferred until those prove insufficient?

---

## 6. Measurement plan

Every row ties to a design decision it unblocks, same discipline as `docs/codex-v2-format.md`. To be run once OpenCode is installed on this machine (native Windows binary), read-only unless noted.

| #   | Command / file to inspect                                                                                                                                                                                                                   | Unblocks                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | `opencode --version`; check `%USERPROFILE%\.local\share\opencode\` exists and list it (`storage/`, `opencode.db`?)                                                                                                                          | Current storage shape on THIS machine's version (§2.1)                                              |
| 2   | If `opencode.db` exists: `PRAGMA table_info` on every table via `node:sqlite` `DatabaseSync(..., {readOnly:true})`, the tool this repo used for Codex                                                                                       | Real schema, replacing §2.1's [I] markers with [V]                                                  |
| 3   | Start an interactive `opencode` TUI in a test project; watch `storage/session/*.json` (or the DB) for `parentID`, status/liveness fields, and whatever plays the role of `~/.claude/sessions/<pid>.json`                                    | Whether an observer can build liveness/topology from disk alone                                     |
| 4   | Launch a Task subagent inside that session; re-read the same rows                                                                                                                                                                           | Whether `parentID` is present on disk, deciding if file-tail alone builds topology                  |
| 5   | `Get-CimInstance Win32_Process` for `opencode.exe`/its Bun host while the session runs; look for a pid recorded under `~/.local/state/opencode` or the DB                                                                                   | Whether any pid↔session join exists — decides Kick's fate for an observed dwarf                     |
| 6   | `opencode serve --port 0`, note the URL, `curl http://127.0.0.1:<port>/doc`; `curl -N .../event` while driving a session via the SDK, capture raw frames for `session.created`, `session.updated`, `session.status`, `message.part.updated` | Ground-truths §2.2's [I] claims, in particular `parentID` absence from `session.status`             |
| 7   | `opencode acp` spawned as Anvil does; drive one turn with a Task-triggering prompt through `@agentclientprotocol/sdk`, log every `session/update` verbatim                                                                                  | Ground-truths the ACP-drops-subagents claim on this build before choosing SDK-over-`serve` over ACP |
| 8   | `opencode run "<prompt>" --format json --attach http://127.0.0.1:<port>` against a session holding a subagent                                                                                                                               | Confirms or refutes #49300 locally                                                                  |
| 9   | Author a minimal plugin exporting `session.idle`/`tool.execute.before`/`permission.asked`, install it globally, start a fresh session, check whether the handler fires and what the payload contains                                        | Whether the plugin route is viable before authoring a distributable artifact                        |
| 10  | Native Windows binary: `opencode --version`, one full turn, then an Anvil-shape spawn (`windowsHide`, `detached: false` on win32) to confirm no console/window artefact — the #208-shaped check run for Claude/Codex/Antigravity            | Whether the native install is launch-clean, or WSL passthrough is required                          |

---

## 7. Recommendation for the proposal phase

**Ship this as two changes, not one**, because they have different risk profiles and upstream maturity:

1. **`opencode-observer`** — file/DB-tail provider (§3.1), no launch capability, `textDelivery` returns `null` until §6 items 3–5 resolve pid/topology. Lower risk, higher value: one-line `DwarfProvider` addition plus a provider, buildable with committed fixtures the moment §6 items 1–4 are run — the shape `CodexProvider`/`ClaudeProvider` already prove.
2. **`opencode-held`** — launch-and-hold via the SDK over a self-managed `opencode serve` (§3.2), reusing `HeldSessionPort`, with ACP as the documented fallback if §6 items 6/7 expose a gap. Riskier (no reference implementation for the SDK route; subagent visibility only ground-truthed by §6), and it should not block the observer.

Propose `opencode-observer` first. Do not propose the plugin push channel as a committed architecture yet — flag it as a candidate third slice contingent on §6 item 9.

---

**Status**: done
**Next recommended**: sdd-propose (`opencode-observer` first; `opencode-held` as a second proposal)
**Skill resolution**: paths-injected — `platform-ports`, `config-layering`, `privacy-guard`, `cognitive-doc-design`, plus `sdd-explore` and `_shared/sdd-phase-common.md`.
