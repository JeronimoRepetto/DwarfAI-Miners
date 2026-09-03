# Reaching the CLI's own command surface from the panel — evaluation (issue #96)

> **Status: far smaller than the issue anticipated, for exactly the session type the issue named as
> the deciding factor.** #96 itself says "this issue is much smaller if #95 lands as the SDK path, and
> much larger if it does not" — #95 has landed (#112 detached, #113 held; see
> `docs/console-hosting.md`). This document's central finding is that the **`Query` object the held
> session already holds** (`src/main/sessionLaunch/sdkHeldSession.ts`'s `session` variable, the return
> of `query()`) carries typed, non-text methods for nearly every capability #96 asks for — `setModel`,
> `mcpServerStatus`, `getContextUsage`, a structured usage/cost call, MCP reconnect/toggle, effort — and
> none of them is called anywhere in this tree today. The code that would reach this data already
> exists and discards the adjacent fields on the very same message it already reads for `session_id`.
>
> Read against the tree at the tip of `main`, `@anthropic-ai/claude-agent-sdk` **0.3.258** (this
> project's pinned version, per `package.json`). Two claims below are read directly from that package's
> own shipped `.d.ts` files, not exercised against a live session — a level less certain than
> `docs/console-hosting.md`'s phase-5 experiments, which actually ran a held session and watched it
> answer. That gap is named explicitly in §5 rather than smoothed over, and closing it is the first
> item in §6.
>
> This document also corrects two of #96's own claims, both re-verified live against Claude Code's
> published docs on 2026-09-03 (see §3): `/context` is **not** documented as available under `-p`, and
> the claim "no structured status endpoint was found" for MCP is true of the plain `claude -p` surface
> #96 investigated, but not of the SDK surface underneath the held session this app already runs.

---

## 1. What the held session already receives and throws away

`sdkHeldSession.ts`'s message loop reads exactly one field off exactly one message type:

```ts
for await (const message of session) {
  if (message.type === 'system' && message.subtype === 'init') {
    request.onSessionId(message.session_id)
  }
}
```

(`sdkHeldSession.ts:185-192`.) That `init` message is `SDKSystemMessage`
(`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:5057-5117`), and next to `session_id` it also
carries, on every single turn:

| Field                 | Type                                            | What it answers                                                                                            |
| --------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `model`               | `string`                                        | the model in force right now (`sdk.d.ts:5073`)                                                             |
| `mcp_servers`         | `{ name: string; status: string }[]`            | every configured MCP server and its connection state (`sdk.d.ts:5069-5072`)                                |
| `permissionMode`      | `PermissionMode`                                | the session's current permission posture (`sdk.d.ts:5077`)                                                 |
| `effort`              | `'low'\|'medium'\|'high'\|'xhigh'\|'max'\|null` | the effort level the session will send next (`sdk.d.ts:5100-5103`)                                         |
| `slash_commands`      | `string[]`                                      | what this session's CLI build actually advertises (`sdk.d.ts:5078`)                                        |
| `claude_code_version` | `string`                                        | the exact CLI build driving this session (`sdk.d.ts:5066`)                                                 |
| `capabilities`        | `string[]`                                      | protocol feature flags, open set, for feature-detection instead of version-sniffing (`sdk.d.ts:5104-5107`) |

None of these seven fields is read anywhere in this repository. `model` and `mcp_servers` are stamped
by the CLI's own `mcp_servers`-typed field, not this app's inference — the same "structured record the
provider itself wrote" standard `DwarfQuestion` already holds itself to (contracts.ts:341-348).

The loop also never branches on `message.type === 'result'` at all. `SDKResultSuccess`
(`sdk.d.ts:4919-4963`) is what the CLI emits once per turn, and it carries:

- `total_cost_usd: number` — "cumulative estimated cost in USD for this `query()` call... each result
  carries the running total so far, so read the latest result rather than summing across results...
  an estimate, not a billing statement" (`sdk.d.ts:4937-4940`).
- `usage: NonNullableUsage` — main-loop-only token counts (`sdk.d.ts:4941-4944`).
- `modelUsage: Record<string, ModelUsage>` — "per-model totals... main loop, Task subagents,
  sidechains, and internal calls... the correct field for token/cost accounting" (`sdk.d.ts:4945-4948`).

So the two halves of #96's "model, MCP status, usage and cost" are already arriving, live, at the exact
callback this app wrote for a different reason (§1 of `docs/question-capture-evaluation.md` covers why
that callback exists at all) — and are dropped on the floor the same way `notificationType` used to be
before #94 started reading it (`docs/question-capture-evaluation.md:46-61`).

### Beyond the message stream: the `Query` object itself

`query()` returns a `Query` (`sdk.d.ts:2913-2914`, `sdk.d.ts:2577`), and `sdkHeldSession.ts` holds it as
`session` — the same value the `for await` loop iterates — but calls nothing else on it. `Query` is
also a control-request client, and every method below is typed, non-text, and requires nothing beyond
what the held session already has:

| Method                                                        | Returns                                      | Answers                                                                                                                                                                                                                                     |
| ------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setModel(model?)`                                            | `Promise<void>`                              | changes the model **for the running session**, not a future one (`sdk.d.ts:2619-2625`)                                                                                                                                                      |
| `supportedModels()`                                           | `Promise<ModelInfo[]>`                       | the picker `/model` with no argument would have opened — `value`, `displayName`, `description`, `supportsEffort`, `supportedEffortLevels` per entry (`sdk.d.ts:2724-2729`, `:1266-1290`)                                                    |
| `mcpServerStatus()`                                           | `Promise<McpServerStatus[]>`                 | `{ name, status, serverInfo?, error?, tools? }[]`, `status` a **closed** union: `'connected'\|'failed'\|'needs-auth'\|'pending'\|'disabled'` (`sdk.d.ts:2736-2741`, `:1117-1158`)                                                           |
| `reconnectMcpServer(name)`                                    | `Promise<void>`                              | the `/mcp reconnect <server>` line item, structurally (`sdk.d.ts:2831-2837`)                                                                                                                                                                |
| `toggleMcpServer(name, enabled)`                              | `Promise<void>`                              | enable/disable one server (`sdk.d.ts:2838-2845`)                                                                                                                                                                                            |
| `setMcpServers(servers)`                                      | `Promise<McpSetServersResult>`               | `{ added, removed, errors }` — replaces the dynamic MCP set (`sdk.d.ts:2852-2874`)                                                                                                                                                          |
| `getContextUsage(opts?)`                                      | `Promise<SDKControlGetContextUsageResponse>` | the `/context` breakdown, structured (`sdk.d.ts:2742-2754`)                                                                                                                                                                                 |
| `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` | `Promise<SDKControlGetUsageResponse>`        | "the structured data behind the `/usage` command: session cost and token usage totals plus claude.ai plan rate-limit utilization" (`sdk.d.ts:2755-2768`) — **the method's own name is the caveat**; do not build on it as a stable contract |
| `applyFlagSettings({ effortLevel })`                          | `Promise<void>`                              | changes effort mid-session, "session-scoped... never persisted to settings files" (`sdk.d.ts:2649-2673`)                                                                                                                                    |

Every one of these is gated: the interface's own doc comment says "the following methods are control
requests, and are only supported when streaming input/output is used" (`sdk.d.ts:2578-2582`), and
`query()`'s `prompt` parameter is `string | AsyncIterable<SDKUserMessage>` — a plain string is the
single-turn mode, an `AsyncIterable` is streaming-input mode (`sdk.d.ts:2913-2914`). `sdkHeldSession.ts`
already passes `input.messages()`, an `AsyncGenerator` (`sdkHeldSession.ts:143-144`) — so **the held
session already qualifies for the entire table above**, today, with no architecture change. A detached
`claude -p` launch (`src/main/sessionLaunch/launchRunner.ts`) is a single string on stdin, never an
`AsyncIterable`, and holds no `Query` handle at all — so nothing in this table reaches it.

**A control request is not a conversation turn.** It never appears as user text in the transcript,
never counts toward `num_turns`, and is not what #96 means by "a slash command typed into a session
consumes a turn and changes state" — that warning is correct and stays correct for every session type
below that has no `Query` handle, where the only way to ask is to actually type `/model` or `/mcp` into
the session's own input.

### Codex, checked the same way

Codex's registry row (`state_5.sqlite.threads`, `docs/codex-v2-format.md:69-78`) already carries `model`
and `reasoning_effort` directly, and `codexProvider.ts` already reads both into the wire
(`codexProvider.ts:531-532`, mirrored again for the tail read at `:619-620`) alongside cumulative
`tokens_used`, wired to `Dwarf.tokensUsed`/`tokensObserved` (`codexProvider.ts:547-551`). That column
list is exhaustive and verified against a live database (`docs/codex-v2-format.md:69-78`) — there is no
MCP-status column, and no dollar-cost column, anywhere in it. Codex has no held-session engine in this
app (no equivalent of `sdkHeldSession.ts` exists for it), so there is no live control-request surface to
even ask the question of; `external_agent_config_imports` (one row, `docs/codex-v2-format.md:126`) is
about _imported_ MCP/agent config, not a live connection's health.

---

## 2. Capability matrix

Split the way #96's own "Expected behavior" asks — read-only surfaces from mutating ones — because a
control request that only _reads_ is a materially smaller and safer thing to ship first than one that
changes a running session.

### 2a. Read-only: model, MCP status, usage/cost, context

| Session type                                         | Model                                                                                                                                    | MCP status                                                                                                                                                                                                                                                                         | Usage & cost                                                                                                                                                                                                                                                | Context breakdown                         | Passive, or costs something?                                                                                                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Held Claude session** (SDK, foreman)               | **Yes, passive** — `system/init.model`, already arriving, discarded (`sdkHeldSession.ts:185-192`)                                        | **Yes** — passively off `system/init.mcp_servers`, or actively via `Query.mcpServerStatus()`'s closed enum (`sdk.d.ts:1125`)                                                                                                                                                       | **Yes** — passively off every `SDKResultMessage.total_cost_usd`/`usage`/`modelUsage`, discarded today; or `usage_EXPERIMENTAL_...()` by name, unstable                                                                                                      | **Yes** — `Query.getContextUsage()`       | Passive for model/MCP/cost (ride the existing loop); an active `Query` call is a control-plane round trip over the same stdio the SDK already owns — no process spawn, no turn |
| **Detached `claude -p`** (headless, non-held)        | Not read; would need a **second, separate** one-shot `claude -p --resume <id> --output-format json` spawn                                | No structured route reachable without a live `Query` handle, and this mode holds none                                                                                                                                                                                              | Structurally possible via `--output-format json`'s `total_cost_usd` (confirmed live against Claude Code's own docs, 2026-09-03: "the response payload includes `total_cost_usd` and a per-model cost breakdown"), but only through a **new** one-shot spawn | Not documented under `-p` at all (see §3) | Costs a full process spawn per check, the same tier as `claude-relay` (`relayRunner.ts`, 60 s default at `config.ts:139`)                                                      |
| **External interactive console** (observed, foreman) | **Yes, passive** — `ClaudeTranscriptInfo.model` from the transcript tail (`parse.ts:95`, `:567`)                                         | No structured route; typing `/mcp` would need `sendKeys.ts`, and nothing here knows the picker's shape or how to read its answer back — the identical "mechanically present, semantically blind" gap `docs/question-capture-evaluation.md` §3 already proved for `AskUserQuestion` | **No** — Claude writes no dollar figure to the on-disk transcript; `usageTokens()` sums input+output+cache **tokens** for the vault economy, never dollars (`parse.ts:360-367`)                                                                             | No                                        | Passive (whatever the 2 s poll already reads)                                                                                                                                  |
| **Claude subagent/worker**                           | Partial — `resolvedModel` on the launch record when the parent named no explicit model (`parse.ts:51`, `docs/provider-formats.md:89-92`) | No                                                                                                                                                                                                                                                                                 | No                                                                                                                                                                                                                                                          | No                                        | Passive                                                                                                                                                                        |
| **Codex interactive TUI thread**                     | **Yes, passive** — `threads.model`/`.reasoning_effort` (`codexProvider.ts:531-532`)                                                      | **No** — no MCP-shaped column exists on the registry row (`docs/codex-v2-format.md:69-78`)                                                                                                                                                                                         | Partial — cumulative **tokens**, no dollars (`codexProvider.ts:547-551`)                                                                                                                                                                                    | No                                        | Passive                                                                                                                                                                        |
| **Codex headless** (`codex exec`)                    | Same registry read, if a row exists at all                                                                                               | No                                                                                                                                                                                                                                                                                 | Same as the TUI row                                                                                                                                                                                                                                         | No                                        | Passive                                                                                                                                                                        |
| **Simulated**                                        | No                                                                                                                                       | No                                                                                                                                                                                                                                                                                 | No                                                                                                                                                                                                                                                          | No                                        | n/a                                                                                                                                                                            |

### 2b. Mutating: change model, MCP reconnect/toggle, change effort

| Session type             | Change model                                                                                                                                                                                                                                              | MCP reconnect / enable / disable                                                        | Change effort                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Held Claude session**  | `Query.setModel(model?)` — applies to the running session, confirmed by the method's own doc rather than inferred (`sdk.d.ts:2619-2625`)                                                                                                                  | `Query.reconnectMcpServer` / `toggleMcpServer` / `setMcpServers` (`sdk.d.ts:2831-2874`) | `Query.applyFlagSettings({ effortLevel })`, session-scoped only (`sdk.d.ts:2649-2673`) |
| Every other session type | No structural route. A slash command typed into a console changes the CLI's own state (and, for `/model` with an argument, the running session too) but this app has no channel that types it and no way to read back what happened without parsing prose | Same                                                                                    | Same                                                                                   |

None of the "every other session type" row is a gap this document proposes closing — it is the same
gap `docs/console-hosting.md` §2 already named and declined to solve by owning a pty, for the same
reason: reading the answer back would mean screen-scraping, which `WaitingReason`'s doc comment forbids
outright (`contracts.ts:158-164`).

**Today, `DwarfCapabilities.adjustEffort` is hardcoded `null`** — "no provider exposes a channel to
change a running session's effort. Modeled now so a future channel plugs in without a UI change"
(`contracts.ts:494-498`). §2a/2b show that channel now exists, for held sessions specifically, and
nothing here has plugged into it yet.

---

## 3. Two corrections to #96's own evidence

#96 was written and verified 2026-09-01; the following was re-verified live against Claude Code's
published docs on 2026-09-03, and reads differently now:

- **`/context` is not documented as working under `-p`.** #96's own table lists it "yes | text". The
  current docs' own `-p` note names exactly `/model`, `/effort`, `/fast`, `/color`, `/rename` (value
  arguments) and `/mcp` (status summary) as the commands v2.1.205+ added to non-interactive mode, and
  says built-in terminal-only commands "aren't available in `-p` mode" — `/context`'s own table entry
  carries no such non-interactive note at all, unlike every command that does support it. Whether this
  changed since #96 was written or was never quite true is not established here; what is established is
  that the current docs do not back the claim. This does not matter for a **held** session, which
  reaches the same data through `Query.getContextUsage()` regardless (§1).
- **"No structured status endpoint was found" for MCP was true of the surface #96 investigated —
  `claude -p`'s prose commands — and is not true of the SDK surface underneath a held session.**
  `mcpServerStatus()` and the `system/init.mcp_servers` field are both structured, both typed with a
  closed status enum, and both already reachable from code this app runs today. The weakest link #96
  named turns out to be already answered for exactly the session type this app can host live.

One #96 claim this document did **not** re-verify independently: the exact wording of `/mcp`'s prose
output, and whether the picker-vs-argument split for TUI-only commands (`/hooks`, `/resume`, `/branch`,
`/clear`, `/rename`) is still accurate. Nothing in §1 or §2 depends on it, since the held-session path
never needs to parse that prose at all.

---

## 4. What exists but is discarded today

Restating §1 as a plain list, because this is the part of the finding a future task should be able to
read without re-deriving it:

1. `sdkHeldSession.ts:185-192` reads `session_id` off `system/init` and ignores `model`, `mcp_servers`,
   `permissionMode`, `effort`, `slash_commands`, `claude_code_version`, `capabilities` on the same
   message.
2. The same loop never inspects a `result` message at all, so `total_cost_usd`, `usage` and
   `modelUsage` — arriving once per turn — are never read.
3. The `Query` object the loop iterates (`session` in `sdkHeldSession.ts`) is never called for anything
   but iteration. Every method in §1's second table is available and unused.
4. `heldSessionRegistry.ts` has no field anywhere for model, MCP status or cost — `HeldRecord`
   (`heldSessionRegistry.ts:81-93`) carries only `mineId`, `handle`, `sessionId`, `openAsks`.
5. `DwarfCapabilities` (`contracts.ts:484-499`) has no member for any of this — `sendText`, `cancel`,
   `adjustEffort` is the whole set, and `adjustEffort` is `null` in v1 specifically because no channel
   existed when it was written.
6. `cliDetection.ts` reports no CLI version at all (verified: zero matches for `version` in that file).
   This is a real gap for gating a **relay-based** slash command against v2.1.205+, but not for a held
   session, which already receives `claude_code_version` on every `init` message for free.

---

## 5. What has not been verified here, stated plainly

Every claim in §1's second table (the `Query` control-request methods) is read directly from
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` at the version this project's `package.json`
pins — a type declaration the SDK's own build ships, not a claim this document invented. **None of it
has been exercised against a real running held session.** `docs/console-hosting.md`'s phase-5
experiments actually started a held session and watched `AskUserQuestion` arrive and resolve, live,
twice measured; this document did not repeat that experiment for `mcpServerStatus()`,
`getContextUsage()`, `setModel()`, or the usage call. Whether each one behaves exactly as its doc
comment says — in particular whether `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` is
safe to call at all against the currently-installed CLI, given the SDK/CLI version lockstep
`docs/console-hosting.md` §6 already flags as "operational, not a detail" — is exactly what a small
spike should confirm before any of this is wired to a wire field.

---

## 6. What to build next

In dependency order, each blocked on the one before it and named reasons only:

1. **A live-fire spike against a real held session**, mirroring #94's phase-5 experiments: start one,
   call `mcpServerStatus()`, `getContextUsage()`, and read the next `result` message's `total_cost_usd`.
   No wire change, no UI — this closes §5's gap and is the one thing every later slice depends on.
   **Blocked on:** nothing — every piece it needs already exists in this tree.
2. **Read the fields the `init`/`result` loop already receives.** Extend `sdkHeldSession.ts`'s message
   handling to also report `model`, `mcp_servers`, and the latest `total_cost_usd`/`usage` up through
   `HeldSessionHandle`/`HeldRecord`, the same shape `onSessionId` already uses. This is additive to code
   that already runs on every turn; no new process, no new spawn. **Blocked on:** (1), to know the
   fields actually arrive as documented against the installed CLI.
3. **New wire vocabulary, named explicitly because it is a one-way door.** The minimal set this needs,
   and no more:
   - `Dwarf.model`/`Dwarf.effort` already exist (`contracts.ts:387-388`) — a held session populating
     them is not a new field, only a new writer.
   - A new field for MCP server status — `McpServerStatus`'s own closed enum
     (`'connected'|'failed'|'needs-auth'|'pending'|'disabled'`) is a natural fit for the same treatment
     `MineTier`/`WaitingReason` already get (a closed union validated at the boundary, `isMineTier`-style),
     rather than the open-string treatment `notificationType` gets — the SDK ships it as a closed set,
     unlike `notificationType`'s documented-but-unstructured vocabulary.
   - A cost field, **only if** the open question below is answered yes. `total_cost_usd` is a different
     unit (real dollars) from every material the vault already tracks (`MATERIAL_TOKENS_PER_UNIT`,
     `contracts.ts:80-87`) — additive, never a replacement, and never converted into materials or vice
     versa, for the same reason materials never convert into each other (AGENTS.md, "Materials never
     convert into one another").
   - `DwarfCapabilities` needs new members for model-change and MCP-control, shaped as their own type
     rather than reusing `TextDeliveryChannel | null` — these are typed RPC calls with structured
     parameters, not text delivered into a session, and forcing them through the text-delivery shape
     would misrepresent what they are.
   - A new IPC pair mirroring `agent:answerQuestion`'s shape (`contracts.ts:982`) for the two mutating
     actions — never reusing `dwarf:sendText`, for the same reason.
     **Blocked on:** (2), since none of this is worth naming until the read path proves the fields behave
     as documented.
4. **Read-only rendering**: model, MCP status, and (contingent on the open question) cost/usage on the
   dwarf a held session already draws. Held sessions only — every other row in §2a stays exactly what
   it already shows today, since nothing here changes what an observed or headless session can prove.
   **Blocked on:** (3), and the design source outside this repository already producing #90's end-to-end
   interface, the same dependency `docs/question-capture-evaluation.md` §8 names for its own renderer
   slice.
5. **Mutating actions** (`setModel`, MCP reconnect/toggle) with their own confirmation UI, separated
   from the read-only slice exactly as #96's "Expected behavior" asks, because changing a running
   session's model is a different risk from displaying its cost. **Blocked on:** (4), for the same
   rendering surface, plus a policy decision this document does not make: whether a model change should
   be offered at all before the SDK's own `setModel` has been proven live (1) and the effect on an
   in-flight turn is understood.
6. **Effort control via `applyFlagSettings`**, unlocking `DwarfCapabilities.adjustEffort` for held
   sessions specifically. Small once (3)-(4) exist, and lowest priority of the mutating set — effort has
   no equivalent of #96's own urgency (there is no open issue asking for it), so this is opportunistic
   rather than requested. **Blocked on:** (4).
7. **Version gating for the relay/slash-command path**, if a future task still wants `/model`/`/mcp`
   text parsing for **non-held** sessions despite §2's honest "no structured route" verdict for that
   row. `cliDetection.ts` reports no version today (§4, item 6), so this alone is a real prerequisite —
   but nothing in this document recommends building that path at all, since every session type it would
   serve already has a passive, structured alternative (§2a) except the ones where the panel holds no
   process to ask in the first place. **Blocked on:** an explicit decision that the relay tier's
   spawn-per-check cost (§2a, "Detached" row) is worth paying for a capability the held-session path
   gets for free.

---

## 7. Open questions this document leaves to implementation, on purpose

Carried over from #96 because verifying the code does not answer them:

- **Is cost worth showing at all**, given the vault already expresses spend as materials (#22)? §6
  item 3 states the unit mismatch; it does not resolve whether showing both is clarity or a second,
  competing economy in one panel.
- **Where does this surface live** — the dwarf action bar (#27) or the mine view? #90 is redesigning
  both, and `docs/question-capture-evaluation.md` §8 already deferred its own renderer slice to the same
  design source for the same reason.
- **Is usage per-session, per-project, or global**, and which does the panel actually want?
  `SDKControlGetUsageResponse.session` (`sdk.d.ts:3702-3713`) is scoped to the one `query()` call; the
  rate-limit windows it also carries (`five_hour`, `seven_day`, …) are account-wide, a different scope
  again. Nothing here picks one.
