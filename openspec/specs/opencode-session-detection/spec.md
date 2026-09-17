## Purpose

Discovering live OpenCode sessions from `opencode.db` and publishing one `ProviderSnapshot` per
session row, with liveness read from the store's own records rather than from a file timestamp,
honest degradation when the database is missing or unreadable, and a stated absence of any send or
kick channel.

Domain invariants touched: silence windows (#47, #68) — an unproven root keeps the long window and
both windows elapse before a drop; the `SessionStatus` rule that a provider which cannot prove
blockage never reports `waiting`; materials never convert — `tokensObserved` is raw per-session
tokens or nothing.

### Requirement: Store root resolves through the three configuration layers

The store root MUST resolve as environment (`OPENCODE_STORE_ROOT`), then the `userData` JSON file
key `providers.opencode.storeRoot`, then a default of `~/.local/share/opencode`. That default is
OS-INVARIANT: OpenCode builds the same POSIX-shaped `.local/share` tree under the Windows user
profile as it does elsewhere ([V], `measurements-2026-09-17.md` row 1), so the shape MUST NOT
branch on the operating system and no `Platform` value may change it. The `~` MUST be expanded from
a `home` parameter passed in, never from a hardcoded account name and never by reading the running
OS, and the setting MUST be reachable from a packaged app — not only from `.env`.

#### Scenario: All three layers are present

- GIVEN `OPENCODE_STORE_ROOT` set, a file key set, and the default
- WHEN configuration resolves
- THEN the environment value wins, most specific first
- AND a blank environment variable falls through to the file rather than past it

#### Scenario: The default shape is the same on every OS

- GIVEN a fixed `home` of `/home/j` passed as a parameter
- WHEN the default store root is built for `win32`, for `darwin` and for `linux`
- THEN all three produce the identical `/home/j/.local/share/opencode`
- AND `process.platform` is never read

### Requirement: The database is the only source

The provider MUST read `opencode.db` through the `SqliteLike` seam and MUST read nothing else.
The legacy `storage/{session,message,part}` JSON tree MUST NOT be read: a machine carrying it
without a database is "OpenCode not observed" (maintainer decision, `measurements-2026-09-17.md`,
"Maintainer decision"), and `docs/opencode-format.md` MUST state the measured version floor of
1.18.31 so the refusal is legible rather than a silent gap.

One snapshot per `session` row. The facts read from that row are [V]
(`measurements-2026-09-17.md`, rows 2–3): `id`; `parent_id`, indexed, `null` for a root;
`directory`, which is the session's working directory; `time_created` and `time_updated` in epoch
ms; `agent`; `model`, a JSON string of `{id, providerID}`; the per-session token columns and
`cost`, populated at the end of a turn. No pid or process column exists anywhere in the schema.
`message.data` and `part.data` are JSON blobs whose observed keys are recorded in row 3; any key
NOT recorded there remains [I] and MUST NOT be named by a requirement.

#### Scenario: The measured store shape

- GIVEN a fixture `opencode.db` with the measured schema and one session row
- WHEN a scan runs
- THEN one snapshot is published, carrying that row's `directory` as the session's working directory

#### Scenario: Legacy JSON tree and no database

- GIVEN a store root holding a `storage/` tree written by an older install and no `opencode.db`
- WHEN a scan runs
- THEN no sessions are published and no warning is emitted
- AND `docs/opencode-format.md` states the 1.18.31 version floor that makes this the intended answer

### Requirement: A store that cannot be read degrades, never throws

A missing store root or a missing `opencode.db` MUST produce no snapshots, no warning and no Add
Panel chip, at the cost of one cheap listing per poll. A database whose schema the provider does
not recognise MUST read as no rows, per the `SqliteLike` error contract — never a thrown poll tick.

#### Scenario: Machine without OpenCode installed

- GIVEN no store root on disk
- WHEN a poll tick runs
- THEN the scan resolves to zero snapshots with one listing attempt and no warning emitted

#### Scenario: Database with an unknown schema

- GIVEN a fixture database whose tables do not match the measured schema
- WHEN a scan runs
- THEN the scan resolves with no rows and no exception escapes the tick
- AND no dwarf is published, which is absence of evidence rather than proof that nobody is working

### Requirement: Liveness comes from the store's own records, never from the database file's mtime

A session MUST be reported `busy` — the state the panel draws as working — while EITHER its newest
assistant `message.data` carries no `time.completed`, OR its maximum `event.seq` for that session
id has advanced since the previous poll. It MUST be reported `idle` once `time.completed` is set
and that message's `finish` is `'stop'`; a `finish` of `'tool-calls'` is an intermediate step and
MUST NOT end the turn. `waiting` MUST NEVER be reported: no pending-permission row appeared in the
measured turn, so blockage is unproven and a provider that cannot prove it never claims it.

These fields are [V] (`measurements-2026-09-17.md`, row 3). The `event` table's `seq` is
monotonically increasing per session id and is the cleanest activity signal on disk. The
`opencode.db` file's own mtime MUST NOT be the deciding signal, for the reason
`docs/codex-v2-format.md` §4 records: a file held open across a long session can stop reporting
writes while it is still being written. Pending row 5, no process probe is performed — the schema
carries no pid column to join against.

#### Scenario: Database mtime frozen while the session works

- GIVEN a session whose `opencode.db` mtime is unchanged between two polls but whose maximum
  `event.seq` advanced
- WHEN the second poll runs
- THEN the dwarf is published `busy`, not dropped

#### Scenario: An assistant message is still streaming

- GIVEN the newest assistant `message.data` for a session has no `time.completed`
- WHEN a scan runs
- THEN the dwarf is published `busy`

#### Scenario: A turn stops between tool calls

- GIVEN the newest assistant message has `time.completed` set and `finish` of `'tool-calls'`
- WHEN a scan runs
- THEN the dwarf is still published `busy`, because the turn has not finished

#### Scenario: The turn finishes

- GIVEN the newest assistant message has `time.completed` set and `finish` of `'stop'`
- WHEN a scan runs
- THEN its status is `idle`
- AND `waiting` is never reported, from assistant text or from a guess

#### Scenario: Session quits and goes stale

- GIVEN a session whose rows and events stopped changing
- WHEN scans continue until the silence window from `dwarfSilenceWindowMs` for its role and
  attendance has fully elapsed
- THEN the dwarf is dropped on the first scan after that window and never before it

### Requirement: Tokens are observed, but no ore is claimed in this change

The per-session token columns ARE populated at the end of a turn ([V],
`measurements-2026-09-17.md` row 3), so row 3 is answered. `tokensObserved` MUST NEVERTHELESS be
omitted from an OpenCode dwarf in this change, following the Antigravity precedent, until the
maintainer answers proposal question 3 — whether an observed OpenCode dwarf mines ore in this
slice. If it is later published, the value MUST be raw per-session tokens read from those columns;
nothing converts materials and nothing sums units across materials. `cost` stays advisory and MUST
NOT reach the wire.

#### Scenario: A finished turn with token columns filled

- GIVEN a session row whose token columns hold real counts after a completed turn
- WHEN a snapshot is built
- THEN `tokensObserved` is absent from the dwarf and the mine credits no ore for it
- AND `cost` is not published

### Requirement: The absence of a delivery channel is stated, never worked around

`textDelivery` MUST return `null` for every OpenCode dwarf, as `SimulatedProvider` does, because no
pid-to-session join exists: the measured schema carries no pid or process column anywhere ([V],
`measurements-2026-09-17.md` row 2), which settles exploration §5 item 2 negatively at the storage
level. `LAUNCHABLE_PROVIDERS` and `HELDABLE_PROVIDERS` MUST NOT gain `'opencode'` in this change.

#### Scenario: Panel offers actions for an observed OpenCode dwarf

> **AMENDED 2026-09-17, stated out loud (#453).** The THEN clause below used to read "Send and
> Kick are disabled with `NO_CHANNEL_REASON`" for both controls. Kick has not disabled itself for
> want of a channel since #293, which predates this change: a null `capabilities.cancel` decides
> WHICH kick to offer (dismiss the dwarf from the board) rather than whether to offer one at all —
> see `DwarfCapabilities.cancel` and `kickAction` in `actionBar.ts`. `NO_CHANNEL_REASON` is a Chat
> string; nothing in `kickAction` ever returns it. The scenario is corrected to what the action bar
> actually does for an observed-only dwarf, rather than restate a refusal #293 already removed.

- GIVEN an OpenCode dwarf on the board
- WHEN the action bar resolves
- THEN Send is disabled with `NO_CHANNEL_REASON`
- AND Kick dismisses the dwarf from the board instead of interrupting a turn (or, mid-turn, is
  itself disabled with the turn-in-progress reason — never with `NO_CHANNEL_REASON`)
- AND nothing is spawned, focused or signalled

#### Scenario: Add Panel shows OpenCode

- GIVEN OpenCode is detected as installed
- WHEN the Add Panel renders its chips
- THEN the chip reads installed but not launchable, with the existing `NOT_LAUNCHABLE` copy
