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

What OpenCode can honestly contribute is tokens and a cost figure, not quota. `session.cost` is a
stored column, and each assistant message's `data` JSON carries its own `providerID`, `cost` and
`tokens`. [V]

### What the stored cost means

[V] An aggregate over the maintainer's assistant messages, grouped by `providerID` (`opencode db`,
read-only, counts and sums only):

| `providerID`  | Messages | Stored cost | Messages with cost 0 |
| ------------- | -------- | ----------- | -------------------- |
| `opencode`    | 890      | 0           | 890                  |
| `opencode-go` | 1229     | about $65   | 38                   |

`opencode auth list` shows one credential on that machine: **OpenCode Go**, typed `api`. [V]

What that establishes, and what it does not:

- **A stored cost is not a bill.** OpenCode Go is a subscription, and OpenCode still recorded about
  $65 against it. It is almost certainly list price for the tokens, the same kind of number as
  Claude's `cost.total_cost_usd`. [I] The Union must never present it as money the user spent.
- **The credential type does not tell how the user pays.** A subscription shows up as `api`, so
  "API credential, therefore pay per token" cannot be inferred from it.
- **Zero cost does not mean free.** The `opencode` rows could be free Zen models, or a cost that
  was simply not recorded. Nothing local distinguishes the two.
- **A subscription's quota is not local.** Third-party reports say OpenCode's hosted plans have
  5-hour, weekly and monthly limits, and those reports are leads only. No table, command or server
  endpoint exposes them. [V] for the absence, [I] for the limits.
- A session signed in to someone else's subscription (Claude Pro/Max over OAuth, Copilot) draws on
  that subscription's quota, and OpenCode does not report it either. [I]
- `auth.json`, beside the database, holds the credentials. Like `account` and `control_account`,
  it is never read.

So an OpenCode card shows tokens and "cost at list price", split by `providerID`, and its quota
states that this provider does not report one.

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
interface AccountSpend {
  provider: ProviderId
  accountKey: string
  subProvider?: string // OpenCode's providerID; absent elsewhere
  tokens: number
  estimatedCostUsd?: number // always list price; no local source carries an invoice
  since: number // epoch ms the figure accumulates from
  observedAt: number
}
```

`AccountSpend` is the spend card's record. It is separate from `AccountQuota` because an account
may have both, and because a quota reading replaces the last one while spend accumulates.

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

### Several sources for one account: the freshest reading wins

Claude has two sources: the status line and the usage cache. They are not a primary and a backup.
They are two readings of the same account, and both run:

- Each parser emits an `AccountQuota` with its own `observedAt`: the event time for the status line,
  `fetchedAtMs` for the cache. The store keeps the newest reading per account and window, and
  records which source it came from.
- When one breaks, the other carries on and the user sees nothing change. The cache breaks when its
  undocumented shape changes. The status line breaks when the user disables it, or when a project's
  own `statusLine` overrides it.
- When both report the same window and disagree beyond rounding, that goes to the log, not to the
  screen. It is the earliest warning that the cache parser has fallen behind its shape.
- **A parser that meets an unexpected shape returns "no reading", never a number.** Otherwise a
  broken source that emits 0% would win on freshness and overwrite a correct reading.

The same rule covers Codex, whose rollout and app-server reads report the same snapshot, if the
app-server read is ever added.

### Accounts without a subscription: spend, not quota

An account on an API key has no 5-hour or weekly window. It pays per token. [D] Claude's status line
never carries `rate_limits` under API-key auth. The API's own rate limits (requests and tokens per
minute) travel in response headers that only the CLI sees, so the app cannot read them locally.

The Union therefore needs two kinds of card, and each account gets whichever its data supports:

- **Quota card**, for accounts that report windows: used fraction, reset, plan, credits.
- **Spend card**, for accounts that do not: tokens, and a cost figure.

What a spend card can show, per provider:

| Provider    | Cost figure                                                                                    | Source                                                 |
| ----------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Claude Code | Client estimate at list price                                                                  | Status line `cost`, or `totalCostUsd` of held sessions |
| Codex       | None stored. Needs a price table                                                               | Rollout tokens                                         |
| OpenCode    | Stored per message, list price (see [what the stored cost means](#what-the-stored-cost-means)) | `message.data`, `session.cost`                         |
| Antigravity | Does not apply. Its docs say it takes no user-supplied key                                     | —                                                      |

**Every cost figure says it is an estimate.** No local source carries an actual invoice, and a
subscription account can show a large list-price cost it never paid. A spend card may also sit next
to a quota card for the same account: a Claude Max account has both windows and a cost estimate.

The card kind follows the data, never the credential type. The OpenCode measurement shows why: a
subscription credential labelled `api`.

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
   user's command and restores it verbatim on disable. It is the documented contract. When it is
   enabled it runs beside slice 3, with the freshest reading winning.
5. **Antigravity status line.** Same pattern as slice 4, against `agy`'s settings file. It is
   blocked until `agy` is installed and its payload is captured, since nothing about it is [V].
6. **Spend cards.** Tokens and list-price cost: OpenCode per `providerID` from the stored cost,
   Claude from the status line and held sessions, and Codex once a price table exists. Every
   figure is labelled as an estimate, and every quota slot without a source says the provider does
   not report one.
7. **The screen.** The Union panel itself, once the maintainer's design amendment exists.

Slices 1–3 work on all three OSes as they are, because they are file reads under the user's home.
Slices 4–5 install a command that the CLI runs through a shell, so they need the platform-ports
treatment the hooks installer already has.

## Decisions taken

Maintainer decisions from the 2026-09-26 review of this note:

- **Claude reads both sources**, the usage cache and the status line, and the freshest reading wins.
  See [several sources for one account](#several-sources-for-one-account-the-freshest-reading-wins).
- **Two card kinds, quota and spend.** The data decides which kind an account gets, never the
  credential type. See [accounts without a subscription](#accounts-without-a-subscription-spend-not-quota).

## Open questions

1. Does the Union show only the current reading, or history? History needs a table and a retention
   rule.
2. Several accounts per provider (two Claude roots, several `CODEX_HOME`s): one card per account,
   or one per provider?
3. Should the app-server read ever be used, for example on demand from the Union, given that it is
   experimental and makes Codex call out?
4. For OpenCode sessions spending a Claude or Copilot subscription, is naming the subscription
   enough?
5. Does Codex get a price table, a config value or a bundled default, so that its spend card shows a
   cost and not tokens only?

## Evidence gaps

- The unit of `utilization` in `cachedUsageUtilization`, and whether `limits[].percent` duplicates
  it.
- A real Claude status-line payload from this machine, captured rather than read from the docs.
- Everything about `agy` on a real install: the payload, its cadence, and whether quota is present
  on every plan.
- The exact method string of Codex's rate-limit update notification.
- Whether `cachedUsageUtilization` is refreshed while no Claude session is open, or only by a
  running CLI.
- API-key accounts, since none was available on the measuring machine: whether
  `cachedUsageUtilization` exists at all under API-key auth, and whether Codex leaves `rate_limits`
  `null` or omits it.
- Whether OpenCode's stored cost is list price on every provider, and what a zero cost means.
