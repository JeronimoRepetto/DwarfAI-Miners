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

## The stub-CLI kit (`bin/`)

E2E cases put a provider "installed" on the machine with a stub CLI (`Stub<Provider>Cli`, `17` §1.9, §2.2):
a small Node program named exactly as the real binary, whose folder `e2e/_harness/stubs.ts` (`withStubs`)
hands to `launchApp`, which prepends it to the app's `PATH`. Detection, spawn and argv building then take their
production paths; no production code knows the kit.

| Path                                         | Content                                                                                                         |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `bin/_kit/stubCli.mjs`                       | the shared engine: `--version`, the scripted replay, the scripted exit                                          |
| `bin/_kit/scripts/<scenario>.json`           | hand-written scenarios, scrubbed, in the shapes of the provider's own files (`15` §5)                           |
| `bin/<name>/<name>.mjs`                      | the stub: a thin wrapper calling the engine with its provider directory and default script                      |
| `bin/<name>/<name>.cmd`, `bin/<name>/<name>` | the Windows shim and the POSIX executable wrapper (mode `100755`, shell built-ins only), both `node <name>.mjs` |

Stubs today: `claude` (replays into `CLAUDE_CONFIG_DIR`), `codex` (`CODEX_HOME`) and `opencode`
(`XDG_DATA_HOME`, the store root holding `opencode/opencode.db`).

**A script** is `{ version, replay, exitCode, ignoreStdin }`. `--version` prints `version` and exits 0. Otherwise the
stub runs the `replay` steps in order: `{ file, records }` writes into `file`, a relative path under the provider
directory (`.jsonl`: one JSON line per record; `.json`: its single record; `.db`: each record is an SQL statement run
on that SQLite file), and `{ exit: <code> }` stops there with that code (CH-04). After the last step the stub exits
with `exitCode`, or, with `ignoreStdin: true`, reads nothing and runs until it is killed (CH-05). The variable
`DWARFAI_STUB_<NAME>_SCRIPT` names a script file that replaces the default one; `withStubs(names, scenario)` sets it
from a scenario name. A stub fails closed, before any write: an unparsable script, an unset provider directory
variable or a replay file outside that directory ends it with exit code 64, so it never writes into a person's real
provider data.

**How a spawn with `shell: false` reaches a stub.** On Windows the platform lookup (each `PATH` folder, each
`PATHEXT` extension) finds `<name>.cmd`; Node refuses to start a `.cmd` without a shell (`EINVAL`, SP-04), and
`%ComSpec% /d /s /c "<quoted command line>"` still with `shell: false` runs it. On POSIX the lookup finds the
executable `<name>`, started directly. `node <name>.mjs` works on every OS.

**Extending a stub.** A driver issue (for example ISSUE-150's `StubClaudeCli` protocol replay) extends
`bin/<name>/<name>.mjs` and the engine with its protocol steps and adds its scenarios to `bin/_kit/scripts/`; it
never adds a second stub for the same provider. Protocol fixtures stay in `<provider>/<driver>/<version>/`.

**Never a real binary.** The kit is test data: no provider code, no provider binary (never bundled, downloaded or
patched, ADR-008 item 1), no credential, no real path and no unscrubbed transcript. Nothing under `bin/` is packaged:
electron-builder ships only `out/` and `package.json`, and `bin/_kit/stubCli.test.mjs` checks both rules.

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
