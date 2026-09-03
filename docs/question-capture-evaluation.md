# Capturing and answering an agent's question — evaluation (issue #94)

> **Status: the answer loop is built, and stops one layer short of a button.** For a session the
> panel itself launches and holds, an agent's structured question already reaches main live and an
> answer already reaches the agent, over a real IPC round trip — nothing here is theoretical. What is
> missing is the renderer: `pendingQuestion` and `DwarfQuestion` have zero references anywhere under
> `src/renderer` (verified by grep, 2026-09-03). For every other session type this document is honest
> that capture and/or answering cannot be built today, and says exactly why, rather than papering over
> it — the same conclusion #60 reached about question-text detection in general.
>
> Read against the tree at `8d3991f`. A great deal moved since the issue was filed: `DwarfQuestion`,
> the transcript-tail capture, the redaction pass, the `notification_type` hook field, and the entire
> held-session ask-answer loop all landed after the issue's own evidence section was written (commits
> `602e228`, `1d121e2`, `d63be20`, `7202f6c`, `868ea0c`, `2c2db45`). `docs/console-hosting.md` (#95)
> also already answered this document's strategic question, independently, while investigating a
> different one. This document verifies both bodies of work against the code as it stands and narrows
> what is actually left.

---

## 1. The `Notification` payload, verified

The issue's own premise — that the app "receives the notification and throws its content away, on
purpose" — is half out of date. `CLAUDE_HOOK_EVENTS` still installs exactly five events
(`src/main/hooks/hookPayload.ts:11-17`): `SessionStart`, `Notification`, `Stop`, `SubagentStop`,
`SessionEnd`. But `HookEvent` no longer stops at three fields. `parseClaudeHookPayload`
(`src/main/hooks/hookPayload.ts:72-95`) now also reads `notification_type` off the body and carries
it as `notificationType` (`:44`, `:87`, `:93`) — added for this issue (`d63be20`) specifically because
`'dialog open'`/`'permission prompt'` collapse several opposite meanings into one `waitingFor` string
and the Notification payload's own type does not.

Two things are verified independently here, not just read off the code's own comments:

- **The vocabulary, confirmed against Claude Code's live hook docs (fetched 2026-09-03).** The
  documented `Notification` matcher values are exactly the twelve the code's own test comment claims
  (`src/main/hooks/hookPayload.test.ts:108`): `permission_prompt`, `idle_prompt`, `auth_success`,
  `elicitation_dialog`, `elicitation_url_dialog`, `elicitation_complete`, `elicitation_response`,
  `agent_needs_input`, `agent_completed`, `quota_auto_resume_fired`, `quota_auto_resume_stale`,
  `quota_auto_resume_disabled`.
- **The field name is still not.** The docs publish a matcher table, never the payload's own JSON
  schema — confirmed by the same fetch, which found no field-name listing for `Notification` at all.
  So `notification_type` is inferred, not read off a spec, exactly as `hookPayload.ts:38-42` and the
  test comment at `:108-112` already say. This is the one claim in this section that stays a
  reasonable inference rather than a verified fact.

**The consumer still discards the type it now parses.** `src/main/index.ts:410-419`:

```ts
onEvent: (event) => {
  const kind = event.notificationType === undefined ? '' : ` (${event.notificationType})`
  console.log(`[hooks] ${event.event}${kind}${event.cwd === undefined ? '' : ` in ${event.cwd}`}`)
  runtime?.nudge()
}
```

`nudge()` (`src/main/runtime/runtime.ts:733-735`) takes no arguments and asks for a full rescan,
exactly as `docs/hook-detection-evaluation.md` designed it. `notificationType` is logged and then
dropped on the floor — captured on the wire type, unused by any decision. That is a smaller gap than
the issue described (the type is no longer thrown away, only unused), and it is real progress: a
future consumer could branch on `agent_needs_input` vs `idle_prompt` without touching the parser
again.

### Is there a better event to install?

**`PermissionRequest` exists and is real** — confirmed against Claude Code's live hook docs
(2026-09-03): it fires "when a tool call needs a permission decision," and is a genuinely different
shape of hook from the five already installed. Every one of those is fire-and-forget: `HookServer`'s
whole contract is "never get in the agent's way" — it answers `204` immediately and only then calls
`onEvent` (`src/main/hooks/hookServer.ts:123-131`), and the class doc states the design outright
(`:24-34`). `PermissionRequest` cannot work that way: the fetched docs state plainly that its exit code
2 is _not_ honored and a denial must travel through a structured `decision` object the hook process
itself returns — meaning the hook command has to compute and print an allow/deny verdict before Claude
Code proceeds, not merely notify something that already happened. Installing it is possible in
principle, but it is not "add a sixth string to `CLAUDE_HOOK_EVENTS`" — it needs a hook transport that
can block on a human answer and hand a verdict back over the hook's own stdout, which is exactly the
shape `docs/hook-detection-evaluation.md:99-104` describes agentpet building for its one whitelisted
`PreToolUse` case (`post_await`, a 12 s blocking round trip) and this app has never built. `UserPromptSubmit`
and `PreToolUse` remain not installed, unchanged from the prior evaluation's reasoning.

---

## 2. Capability matrix

| Session type                                                                       | Capture a question, live?                                                                                                                                                                                       | Source                                                                                                                                                                                                                                                                                                            | Answer it?                                                                                                                                                                                                                                               | Channel                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Held Claude session** (panel-launched via the Agent SDK) — foreman only          | **Yes**, the moment it is asked                                                                                                                                                                                 | `canUseTool` (`src/main/sessionLaunch/sdkHeldSession.ts:152-165`) → `HeldSessionRegistry.receiveAsk` (`src/main/sessionLaunch/heldSessionRegistry.ts:292-309`) → stamped onto the dwarf by `stampHeldQuestions` (`src/main/sessionLaunch/heldSession.ts:321-338`, wired at `src/main/runtime/runtime.ts:486-489`) | **Yes — end to end, already**, up to the IPC boundary                                                                                                                                                                                                    | `agent:answerQuestion` (`src/shared/contracts.ts:982`) → `runtime.answerDwarfQuestion` (`src/main/runtime/runtime.ts:879-890`) → `HeldSessionRegistry.answer` (`heldSessionRegistry.ts:217-234`) → releases the blocked `canUseTool` promise. **Renderer is the only missing piece** — see below. |
| **External interactive Claude session** (observed, a human at a console) — foreman | **In code, yes; in practice, effectively never while still open**                                                                                                                                               | `parseClaudeTranscriptTail` reading an `AskUserQuestion` `tool_use` block (`src/main/providers/claude/parse.ts:543-610`)                                                                                                                                                                                          | **No structural path.** `dwarf:sendText` can physically type into that console (`src/main/textDelivery/sendKeys.ts:60-75`), but nothing here knows what shape of input the picker expects or maps a `DwarfQuestionOption.label` to a keystroke — see §3. | `terminal` — mechanically present, semantically blind                                                                                                                                                                                                                                             |
| **Headless `claude -p`** (detached launch, non-held)                               | **No.** `AskUserQuestion` never fires without a client capable of answering it — the model asks in prose instead and the turn simply ends (`docs/console-hosting.md:211-214`)                                   | none                                                                                                                                                                                                                                                                                                              | **No** — there is no blocked tool call to release; the turn that "asked" has already finished                                                                                                                                                            | `claude-relay` exists for `sendText`, but it starts a **new** turn — it cannot resolve an ask that already dissolved                                                                                                                                                                              |
| **Claude subagent/worker** (of any foreman)                                        | Same mechanism, same caveat, on the subagent's own transcript (`src/main/providers/claude/claudeProvider.ts:705`)                                                                                               | subagent transcript tail                                                                                                                                                                                                                                                                                          | **No dedicated path.** A worker owns no channel; only `foreman-relay` reaches it, as free text prefixed `[for agent X]`, and it cannot target a `toolUseId`                                                                                              | `foreman-relay`                                                                                                                                                                                                                                                                                   |
| **Codex interactive TUI thread**                                                   | **No.** Codex's rollout vocabulary carries no approval/input-request record at all, and `logs_2.sqlite` is a plain trace log — verified against real data (`src/main/providers/codex/codexProvider.ts:533-539`) | none                                                                                                                                                                                                                                                                                                              | **No** structural answer; free text can be queued into the next turn                                                                                                                                                                                     | `codex-queue` (`codex queue --thread`) — proven live (`docs/console-hosting.md:160`), but it delivers prose into the conversation, never a resolution to a specific ask                                                                                                                           |
| **Codex headless** (`codex exec`)                                                  | No                                                                                                                                                                                                              | none                                                                                                                                                                                                                                                                                                              | No                                                                                                                                                                                                                                                       | none — `canQueueToCodexThread` requires a live, `cli`-sourced thread; a headless run has neither                                                                                                                                                                                                  |
| **Simulated**                                                                      | No — the simulated provider never sets `waitingReason` or `pendingQuestion` (verified: zero matches)                                                                                                            | n/a                                                                                                                                                                                                                                                                                                               | n/a                                                                                                                                                                                                                                                      | n/a                                                                                                                                                                                                                                                                                               |

The one row that matters most is the second, because it is the one the issue worried about most
directly (`'dialog open'` being the commonest and least informative value) and the one where the
matrix could easily read more optimistic than reality. §3 is why it does not.

---

## 3. Why an observed session's `pendingQuestion` is honest but nearly unusable live

`ClaudeTranscriptInfo.pendingQuestion` is fully implemented and tested (`parse.ts:543-610`,
`parse.test.ts`): it reads every `AskUserQuestion` `tool_use` block in the tail, tracks which
`tool_use_id`s a later `tool_result` resolves, and reports the latest ask still unresolved
(`parse.ts:608`). It is redacted field-by-field at the provider boundary before the render loop can
truncate it (`claudeProvider.ts:193-213`), exactly like `lastMessage` (#59's lesson applied on
purpose).

**None of that changes the one fact that governs whether it is ever seen open.** `heldSession.ts`
states it plainly, measured twice on 2026-09-02 (`:10-13`):

> "A session the panel only observes writes its `AskUserQuestion` block to the transcript when the
> menu RESOLVES, backdated — so while the menu is open there is nothing on disk to read."

`docs/console-hosting.md`'s own channel matrix (`:192-196`) states the measurement behind that: a menu
left open ~5.5 minutes, scanned twice in full — zero `AskUserQuestion` blocks while it was open; the
block appeared only after the answer, timestamped at its original ask time. Because the `tool_use` and
its resolving `tool_result` are written to the transcript together, at the same resolve moment, the
practical consequence for `parseClaudeTranscriptTail` is sharper than "capture is post-hoc": by the
time a poll can see the ask at all, `answered` already contains its id in the same tail read, so
`pendingQuestion` is very often already `undefined` again by the next poll after the human answered at
the console directly. The field is not wrong to exist — it is what makes `askedAt` vs. the poll's own
observation time honest, and it is the one thing that lets `claudeWaitingReason` narrow `'unknown'`
into `WAITING_ON_HUMAN_REASON` when a registry-proven block coincides with a real open ask
(`parse.ts:245-260`, `claudeProvider.ts:172-178`, `:632`) — but it cannot be the evidence a "answer this
from the panel" button is built on for this row. That is exactly why held sessions exist as their own
mode rather than an enhancement to the ordinary poll.

**What §2's "mechanically present, semantically blind" claim means concretely.** `sendKeys.ts` can
type escaped text and press Enter (`:60-75`), or send a bare `{ESC}` for Kick (`:87-94`) — nothing else.
Whether Claude Code's permission/AskUserQuestion picker accepts a typed digit, requires arrow-key
navigation, or both, is **not established anywhere in this codebase**, and this document does not
assert an answer either way — it is a gap in what has been measured, not a claim resolved by reading
the code. Even where a digit-and-Enter keystroke happens to land correctly, nothing here knows which
digit corresponds to which `DwarfQuestionOption`, since the registry's `waitingFor: 'permission
prompt'` names no options at all (`parse.ts:205-212`).

---

## 4. Approvals: existing channel, or a new one?

**For a held session: an existing channel, unexercised.** `canUseTool` is the single callback the SDK
routes every permission prompt through, `AskUserQuestion` included (`sdkHeldSession.ts:30-51`). Today,
anything that is not `AskUserQuestion` is auto-denied with a fixed message unless the registry is
constructed with `otherTools: 'allow'` (`sdkHeldSession.ts:152-157`, default `'deny'`,
`:137`). So the plumbing that would carry a structured approval to a human is the identical plumbing
that already carries `AskUserQuestion` — the same `canUseTool` callback, the same
`HeldSessionRegistry` open-ask bookkeeping shape (`heldSessionRegistry.ts:73-93`) could hold an
approval exactly as it holds an ask. What is missing is a second `DwarfQuestion`-shaped wire type for
a bare allow/deny (an `AskUserQuestion` has options with labels; a tool permission prompt does not),
the renderer surface for it, and a decision to stop auto-denying by default. This is a new _type_ on
an existing _channel_, not a new channel.

**For every observed or headless session: no channel exists, structurally, for the reason §3 gives.**
Claude's own registry maps `'permission prompt'`, `'sandbox request'` and `'goal proposal'` all to
`'approval'` (`parse.ts:205-212`) — proof a session is blocked on one of them, never which options it
offers or what it is even asking permission for. Building a real answer path for this row needs either
the `PermissionRequest` hook's blocking-decision mechanism (§1 — a materially larger project than
installing a fire-and-forget event) or Codex's own `app-server` JSON-RPC surface, which
`docs/console-hosting.md`'s programmatic-interface table lists as "reviewer `user` → server-initiated
requests" and marks unbuilt. Neither exists in this tree today.

---

## 5. Correlation: hook event to dwarf, and its failure mode

**There is none, by design, today.** `HookEvent` carries `sessionId` and `cwd`
(`hookPayload.ts:22-45`), but `main/index.ts`'s consumer reads them only to build the log line
(`:410-419`) and then calls `runtime.nudge()`, which takes **no arguments at all**
(`runtime.ts:733-735`). Every one of the five installed events, for any session, triggers the exact
same global rescan of every mine. `docs/hook-detection-evaluation.md` chose this shape deliberately —
"debounced-full-rescan," reusing the already-tested `scan()`/`aggregateMines()` path rather than a
per-session update API — and it is why the design is self-healing: a hook event that names the wrong
session, or none, costs nothing beyond a slightly wasteful rescan, because the ordinary 2-second poller
would have produced the same state regardless.

**The failure mode is therefore not "wrong dwarf gets the notification"** — nothing is targeted, so
nothing can be mistargeted — **it is "no hook event can ever drive a per-dwarf action."** A future
feature that wanted to say "flash exactly this dwarf, because its Notification just arrived" cannot be
built on `hookChannel` as it exists: `sessionId` would first have to be matched against a dwarf's own
`sessionId` field (Claude's `main/providers/claude/claudeProvider.ts:641`, `:707` both stamp it) or
`cwd` against a mine's path, and neither matching step is written anywhere yet.

---

## 6. What evidence counts as "the question was answered"

The renderer's existing discipline (`src/renderer/src/lib/delivery/reaction.ts`) treats `delivered`
and `reacted` as different facts on purpose: `delivered: true` only ever means a relay process exited
0 and a message reached a queue (`:1-19`), and `reacted` requires an _observed_ state transition —
`working → waiting` for a kick, a changed `lastMessage` or `waiting → working` for a message
(`:86-101`) — inferred from snapshots because there is no stronger evidence available for those
channels.

**A held session's answer does not need that inference, and should not be forced through it.**
`HeldSessionRegistry.answer` (`heldSessionRegistry.ts:217-234`) returns `{ answered: true }` only when
`resolveAnswers` validated the choice against the ask the agent actually made and the release
literally unblocked the agent's own `canUseTool` promise. That is not a guess about behaviour after
the fact; it is the causal event itself — strictly stronger evidence than anything `reaction.ts`
produces for a console or relay send, and the doc comment at `runtime.ts:874-878` says as much: "the
agent's blocked tool call was released... the same narrowness `delivered` has for a message" — narrow
in the same _direction_ (it never claims what the agent did with the answer), but categorically firmer
in what it does claim. A future renderer should surface this as its own verdict rather than routing a
held answer back through `openReactionWatch`/`observeReaction`, which would throw away a stronger fact
to reconstruct a weaker one.

**For every other row in the matrix, there is no comparable evidence, and none should be invented.** A
`pendingQuestion` disappearing from an observed session's next snapshot proves only that _something_
resolved it — most likely the human answering directly at the console, which the panel had no part
in — never that a panel action caused it. Showing that disappearance as "answered from here" would be
exactly the false claim `delivered`-vs-`reacted` exists to prevent.

---

## 7. Observer versus host

**Recommendation: stay the shape this codebase already chose — host narrowly, through each CLI's own
programmatic interface, for exactly the sessions the panel itself launches; stay an observer for
everything it merely discovers.** `docs/console-hosting.md` (#95) already settled this, independently,
while investigating a different question, and its evidence does not need to be redone here: owning a
pty was rejected outright — no native-module dependency exists in this project, `package.json`'s
`dependencies` is `dotenv` and `vue` at the time it was measured, and a pty would still leave
blocked-detection to ANSI screen-scraping, exactly what `WaitingReason`'s doc comment forbids
(`console-hosting.md:38-50`, `contracts.ts:149-188`). Herdr integration was measured and kept as an
unbuilt, optional adjunct — its own API documents "screen scraping against a rule manifest" as the
detection source behind `agent.explain`, which bounds how far the signal could ever be trusted even if
it were wired in (`console-hosting.md:52-78`). The path that won, and is already shipping, is #3: drive
each CLI's own programmatic surface — the Agent SDK for Claude, `codex queue`/`app-server` for Codex —
which is exactly the mechanism behind the held-session ask-answer loop this document verifies in §2.

**The cost of each, stated plainly rather than assumed:**

- **Observer (kept).** Costs nothing new and loses nothing it already had; an externally-started
  session can be watched, kicked, and sent free text for its entire life, including mid-turn survival
  past a panel restart. What it can never do — durably, not as a temporary gap — is render a real
  question with real buttons, because the only structured evidence of an ask arrives backdated to the
  moment it no longer needs a button (§3).
- **Host, narrowly (chosen).** Costs a real runtime dependency — `@anthropic-ai/claude-agent-sdk`,
  the project's first production dependency past `dotenv`/`vue` — and a real behavioural trade a user
  must be told: a held session's child process dies with the panel (`heldSessionRegistry.ts:19-27`),
  where an observed or detached one does not. It buys, in exchange, the one thing this whole issue was
  filed to get: an agent's structured question arriving live and a real answer reaching it, proven end
  to end (`console-hosting.md:135-148`).
- **Host, broadly (rejected).** Spawning every session the panel shows, or wrapping Herdr as a second
  session server, would turn this from a panel that reports into one that is responsible for process
  lifetime across the board — "a different product," in the issue's own words — for a payoff §2's
  matrix shows does not exist for Codex or for any headless Claude session regardless of who owns the
  process, because the blocking mechanism (`AskUserQuestion` firing at all) depends on a capable client
  being attached, not on who started the process.

The recommendation is therefore not "stay an observer" in the issue's binary framing, nor "become a
host" outright — it is the narrower thing this repository already built and this document confirms
holds up: **host exactly the sessions the panel starts, for exactly the reason a question needs
answering, and stay an observer for every session that predates the panel's involvement.**

---

## 8. What to build next

In dependency order — each blocked on the one before it, and on nothing else it does not name:

1. **A renderer question surface for held sessions.** `pendingQuestion`/`DwarfQuestion` reach the
   renderer's type barrel already (`src/renderer/src/types.ts` re-exports them) and are consumed
   nowhere (verified: zero matches under `src/renderer`). `DwarfActionBar.vue` and `SpeechBubble.vue`
   are the two existing components most likely to host it, and `useDwarfMessaging.ts` is the existing
   composable shape a sibling `useDwarfQuestion` would follow for wiring `agent:answerQuestion`. A
   design source outside this repository (not committed here, referred to only as the design source)
   is already producing the end-to-end interface document #90 requires before any renderer rebuild
   lands — including how a question/answer flow reads in the new chrome — so this slice is about
   wiring an already-designed affordance to an already-complete IPC channel, not inventing one from
   nothing. **Blocked on:** nothing upstream — every main-process piece this needs already exists
   (§2, row 1).
2. **A wire signal for "this dwarf's question is actually answerable."** `DwarfCapabilities`
   (`contracts.ts:478-499`) has no member for it: `sendText`, `cancel` and `adjustEffort` are the whole
   set. Today, `pendingQuestion` can be populated for an _observed_ foreman too (§2, row 2), and a
   renderer that only checks "does `pendingQuestion` exist" would offer an Answer button that always
   fails with `NOT_HELD` (`heldSessionRegistry.ts:68`) for that dwarf. **Blocked on:** nothing technical
   — it is a contracts.ts + claudeProvider.ts + heldSession.ts change, small and additive.
3. **A structured approval type for held sessions, and a policy decision to stop auto-denying.**
   `canUseTool`'s non-`AskUserQuestion` branch (`sdkHeldSession.ts:152-157`) already reaches every
   permission prompt a held session raises; it needs a `DwarfQuestion`-shaped sibling for a bare
   allow/deny and a UI, not a new channel (§4). **Blocked on:** (1), since it reuses the same rendering
   surface and the same registry bookkeeping shape.
4. **Hook-to-dwarf correlation**, matching a `HookEvent.sessionId`/`cwd` against a live dwarf, only if
   a future feature actually needs per-dwarf targeting rather than the current global rescan (§5).
   **Blocked on:** a concrete feature that needs it — there is no reason to build this speculatively
   today, since the global rescan is already self-healing.
5. **`PermissionRequest` as an installed hook, for observed sessions' approvals** — genuinely useful
   only if the answer to §4's targeting is also solved, and only after accepting the larger design cost
   §1 describes (a blocking hook transport, not a fire-and-forget one). **Blocked on:** (4), and a
   separate decision that the cost is worth it for sessions the panel does not hold.
