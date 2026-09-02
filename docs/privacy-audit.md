# Pre-publication privacy audit (issue #32)

Audit date: 2026-08-30. Repository state at audit time: private, 45 commits, one release
(`v0.1.0`). Scope: every tracked file, hidden/tool directories, images, and the full Git
history, scanned for credentials, personal names, absolute home paths, usernames,
hostnames, internal URLs, private project names, and machine-specific defaults.

This document deliberately does **not** reproduce the removed identifiers (the machine
username, hostname, and private sibling-project names); it refers to them generically so
the checklist itself cannot re-leak them. The exact values were handed to the maintainer
in the audit report accompanying issue #32.

Placeholder vocabulary used by fixes and proposals (matches the conventions already used
in `src/main/providers/__fixtures__/` and the newer tests): username `j`, project
`Sample-Project`, host `placeholder-host`.

## 1. Scanned surfaces

| Surface                                                                         | Method                                                                                                                                                                                         | Result                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All 213 tracked files                                                           | `git ls-files` + `git grep` sweeps for the machine username, hostname, employer string, home-path shapes (`C:\Users\`, `/home/`, `/Users/`), sibling-project names, emails, localhost/IP/ports | Findings below                                                                                                                                                                                                                                                                                                                                                                                                          |
| Credential shapes                                                               | GitHub/OpenAI/Google/Slack token prefixes, JWTs, PEM headers, `password=`/`api_key=` sweeps over tracked files **and every one of the 45 historical revisions**                                | **No real credential ever committed.** Only clearly-fake constants in `redactSecrets`/provider tests (intentional)                                                                                                                                                                                                                                                                                                      |
| Hidden/tool dirs                                                                | Tracked-vs-ignored check for `.atl/`, `.codegraph/`, `.github/`, `.claude/`, `.vscode/`, `.idea/`, `out/`, `release/`                                                                          | `.atl/` was tracked (fixed, see below); `.codegraph/`, `out/`, `release/` ignored and untracked; the rest do not exist                                                                                                                                                                                                                                                                                                  |
| Git history                                                                     | `git rev-list --all`, `git log --diff-filter=D --summary`, credential-shape grep across every revision, `.env`/`*.pem`/`*.key`/`*.pfx` path history                                            | See §5                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Images (`build/`, `resources/`, `docs/assets/`, `src/renderer/src/assets/art/`) | Filename + pipeline review (all are outputs of `scripts/build-art.mjs` / `build-icons.mjs` or painted game art), visual spot check of `docs/assets/logo.png`                                   | **Stale as of issue #18** (`c47d2f5`, hours after this audit ran): two real screenshots were added to `docs/assets/`, one briefly leaking three private project names and this repository's own before a human caught it and `1fe418c` replaced the file. See [`skills/privacy-guard/SKILL.md`](../skills/privacy-guard/SKILL.md) for the incident, and issue #51 for the confirmation that the current blobs are clean |
| Test fixtures (`src/main/providers/__fixtures__/`)                              | Full content review                                                                                                                                                                            | Conversation content already placeholder-scrubbed; machine paths/names remain (§4.2)                                                                                                                                                                                                                                                                                                                                    |
| Emails                                                                          | Address-shape sweep                                                                                                                                                                            | Only the intentional author email in `package.json` (§4.4)                                                                                                                                                                                                                                                                                                                                                              |
| Internal URLs/ports                                                             | `localhost`/`127.0.0.1`/private-range sweep                                                                                                                                                    | All hits are the app's own loopback hooks design or third-party research notes — not private infrastructure                                                                                                                                                                                                                                                                                                             |

## 2. Findings fixed by this audit (in-surface)

Severity legend: HIGH = secret/credential or directly identifying private content;
MEDIUM = machine/identity details a public repo should not carry; LOW = cosmetic
identity residue. No HIGH finding existed.

| #   | Severity | Finding                                                                                                                                                                                                                                                | Fix applied                                                                                                       |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| F1  | MEDIUM   | `.atl/skill-registry.md` + `.atl/.skill-registry.cache.json` were **tracked**: a full inventory of the maintainer's personal AI tooling with absolute home paths across eight local tool roots                                                         | Deleted both files; added `.atl/` to `.gitignore` so the tool-generated directory can never be re-tracked         |
| F2  | MEDIUM   | `AGENTNAME_HANDOFF.md` (root): the private remote URL, the absolute local repo path, the two-Claude-account machine setup, and the literal instruction "Never make this repository public"                                                             | Deleted. Content was an internal session-handoff brief; everything durable is already covered by README and docs  |
| F3  | MEDIUM   | `docs/codex-v2-format.md` quoted **real user prompts and an assistant reply verbatim** from the maintainer's local Codex history, plus a real thread `preview`                                                                                         | Replaced with placeholder strings; schema documentation value preserved                                           |
| F4  | MEDIUM   | `docs/provider-formats.md` + `docs/codex-v2-format.md`: machine username in dozens of absolute paths, the machine hostname (twice), three private project names, a real derived session name, a real reply text, and a personal wrapper-tool reference | Replaced with `j` / `Sample-Project` / `placeholder-host` placeholders; all format examples remain shape-accurate |
| F5  | LOW      | `docs/hook-detection-evaluation.md`: "this machine runs two accounts" framing (twice) and one private sibling-project reference                                                                                                                        | Generalized to "multiple Claude roots/accounts are supported" and "a sibling project"                             |
| F6  | LOW      | `pnpm-workspace.yaml` comment named a private sibling project                                                                                                                                                                                          | Renamed to "a sibling project"                                                                                    |

Edited files were re-formatted with the repo's Prettier so `format:check` stays green.

## 3. Accepted exceptions (intentional, keep)

- The maintainer's GitHub profile URLs, name in `LICENSE`/`README.md`, the Ko-fi link,
  and the `package.json` author name — public identity, intentional.
- `com.jeronimorepetto.dwarfaiminers` bundle/autostart id (`src/main/index.ts`,
  `src/main/platform/*`, README) — the app's functional identity; changing it would
  break upgrades.
- The maintainer's name in `docs/signing.md` example configs — publisher identity
  examples.
- The legacy product name `AgentName` in migration code (`autostart*`), README rename
  notes, and docs — functional and publicly documented; the private-remote URL that made
  it sensitive was removed with F2.
- Fake credential constants (`ghp_FAKE...`, `xoxb-...FAKE...`, etc.) in
  `redactSecrets.test.ts` and provider tests — deliberate redaction-test inputs.
- All `127.0.0.1`/`localhost` references — the app's own loopback hooks channel and
  third-party research notes, not private infrastructure.
- Session UUIDs, message/request ids, `procStart` values, and token counts in fixtures
  and docs — non-identifying once paths and prompts are placeholders.

## 4. Report-only items (owned by other zones — proposed changes)

Status: 4.1, 4.2 and 4.3 were applied in full, including the `.env.example` line in
4.1, which the maintainer applied by hand — that file is excluded from tooling by a
local permission rule. The 4.3 CI guard passes against it.

### 4.1 Machine-specific shipped default Claude root (MEDIUM — highest-priority report-only item)

`defaultConfig()` in `src/main/config/config.ts:80` ships a second, machine-specific Claude
account root (a personal `~/.claude-*` directory whose name also hints at the
maintainer's employer) to every user. Proposed change, in one coherent pass:

- `src/main/config/config.ts:80`: default `claudeConfigDirs` becomes `['~/.claude']` only.
- Update together: `src/main/config/config.test.ts:16` (default expectation), the
  `CLAUDE_CONFIG_DIRS` line in `.env.example` (keep a comment showing the
  semicolon-separated multi-root form with a neutral example such as
  `~/.claude;~/.claude-work`), the `CLAUDE_CONFIG_DIRS` default in the README table, and
  the "default roots" sentence in `docs/privacy.md` ("default `~/.claude`, plus any
  roots configured via `CLAUDE_CONFIG_DIRS`").
- Tests that use the personal second-root name merely as an arbitrary value
  (`runtime.test.ts`, `claudeProvider.test.ts`, `fsAdapter.test.ts`,
  `hookChannel.test.ts`, `hookInstaller.test.ts`, plus one comment in
  `claudeProvider.ts`) should switch to a neutral `.claude-work` in the same pass.

Multi-root support itself is a feature and stays; only the shipped default
de-personalizes.

**Applied.** `defaultConfig()` now ships `['~/.claude']`; the doc comment on
`AppConfig.claudeConfigDirs` explains multi-root support generically instead of
describing one machine. `config.test.ts`, the README table row, the
`claudeProvider.ts` comment, and the `docs/privacy.md` sentence moved with it, and
every test use of the personal second root is now `.claude-work`. **Not applied:**
the `.env.example` line, which is outside tooling reach; it should read
`CLAUDE_CONFIG_DIRS=~/.claude` with a comment showing the multi-root form
`~/.claude;~/.claude-work`.

### 4.2 Machine username and layout in `src/**` tests and fixtures (LOW)

The machine username appears as the test username in roughly 25 test files and all four
provider fixtures (`C:\Users\<machine-username>\...`, `/home/<machine-username>/...`,
`/Users/<machine-username>/...`, and encoded-directory forms), alongside the real
Desktop folder layout and one private project name inside an encoded-path expectation in
`src/main/providers/claude/parse.test.ts`. Proposed mechanical sweep (one commit — tests
and fixtures together, because assertions match these strings exactly):

- Machine username → `j` in all test/fixture paths (the repo's newer tests already use
  `C:/Users/j/...`).
- The real Desktop folder and project names → `Sample-Project` variants; the fixture
  session name in `session-entry.json` → `sample-project-70` (its `pidDomain` is already
  `win32:placeholder-host`).
- `src/main/hooks/hookCommand.test.ts:91`: the "user script" example currently points at
  a real personal hook script under the maintainer's home; replace with a neutral
  `node C:/Users/j/.claude/hooks/user-script.js`.
- Optional, same pass: the Codex fixture's real `timezone` value → `"UTC"`.

**Applied** across 36 files under `src/main/` (tests, fixtures, and the two source
doc comments that carried an example session name): machine username → `j`, private
project names → `Sample-Project`, the derived fixture session name →
`sample-project-70`, and the personal hook-script example in `hookCommand.test.ts` →
`node C:/Users/j/.claude/hooks/user-script.js`. The hostname placeholder was already
in place. The Codex fixture `timezone` was already a neutral value, so it was left
alone. **Deferred, then applied:** three house-style comments in
`src/renderer/src/composables/` (`useMines.ts`, `useView.ts`,
`useDwarfMessaging.ts`) named a private sibling project; those files were being
edited concurrently by another work stream, so the rename to "a sibling Vue
project" was left to that stream's pass. It reached `useMines.ts` and
`useView.ts` but missed `useDwarfMessaging.ts`, which kept the private name until
the issue #54 re-sweep generalized it to match its two siblings. That same sweep
also caught a private local project name in two `src/main/textDelivery/relay`
comments and the maintainer's local tooling directory named as the measured
subject in `src/main/tier/tierService.test.ts` — all prose, no assertion moved.
The lesson for the next deferral: a report-only item handed to another stream is
not closed until someone re-reads the file.

### 4.3 CI privacy guard (recommendation — workflows are outside this audit's write surface)

After 4.1/4.2 land, a one-line recurrence guard in `ci.yml` keeps the machine
identifiers from returning. Template — substitute the actual local username and hostname
(the maintainer knows them; they are intentionally not written here):

```yaml
- name: Privacy guard — no machine-specific identifiers
  run: |
    ! git grep -n -I -E '[Uu]sers[/\\-]+<machine-username>|/home/<machine-username>|<hostname>|claude-<second-root-suffix>'
```

The pattern must not match the intentional public identities listed in §3. If 4.1/4.2
are not adopted first, this check cannot pass; adopt them first.

**Applied** as the `Privacy guard (no machine-specific identifiers)` step in the
`checks` job of `.github/workflows/ci.yml`, placed right after checkout so it fails
before the install. Two deviations from the template above: the `/home/` alternative
is anchored as `[Hh]ome[/\\-]+` so the backslash form used in the fake-filesystem
tests is caught too, and the workflow file excludes itself from its own `git grep`,
since it necessarily spells the patterns it searches for. Verified against every §3
identity — `jeronimorepetto`, the GitHub and Ko-fi URLs, the
`com.jeronimorepetto.dwarfaiminers` bundle id, the `LICENSE`/`package.json` name and
the `docs/signing.md` publisher examples all fail to match, because each pattern
requires a `Users`/`home` path separator immediately before the username.

Note the tradeoff this step accepts: a guard that greps for the machine identifiers
must spell them, so `ci.yml` itself becomes the one public file that names them. That
is inherent to the recurrence-guard approach and was accepted deliberately.

### 4.4 Optional consideration

The `package.json` author email is an employer-domain address. It is intentional and
recently set, so it is listed only as a consideration: published package metadata is
effectively permanent — confirm this is the address the maintainer wants attached to a
public project.

## 5. Git history verdict

Facts established:

- 45 commits, no file was ever deleted in history, `.env`/key/cert files were never
  tracked, and **no credential shape appears in any revision** — nothing to rotate.
- However, everything fixed in §2 exists in the pre-fix commits: the `.atl/` registry,
  the handoff document (including the private remote URL and the "never make this
  repository public" line), the real prompts, and all machine identifiers remain
  readable in history if the repository is published as-is.

Recommendation (decision for the maintainer — this audit performed no rewrite):

- **Preferred: publish from a clean history.** Either squash to a fresh initial commit
  (orphan branch) or run `git filter-repo` with replacements for the identifier set
  (machine username, hostname, personal second-root name, the private project names, the
  two deleted files, and the quoted real prompts). Doing it now is cheap because the
  repository is still private.
- Consequences to accept: the `v0.1.0` tag and its GitHub release must be re-created on
  the rewritten commit; commit SHAs referenced in existing issue/PR text will dangle
  (the text itself survives); every existing clone must be re-cloned. There are no
  external contributors yet, so the blast radius is the maintainer's own machines.
- Publishing without a rewrite is defensible only if the maintainer explicitly accepts
  that the above personal details stay permanently browsable in old commits — the
  content is identity/layout information, not credentials.

## 6. Post-audit state of hidden directories

| Directory                                                 | State                                                                                                                                                            |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.atl/`                                                   | Untracked after this audit, now in `.gitignore`                                                                                                                  |
| `.codegraph/`                                             | Ignored, never tracked                                                                                                                                           |
| `.github/`                                                | Tracked intentionally (CI + release workflows only, clean)                                                                                                       |
| `out/`, `release/`, `dist/`, `coverage/`, `node_modules/` | Ignored, never tracked                                                                                                                                           |
| `.claude/`                                                | Tracked intentionally (`rules/coordinates.md` only — the read-triggered rule AGENTS.md points at); the `*.local` ignore covers `settings.local.json`-style files |
| `.vscode/`, `.idea/`                                      | Do not exist                                                                                                                                                     |
