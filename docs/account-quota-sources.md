# Account quota sources — what each provider exposes, and how the app can read it

**Status:** research note, 2026-09-26. Nothing described here is implemented yet. It is the evidence
base for the Laboral Union (#335), the area that is meant to show the numbers each CLI prints in its
own `/usage` or `/status`.

**Question.** For every provider the app watches, where does the _account_ quota live — the share of
the 5-hour and weekly windows already used, when each resets, the plan, the credits — and which of
those sources the app can read locally, without a network call of its own and without scraping a
terminal UI?

This is a different number from the one the vault already shows. `Dwarf.tokensObserved` counts the
tokens one session spent. A quota window is a property of the account, shared by every session
signed in to it, including sessions this app never sees.

## Evidence labels

- **[V]** verified on the maintainer's machine on 2026-09-26, with the command or file named.
- **[D]** stated by the provider's official documentation or official source repository, with the URL.
- **[I]** inferred, not verified. Treat it as a lead.

Versions installed when this was measured: Claude Code 2.1.283, Codex CLI 0.153.4, OpenCode
1.18.32, Antigravity IDE 1.107.0. The Antigravity CLI (`agy`) was **not** installed, so nothing about
it below is [V].

## Summary

| Provider    | Best local source                                   | Windows it carries                                      | Contract                                  | Verified |
| ----------- | --------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------- | -------- |
| Claude Code | Status-line JSON on stdin (needs our command wired) | 5-hour, 7-day, gateway spend limit                      | Documented                                | [D] [V]  |
| Claude Code | `cachedUsageUtilization` in `~/.claude.json`        | 5-hour, 7-day, per-limit list, extra usage, spend       | **Undocumented** internal cache           | [V]      |
| Codex       | `rate_limits` on `token_count` in rollout JSONL     | primary (300 min), secondary (10080 min), credits, plan | Open-source protocol type, not a doc page | [D] [V]  |
| Codex       | App-server `account/rateLimits/read`                | Same, plus per-limit-id map                             | Experimental, capability-gated            | [D] [V]  |
| Antigravity | `agy` status-line JSON on stdin                     | Per-bucket `remaining_fraction` and reset, plan tier    | Documented                                | [D] only |
| OpenCode    | None                                                | —                                                       | —                                         | [V]      |

The app currently reads **none** of these. There is no parser, contract field, store or screen for
account quota anywhere in `src/`. [V] (search for `rate_limits`, `five_hour`, `seven_day`,
`used_percent`, `resets_at`: hits only in Codex test fixtures, and those carry `null`).

## Claude Code

### Status-line JSON — the documented channel

[D] <https://code.claude.com/docs/en/statusline.md>. Claude Code pipes a JSON object to the
`statusLine` command's stdin. The quota part:

```json
"rate_limits": {
  "five_hour":   { "used_percentage": 17, "resets_at": 1789556169 },
  "seven_day":   { "used_percentage": 33, "resets_at": 1790142969 },
  "spend_limit": { "used_percentage": 45, "resets_at": 1790142969 }
}
```

- `used_percentage` is 0–100. `resets_at` is Unix epoch **seconds**. [D]
- `rate_limits` is present only for claude.ai Pro/Max logins, or behind a Claude Apps Gateway spend
  limit, and never with API-key auth. [D]
- The object is absent until the session's first API response. Each window is dropped on its own
  once its `resets_at` passes. [D]
- `spend_limit` exists only behind the gateway, and can exceed 100 (v2.1.251+). [D]
- The same payload carries `context_window.*` and `cost.total_cost_usd`. The cost is a client-side
  estimate at list price, not the bill. [D]
- It is event-driven: session start, each new assistant message, `/compact`, a window's `resets_at`
  elapsing, and so on, debounced 300 ms, plus an optional `refreshInterval` timer. [D]
- `statusLine` follows ordinary settings precedence: managed, then `--settings`, then project
  local, then project shared, then user. A project that sets its own `statusLine` silences a
  user-level one. [D] <https://code.claude.com/docs/en/settings.md>
- The installed binary is a native executable that still carries these field names as strings,
  including a comment that `five_hour` is "present only while the API reports it and its resets_at
  has not passed". [V] (string scan of the installed binary)

**Cost of reading it.** The command slot is single-valued, and the maintainer already has a
`statusLine` command configured. [V] (`~/.claude/settings.json`, shape only). Reading this channel
means wrapping that command rather than replacing it: our wrapper passes stdin through to the
user's command, prints the user's output unchanged, and forwards a copy to a loopback listener. The
hooks channel (`src/main/hooks/`) already solves the install, restore and token problems for
`settings.json`, and this would be its sibling. It only produces data while an interactive Claude
session is rendering its status line: headless `claude -p` runs and held SDK sessions do not render
one. [I]

### `cachedUsageUtilization` — the undocumented cache

[V] `~/.claude.json` has a top-level `cachedUsageUtilization` object. On the day of measurement it
had been refreshed two minutes earlier. Its shape, keys only:

```
{ fetchedAtMs: number, accountUuid: string,
  utilization: {
    five_hour:  { utilization: number, resets_at: string, limit_dollars, used_dollars,
                  remaining_dollars, locked_reason },
    seven_day:  { …same… },
    seven_day_opus, seven_day_sonnet, seven_day_oauth_apps, …: null | { …same… },
    <about fifteen more code-named keys>: null | { …same… },
    extra_usage: { is_enabled, monthly_limit, used_credits, utilization, currency, … },
    limits: [ { kind, group, percent, severity, resets_at, scope, is_active } ],
    spend:  { used: { amount_minor, currency, exponent }, limit, percent, severity, enabled, … },
    member_dashboard_available: boolean, seven_day_breakdown } }
```

This is what `/usage` renders from. [I] The docs describe `/usage` as backed by a usage endpoint
the CLI calls, falling back to a "last-known usage" snapshot when that endpoint is rate-limited
(<https://code.claude.com/docs/en/costs.md>). This object looks like that snapshot, persisted.

Why it is attractive: it needs no install and no settings change, and it is readable when no Claude
session is running. `fetchedAtMs` states its own age, and `accountUuid` tells two accounts apart.

Why it is dangerous:

- No document promises it exists or keeps its shape. Most keys are internal code names. A reader has
  to accept only the fields it knows (`five_hour`, `seven_day`, `limits`), ignore everything else,
  and treat a missing or reshaped object as "no data", never as zero.
- The unit of `utilization` was not checked (0–1 or 0–100), and `resets_at` is a string here but
  epoch seconds in the status line. Both need a fixture captured before any parser is written. [I]
- `~/.claude.json` holds a lot more than this: account identity, per-project state, history.
  `privacy.md` has to name the new read, and the reader must parse the file without keeping or
  logging anything beyond this one key.
- A second Claude root (`~/.claude-work`, or any `CLAUDE_CONFIG_DIR`) is a second account with its
  own file. Quota is keyed by account, never by root.

### What does not carry quota

- OpenTelemetry export: metrics are sessions, lines, PRs, commits, `cost.usage`, `token.usage`,
  edit decisions and active time. No window. [D]
  <https://code.claude.com/docs/en/monitoring-usage.md>
- The Claude Code Analytics and Enterprise Analytics APIs report org-level spend for Console and
  Enterprise customers. They are not an individual's 5-hour or weekly window, and would need an admin
  key. [D]
- Transcripts under `~/.claude/projects/`. [V]

## Codex

### `rate_limits` on the rollout — already on disk

[V] The newest rollout under `~/.codex/sessions/` carries a non-null `rate_limits` on its
`token_count` events:

```
rate_limits: { limit_id: string, limit_name: string | null,
  primary:   { used_percent: number, window_minutes: 300,   resets_at: epoch seconds },
  secondary: { used_percent: number, window_minutes: 10080, resets_at: epoch seconds },
  credits:   { has_credits: bool, unlimited: bool, balance: string },
  individual_limit: null, spend_control_reached: null,
  plan_type: string, rate_limit_reached_type: null }
```

[D] The type is `RateLimitSnapshot` in `codex-rs/protocol/src/protocol.rs`
(<https://github.com/openai/codex>). `RateLimitWindow` is `{ used_percent: f64, window_minutes:
Option<i64>, resets_at: Option<i64> }`, so both window fields can be absent.

- It is `null` on a fresh session until the first response. The fixtures in
  `src/main/providers/__fixtures__/codex/` show exactly that. [V]
- `state_5.sqlite` does **not** persist it. Every column of every table was scanned. [V]
- `codex exec --json` events do not carry it. `turn.completed` has token usage only. [D]
  `codex-rs/exec/src/exec_events.rs`
- The app already reads these files: `parseCodexRolloutTail()` in
  `src/main/providers/codex/parse.ts` parses `token_count` and discards `rate_limits`. [V]

The snapshot belongs to the account, not to the thread. The current value is therefore the newest
reading across all rollouts, by event timestamp, and not the value of any one session.

### App-server `account/rateLimits/read`

[V] `codex app-server generate-json-schema` lists the method `account/rateLimits/read`. Its response
is camelCase: `rateLimits.primary|secondary.{usedPercent, resetsAt, windowDurationMins}`,
`credits`, `planType`, a `rateLimitsByLimitId` map and `rateLimitResetCredits`. [D] The types in
`codex-rs/app-server-protocol/src/protocol/v2/account.rs` are marked `ExperimentalApi`, gated behind
the `experimentalApi` capability, and absent from the public app-server reference. There is a
matching `AccountRateLimitsUpdatedNotification`, whose exact method string was not seen.

It is a live read: Codex fetches the value from its backend when asked. It is therefore not a
passive local read, and it is experimental. Keep it as a later option, and do not build on it first.

## Antigravity

[D] <https://antigravity.google/docs/plans/>. Ultra and Pro plans get a quota that refreshes every
5 hours up to a weekly ceiling, then weekly only. Other plans are weekly only. In the IDE, quota is
shown on a settings page, with no documented file or API behind it.

[D] <https://antigravity.google/docs/cli/statusline/>. The `agy` CLI has a status line configured in
`~/.gemini/antigravity-cli/settings.json`, and runs it "whenever the agent state changes", with
this in its payload:

```json
"quota": {
  "gemini-weekly": { "remaining_fraction": 0.9378, "reset_time": "2026-07-06T07:50:32Z",
                     "reset_in_seconds": 560580 }
},
"plan_tier": "Pro"
```

- It is **remaining** fraction (0–1), where Claude and Codex give **used** percent (0–100). It is
  keyed by bucket name, not by fixed window. Its reset is ISO 8601, not epoch.
- `agy` also has `/usage` (alias `/quota`). [D] <https://antigravity.google/docs/cli/commands/usage/>
- Headless `--output-format stream-json` events carry token usage but not quota. [D]
- Nothing here is [V]. `agy` was not installed, and only a leftover wrapper and logs from an earlier
  install remain. Those logs mention a `quota_manager` refreshing quota, which shows the subsystem
  exists but not where it stores anything.

## OpenCode

[V] No quota concept. None of the 20 tables in `opencode.db` has a column about limits, quota,
windows or resets. `account` and `control_account` hold OAuth tokens only, and the app must never
read those. `opencode stats` is local and reports sessions, messages, cost and tokens from session
history.

[D] <https://opencode.ai/docs/cli/>, <https://opencode.ai/docs/server/>. No usage or rate-limit
endpoint in `opencode serve`.

What OpenCode can honestly contribute is spend, not quota: `session.cost` is a stored column, so its
cost does not have to be derived from a price table. [V] [I] An OpenCode session signed in
with a Claude Pro/Max or Copilot subscription draws on that subscription's quota, but OpenCode does
not report it, so the Union can at most say which subscription a session spends.

## Integration outline

### One normalized shape, keyed by account

Every source reduces to the same record. The contract lives in `src/shared/contracts.ts`, like
every other wire shape.

```ts
interface AccountQuota {
  provider: ProviderId
  accountKey: string // stable per account; never a raw email or uuid on the wire
  plan?: string
  windows: QuotaWindow[]
  credits?: { balance?: string; unlimited?: boolean }
  observedAt: number // epoch ms of the reading, not of our read
  source: 'status-line' | 'usage-cache' | 'rollout' | 'app-server'
}
interface QuotaWindow {
  id: string // 'five_hour', 'seven_day', 'primary', 'gemini-weekly', …
  windowMinutes?: number
  usedFraction: number // 0..1, always "used", converted at the parser
  resetsAt?: number // epoch ms
}
```

The conversion happens once, in each parser: Claude `used_percentage / 100`, Codex
`used_percent / 100`, Antigravity `1 - remaining_fraction`. Nothing downstream should know which
provider counts which way.

Rules the shape has to carry:

- **Absent is not zero.** A missing window means "no reading". It never means 0% used.
- **A window past its `resetsAt` is expired, not current.** Show it as reset, or drop it, and never
  keep drawing the stale fraction.
- **Staleness is visible.** `observedAt` goes to the screen, because a Codex reading is only as
  fresh as the last Codex turn.
- **Quota is raw, not material.** No window converts to ore. The Union shows raw numbers (#22).
- **No new network traffic from the app.** Every source above is a local read, which keeps the
  `privacy.md` claim that the app transmits nothing. The app-server read would make Codex call its
  backend on our behalf, which is one more reason it is last.

### Slices, in recommended order

1. **Codex rollout parser.** Extend `parseCodexRolloutTail()` to keep the last `rate_limits`, and
   keep the newest reading per Codex home. It is small, the file is already read, and the type is
   open source. Fixture: a sanitized `token_count` with non-null `rate_limits`.
2. **Quota store and contract.** Add `AccountQuota` to contracts and the barrels, plus an
   in-memory latest-per-account store in main, published on the snapshot or on its own IPC
   channel. Persisting history in `appDatabase` is a separate decision, and the Union's design has
   not yet asked for it.
3. **Claude usage-cache reader.** A defensive read of `cachedUsageUtilization` that accepts known
   keys only, verifies units from a captured fixture first, and updates `privacy.md`. It is the
   fastest way to real Claude numbers. It is undocumented, and the UI must be able to lose it.
4. **Claude status-line channel.** An opt-in wrapper beside the hooks channel, which chains the
   user's command and restores it verbatim on disable. It is the documented contract, and it
   replaces or cross-checks slice 3 when enabled.
5. **Antigravity status line.** Same pattern as slice 4, against `agy`'s settings file. It is
   blocked until `agy` is installed and its payload is captured, since nothing about it is [V].
6. **OpenCode spend.** Surface `session.cost` and tokens, with an explicit "this provider reports
   no quota" state.
7. **The screen.** The Union panel itself, once the maintainer's design amendment exists.

Slices 1–3 work on all three OSes as they are, because they are file reads under the user's home.
Slices 4–5 install a command that the CLI runs through a shell, so they need the platform-ports
treatment the hooks installer already has.

## Open questions

1. Is an undocumented cache acceptable as a source at all (slice 3), or is Claude quota opt-in
   through the status line only?
2. Does the Union show only the current reading, or history? History needs a table and a retention
   rule.
3. Several accounts per provider (two Claude roots, several `CODEX_HOME`s): one card per account,
   or one per provider?
4. Should the app-server read ever be used, for example on demand from the Union, given that it is
   experimental and makes Codex call out?
5. For OpenCode sessions spending a Claude or Copilot subscription, is naming the subscription
   enough?

## Evidence gaps

- The unit of `utilization` in `cachedUsageUtilization`, and whether `limits[].percent` duplicates
  it.
- A real Claude status-line payload from this machine, captured rather than read from the docs.
- Everything about `agy` on a real install: the payload, its cadence, and whether quota is present
  on every plan.
- The exact method string of Codex's rate-limit update notification.
- Whether `cachedUsageUtilization` is refreshed while no Claude session is open, or only by a
  running CLI.
