# fixtures/

Recorded and hand-written test inputs shared by the test layers. The layout is fixed by the testing
strategy of the architecture package (`17-testing-strategy.md` §1.4, §1.5, §1.9 and §2.2) and checked by an L7 test:

```sh
node scripts/checks/fixtures-layout.mjs fixtures
pnpm vitest run scripts/checks/fixtures-layout.test.mjs
```

`fixtures/` sits at the repository root, outside `src/`, so no production file can import a fixture
(lint R14). Small per-test data stays inline or in a `__fixtures__/` folder beside its test.

## Layout

| Path pattern                                                  | Content                                                                                                                                                                                                          | Owner lane                                                                  |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `<provider>/<driver>/<providerVersion>/<case>.{jsonl,json}`   | Driver fixtures (protocol replay, help / probe, negative) for the driver conformance suite; each case has its `<case>-with-extra.<ext>` variant and, for JSONL, a CRLF variant; `<case>.expected.json` beside it | L-D Drivers (EPIC-09), one sub-lane per driver                              |
| `<provider>/observer/<providerVersion>/<case>.{jsonl,json}`   | Observer fixtures (provider transcripts) for the observation conformance suites; JSONL cases have a CRLF variant; SQLite stores as SQL text (`<case>.sql`)                                                       | L-E Board modules (EPIC-05), one sub-lane per provider adapter              |
| `<provider>/<driver or observer>/<providerVersion>/meta.json` | `{ providerVersion, capturedAt, capturedBy, os, scrubbed: true, capabilities }` for the fixture folder                                                                                                           | the lane of its folder                                                      |
| `db/<release>.sql`                                            | The DB fixture ladder: one text dump per release at that release's final schema version, with representative rows                                                                                                | L-B Host platform (EPIC-03, ISSUE-037 writes the first rung)                |
| `ipc/capabilities/<release>.json`                             | The `hello.ok.capabilities` list each release's Host served, for the compat tests                                                                                                                                | L-C UI main (EPIC-04, ISSUE-051 or ISSUE-056 writes the cut-0 list)         |
| `bin/<name>/`                                                 | Stub executables for the OS and E2E lanes (`Stub<Provider>Cli`), named exactly as the real binary, with `.cmd` shims on Windows                                                                                  | L-A Tooling (EPIC-01, ISSUE-313 kit); driver issues (L-D) extend their stub |

`db/`, `ipc/capabilities/` and `bin/` always exist (a `.gitkeep` holds each until its first file). There is no
`claude/agent-sdk/` directory: Claude driver fixtures exist only for `stream-json` and `acp` (OQ-52).

## Rules

- **Scrubbed only.** A provider fixture is committed only after the scrub step of `17` §1.4 ("Redaction (scrub
  rules)"): no home directory, user name, host name, e-mail address, secret, account or organization id. Its
  `meta.json` says `"scrubbed": true`. Read the scrubbed file before committing it (skill `privacy-guard`).
- **Never commit `*.raw.*`.** The recorder's raw captures (`<case>.raw.*`) are ignored by `.gitignore` and reported by
  the layout check.
- **`capturedBy` is a role**: `maintainer` or `ci-synthetic`, never a person's name or account.
- **The DB ladder is text** (`db/<release>.sql`), never a binary `.db` file, so it can be reviewed and scanned.
- **Variants.** A protocol fixture's `-with-extra` variant carries unknown fields at every object level. A JSONL
  case's CRLF variant holds the same lines ending in CRLF; the layout check recognises it by content, not by name.
- **Expected files are written by hand** from the contract the first time; regenerating one is a reviewed diff, never
  an automatic update.
- **A new provider version** is recorded into a new `<providerVersion>` folder; a dropped version leaves in one commit
  that names the version and the reason.
