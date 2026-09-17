## Purpose

Where an observed OpenCode session sits in its own spawn tree: the parent edge when the store
records one, promotion of an observed parent to `foreman`, and the attendance value that decides
which silence window the dwarf's silence is judged against.

Domain invariants touched: silence windows differ by who can answer, not by rank (#47, #68) — an
unproven root keeps the long window and `'unknown'` stays distinct from `'attended'`; the
provisional-versus-known rule that nothing recording a decision may resolve an absence of evidence
into a positive finding.

### Requirement: A parent edge is published only when the store records one

When the measurement (exploration §6 row 4) shows a parent session field populated on disk, a child
session's dwarf MUST carry `parentId` naming the parent as a dwarf id of the form
`opencode:<parentSessionId>`, never a raw provider session id and never a slice of the child's own
id. The field name read from the store MUST be the one the committed fixture holds, not the name
presumed during exploration.

`session.parent_id` is the ONLY column this capability reads for topology ([V],
`measurements-2026-09-17.md` rows 2–3). An assistant message's `message.data.parentID` MUST NOT be
read as an edge of any kind: it names the USER MESSAGE the assistant is replying to, so it is a
reply edge inside one session and is present on every ordinary root session. Treating it as
topology would make every session that has ever answered anything look like somebody's subagent.

#### Scenario: Row 4 positive — a subagent is spawned

- GIVEN a fixture holding a child session record whose parent field names a session also present in
  the store
- WHEN a scan runs
- THEN the child's dwarf carries `parentId` of `opencode:<parentSessionId>`
- AND the parent's dwarf is published beside it

#### Scenario: A root session whose assistant messages carry a reply edge

- GIVEN a session row with `parent_id` of `null` whose assistant `message.data` rows each carry a
  `parentID` naming the user message they answer
- WHEN a scan runs
- THEN the dwarf carries NO `parentId` and is drawn as a root `foreman`
- AND the message-level `parentID` is never read as topology

#### Scenario: Row 4 closed positive — a Task subagent populates the field

> **Removed 2026-09-17, stated out loud (task 1.11).** This scenario used to read "Row 4
> unobserved — no populated parent on the measured build" and describe the negative default (every
> session a root, no worker drawn) for a row that had not yet been measured live. A second
> interactive-TUI turn on 2026-09-17 delegated a job to a subagent and the parent's session row
> came back with a real, non-null `parent_id` naming the parent — see
> `measurements-2026-09-17.md`, Row 4, and `docs/opencode-format.md`. The negative default is no
> longer reachable through any measured build this change supports, so this scenario is replaced
> by its positive counterpart rather than kept beside it as a dead branch.

- GIVEN `docs/opencode-format.md` records Row 4 closed positive: a Task subagent's session row
  carries `parent_id` naming the delegating session, corroborated by the parent's own `part` of
  `type: "tool"` with `tool: "task"` and `state.status: "completed"`
- WHEN a scan runs over a store holding that parent and that child
- THEN the child's dwarf carries `parentId` of `opencode:<parentSessionId>` and the parent's dwarf
  is published beside it as `foreman`
- AND a worker is drawn in the same mine as its foreman, exactly as
  `docs/session-topology-and-roles.md` §6 anticipated

#### Scenario: A parent edge points at a session this scan did not see

- GIVEN a child record naming a parent session absent from the store
- WHEN a scan runs
- THEN the child is still published
- AND no parent dwarf is invented to receive the edge

### Requirement: An observed parent is ranked foreman, and keeps the rank

A session observed as the parent of at least one other session MUST be published with role
`foreman`. A session with a published `parentId` MUST be published at a rank below the root. A
session that has led a crew MUST keep `foreman` after the crew has gone home, and the edge MUST be
applied after the whole scan is read so an edge first seen in the current scan reaches a parent
whose dwarf was already built.

#### Scenario: Worker beside foreman

- GIVEN one parent session and one child session in the same store
- WHEN a scan runs
- THEN the parent's dwarf is `foreman` and the child's dwarf is ranked below the root

#### Scenario: The crew finishes

- GIVEN a parent that was `foreman` in a previous scan
- WHEN the child session is gone from the store in the next scan
- THEN the parent's dwarf is still `foreman`

### Requirement: Attendance is unknown, and unknown keeps the long window

Every OpenCode dwarf MUST report attendance `'unknown'` until a measurement proves how the session
was started. `'unknown'` MUST NOT be recorded, resolved or rendered as `'attended'`. The silence
window MUST be read through `dwarfSilenceWindowMs` for the dwarf's role and attendance, never
picked by hand and never restated locally.

#### Scenario: Unproven root

- GIVEN an OpenCode dwarf with role `foreman` and attendance `'unknown'`
- WHEN its silence window is resolved
- THEN the long window applies, because an unproven session is given the benefit of the doubt

#### Scenario: A child session's window

- GIVEN a dwarf published at a rank below the root
- WHEN its silence window is resolved
- THEN the short window applies, because rank below the root proves nobody can type into it
- AND an attendance claim could not lengthen it

#### Scenario: Nothing records a decision from unknown

- GIVEN attendance `'unknown'`
- WHEN a decision that persists or seals anything is taken about the session
- THEN `'unknown'` is treated as absence of evidence, never as `'attended'`
