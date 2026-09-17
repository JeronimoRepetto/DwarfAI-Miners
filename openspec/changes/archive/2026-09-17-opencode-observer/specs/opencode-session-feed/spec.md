# Delta for opencode-session-feed

New capability. No existing spec under `openspec/specs/`.

## Purpose

What an observed OpenCode session says: the last assistant reply on the snapshot, and the message
panel's newest page and its scrollback, read from the `message` and `part` rows of `opencode.db`
and redacted at the provider boundary before crossing the wire. There is no file to tail, so this
capability also states that absence rather than approximating one.

Domain invariants touched: delivered versus reacted is not in play here (there is no channel); the
rule that carries is "absent beats guessed" — a fact the store does not hold is omitted rather
than approximated.

## ADDED Requirements

### Requirement: The last assistant reply rides the snapshot

Each published dwarf MUST carry `lastMessage` holding the most recent assistant text the store
records for that session, or nothing when the store records none. The text MUST be redacted before
it leaves the provider.

#### Scenario: Session has replied at least once

- GIVEN a fixture session whose newest assistant record holds reply text
- WHEN a scan runs
- THEN the dwarf's `lastMessage` is that text

#### Scenario: Session has not replied yet

- GIVEN a session created with no assistant record written
- WHEN a scan runs
- THEN the dwarf is still published and `lastMessage` is absent, never an empty placeholder

### Requirement: Feed returns the newest page and pages backwards

`feed(dwarfId, limit)` MUST return the last `limit` things said, bounded by the count asked for
rather than by the poll's byte window, and MUST return `null` for an id the latest scan does not
know. `feedPage(dwarfId, limit, before)` MUST return the page immediately older than the cursor
together with whether the start was reached, and MUST return `null` for an unknown id.

#### Scenario: Unknown dwarf id

- GIVEN an id no scan has published
- WHEN `feed` or `feedPage` is called with it
- THEN `null` is returned, which the caller reads as "cannot be paged", not as "nothing older"

#### Scenario: The session row was deleted between the scan and the read

- GIVEN a dwarf whose `session` row — and with it, by cascade, its `message` and `part` rows — was
  deleted after the scan that published it
- WHEN `feed` is called
- THEN an empty list is returned and no exception escapes
- AND `feedPage` returns an empty page with `reachedStart: true`

#### Scenario: Paging older than the panel's oldest row

- GIVEN a fixture conversation longer than one page
- WHEN `feedPage` is called with a cursor naming the oldest row the panel holds
- THEN only rows older than that cursor are returned
- AND the answer states whether the start of the conversation was reached

### Requirement: Redaction happens at the provider boundary, and cursors see redacted rows

Every string this capability publishes — `lastMessage`, `feed` rows and `feedPage` rows — MUST be
redacted before it crosses to preload or the renderer, including text a person typed, because
pasting a key into one's own session is how secrets enter a transcript. For `feedPage`, redaction
MUST ride the extractor so the rows a cursor is matched against are the same redacted rows that
crossed the wire.

#### Scenario: A secret appears in a user turn

- GIVEN a fixture whose user message contains a token-shaped string
- WHEN `feed` returns that row
- THEN the secret is replaced by its redaction marker in the returned text

#### Scenario: A cursor names a row that contained a secret

- GIVEN a cursor built from a redacted row the panel already holds
- WHEN `feedPage` is called with it
- THEN the cursor matches that row and paging continues from it without a gap or a repeat

### Requirement: No transcript path exists, and none is invented

`transcriptPath(dwarfId)` MUST return `undefined` for every OpenCode dwarf, without exception. No
per-session file exists to tail: the conversation lives as one `message` row per message and one
`part` row per part inside `opencode.db` ([V], `measurements-2026-09-17.md` rows 1 and 3). The
`log/opencode.log` text log is not an answer either — it is a process-wide key=value log, not this
session's conversation.

#### Scenario: A terminal tail is requested for an OpenCode dwarf

- GIVEN any OpenCode dwarf, known or unknown to the latest scan
- WHEN `transcriptPath` is called
- THEN `undefined` is returned and the panel pages its own feed instead
- AND no path into the database, the WAL file or the process log is offered in its place
