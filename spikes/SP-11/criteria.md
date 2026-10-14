# SP-11 — ADR-012 item 1 criteria per OS and Claude Code version

ADR-012 item 1 asks four questions per OS and Claude Code version. The hook route is adopted only if (a), (b) and (c)
all hold; (d) is informational. Each row below is one measured run. A row marked "not run" is not evidence.

The verdicts and the case ids (A1 … E2) come from the maintainer's macOS run of 2026-10-14 (real-CLI lane, `17` §5.5).
The record is `spike-results/SP-11.md`; the scrubbed hook payloads are under `fixtures/claude/hooks/2.1.x/`.

## Runs

| OS                         | Claude Code | Date       | Status                                                                                |
| -------------------------- | ----------- | ---------- | ------------------------------------------------------------------------------------- |
| macOS 26.6.2 (25G83) arm64 | 2.1.299     | 2026-10-14 | measured                                                                              |
| Windows 11                 | —           | —          | not run                                                                               |
| Linux                      | —           | —          | not run (owner's standing decision of 2026-10-10: Linux manual runs are not blocking) |

## Criteria on macOS 26.6.2, Claude Code 2.1.299

Two hook events were tried as the decision point: `PermissionRequest` (settings variants P and P10, P10 with a 10 s
hook timeout) and `PreToolUse` (variant T).

| Criterion                                                   | `PermissionRequest`                                    | `PreToolUse`                      |
| ----------------------------------------------------------- | ------------------------------------------------------ | --------------------------------- |
| (a) a returned `allow` / `deny` is honoured                 | **passed** (A1 allow, A2 deny)                         | passed (T1 allow)                 |
| (b) terminal answerable while the hook waits, late ignored  | **passed** (B1 terminal No, B2 terminal Yes)           | **failed** (T2: no dialog at all) |
| (c) timeout, no decision and hook error fall back to dialog | **passed** (C1 timeout, C2 none, C3 exit 1)            | not measured                      |
| (c) default and maximum timeout                             | not measured: 600 s documented, maximum not documented | not measured                      |
| (d) who answered, from hook or transcript evidence          | informational: transcript only                         | informational: transcript only    |

Route verdict on this OS and version: `PermissionRequest` meets (a), (b) and (c). `PreToolUse` fails (b) and is not a
candidate.

### (a) Decision honoured

- A1 (`allow`): no dialog; the hook replied in 0.06 s; the tool ran.
- A2 (`deny`): no dialog; the hook replied in 0.06 s; the tool did not run and Claude reported the denial without retrying.
- T1 (`PreToolUse` `allow`): no dialog; `PermissionRequest` never fired; the tool ran.

### (b) Terminal answerable while the hook waits

- B1: the dialog showed at once while the hook waited; the person chose No; Claude sent `SIGTERM` to the hook at that
  moment; the tool did not run; nothing happened later.
- B2: the dialog showed at once; the person chose Yes after about 2 s; the tool ran. Claude did **not** signal the
  hook: it kept running and wrote its `deny` 40 s later, after the turn had ended. No visible effect followed. See
  "B2 asymmetry" in the record.
- T2 (`PreToolUse` waiting 20 s): no dialog and no `PermissionRequest` during the wait, so nothing was answerable in the
  terminal; the tool ran when the hook replied. This fails (b).

### (c) Fallback to Claude's own dialog

- C1 (hook timeout 10 s, hook waiting 30 s): `SIGTERM` to the hook at 10.0 s; the dialog stayed open; nothing was
  allowed; the person chose No.
- C2 (hook exits with no output): Claude's dialog appeared.
- C3 (hook exits 1): Claude's own dialog appeared, with no hook error text.
- The default timeout (600 s) is documented, not measured. A maximum is not documented. Neither was measured.

### (d) Payload fields and who answered

- `PreToolUse`: `session_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `prompt_id`, `permission_mode`, `effort`,
  `hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`.
- `PermissionRequest`: the same without `tool_use_id`, plus `permission_suggestions`.
- `PostToolUse`: adds `tool_response` and `duration_ms`.
- `Notification`: `message` and `notification_type` (`permission_prompt`, about 6 s after the dialog shows).
- No hook payload says who answered. The transcript does, on the `tool_result` line: `permissionDecision`
  `{decision: accept, source: hook}` for a hook allow, `{decision: reject, source: hook}` plus
  `toolDenialKind: permission-rule` for a hook deny, `{decision: accept, source: user_temporary}` for a terminal Yes,
  and no `permissionDecision` but `toolDenialKind: user-rejected` for a terminal No. A hook decision also leaves a
  `hook_permission_decision` (`PermissionRequest`) or `hook_success` (`PreToolUse`) attachment line.

### Questions (ADR-012 item 5), informational

- E1: `PermissionRequest` fires for `AskUserQuestion`. With no decision the question showed and the person answered it.
  Answering a question through `PermissionRequest` was not tried.
- E2: a `PreToolUse` hook answered a question through `updatedInput.answers`; the question was never shown, and the
  terminal printed "User answered Claude's questions", attributing the hook's answer to the person. `PreToolUse` fails
  (b), so this is not a usable question route.
