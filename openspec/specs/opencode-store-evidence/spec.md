## Purpose

What the measurement milestone must produce before any OpenCode parser is written: committed
redacted fixtures for the storage shapes the installed build actually writes, a dated and
version-stamped `docs/opencode-format.md`, and a recorded verdict — positive or negative — for
every exploration §6 row that a later design decision depends on.

Domain invariants touched: none directly. This capability is the evidence bar
`CONTRIBUTING.md` sets before a provider exists, and the input the other three capabilities are
built test-first from.

### Requirement: Format document with a version stamp and a confidence legend

The system MUST carry a `docs/opencode-format.md` that records the measured OpenCode build
string, the measurement date, the host OS, and a `[V]`/`[I]` legend in the discipline
`docs/codex-v2-format.md` holds. Every claim in it MUST be marked `[V]` (observed on the
measured install) or `[I]` (inferred from public sources, unverified).

#### Scenario: A claim carried over from exploration without being observed

- GIVEN a claim about OpenCode storage that was only read in public issue text
- WHEN `docs/opencode-format.md` is written
- THEN the claim is marked `[I]` and names its source
- AND no requirement in another capability may treat it as a measured field name

#### Scenario: Build changes under the fixtures later

- GIVEN a fixture committed against a recorded build string
- WHEN a later reader asks which build a shape came from
- THEN the document answers from its own version stamp, not from the repository date

### Requirement: Committed redacted database fixtures, and nothing else

The system MUST commit three pieces of evidence under
`src/main/providers/__fixtures__/opencode/`: the measured schema as a SQL DDL dump, a redacted row
set captured from a real completed turn (`session`, `message`, `part`, `event`), and a synthetic
database whose schema the provider does not recognise. A fixture `README.md` MUST state what was
redacted, as `antigravity/README.md` does. Fixtures MUST be readable by `MemorySqlite` so no test
touches a real store.

No JSON-tree fixtures are committed: the provider reads `opencode.db` only (maintainer decision,
`measurements-2026-09-17.md`), so a fixture for a shape nothing reads would pin behaviour that
does not exist.

#### Scenario: The measured install wrote SQLite only

- GIVEN a store root holding `opencode.db` and no `storage/` directory
- WHEN fixtures are committed
- THEN the DDL dump, the redacted row set and the unknown-schema database are present
- AND the absence of the JSON tree is recorded as a negative row rather than fabricated

#### Scenario: A row set is captured before any session has run

- GIVEN a database whose `session`, `message` and `part` tables are empty
- WHEN fixtures are committed
- THEN the DDL is committed as evidence and the row set waits for a real turn
- AND no requirement in another capability names a key inside `message.data` or `part.data` until
  that turn has been read back

#### Scenario: A captured value carries a machine identifier

- GIVEN a captured session record holding an account name, a home path or a hostname
- WHEN it is turned into a fixture
- THEN the project placeholders (`j`, `placeholder-host`) replace them
- AND the fixture README states that the redaction happened

### Requirement: Every measurement row records a verdict and its consequence

The system MUST record, for each exploration §6 row 1, 2, 3, 4, 5 and 10, whether it was
positive or negative, and MUST name the behaviour that follows from a negative verdict exactly as
the proposal's "Design decisions that wait on measurement" table states it.

#### Scenario: A row comes back negative

- GIVEN row 4 found no parent field on disk
- WHEN `docs/opencode-format.md` is written
- THEN the row is recorded as a negative result rather than omitted
- AND the document states the consequence: every session is a root `foreman` and no worker is drawn

#### Scenario: The native Windows binary misbehaves

- GIVEN row 10 shows the native Windows binary does not run clean
- WHEN the measurement is recorded
- THEN the document says so
- AND the proposal is revisited before any provider code is written, because the store root and any
  process picture change

### Requirement: No provider code before the evidence exists

The system MUST NOT gain OpenCode parsing or provider code until rows 1–4 are recorded and the
fixtures they describe are committed. Parsers MUST be written test-first against those fixtures.

#### Scenario: A parser is attempted from the exploration document alone

- GIVEN only `[I]`-marked field names from public sources
- WHEN a parser is proposed
- THEN it is refused: the field names are not evidence
- AND the work waits on the measurement milestone
