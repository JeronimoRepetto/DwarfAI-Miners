# Licences of what ships

DwarfAI-Miners is licensed under **GPL-3.0-or-later** (`LICENSE`). This folder explains how the licence of everything
else that ships with the app is recorded and checked. None of it is a legal conclusion: the denied list and every
S-008-1 decision belong to release/legal.

## What the release checks produce

The `license-sbom` CI job runs these scripts on every push to `main`, on `v*` tags and on a manual dispatch. Each script
reads only `pnpm-lock.yaml` and the installed packages, never the network, and writes its output to
`release/licenses/`, which git ignores.

| Script                                    | Output                   | Fails when                                                                                                                                                                     |
| ----------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/release/licenses.mjs`            | `licenses.json`          | a production dependency's licence is in `scripts/release/licenses.denied.json`, is not an SPDX expression or cannot be read; or `package.json` does not say `GPL-3.0-or-later` |
| `scripts/release/s008-records.mjs`        | none                     | a bundled provider adapter or library has no closed, GPL-compatible S-008-1 row for the exact version the lockfile pins                                                        |
| `scripts/release/sbom.mjs`                | `sbom-<os>.json`         | the `pnpm sbom` CycloneDX document does not list exactly the lockfile's production packages                                                                                    |
| `scripts/release/third-party-notices.mjs` | `THIRD-PARTY-NOTICES.md` | Electron's licence or one of `FONT-CREDITS.md`, `AUDIO-CREDITS.md` and `ARTWORK-LICENSE.md` is missing                                                                         |

One exception is shared with the provider scan (ISSUE-273): while the legacy Agent SDK path
`src/main/sessionLaunch/sdkHeldSession.ts` exists, `scripts/release/provider-scan.allowance.json` lets the
`@anthropic-ai/claude-agent-sdk*` packages pass the licence report. Each one is printed as `allowed:`, never hidden.
Once that path is gone, a non-empty allowance fails the report.

You can run each one locally from the repository root, for example `node scripts/release/licenses.mjs`. The SBOM
script reads a `pnpm sbom` document:

```sh
pnpm sbom --sbom-format cyclonedx --prod --sbom-type application > release/licenses/pnpm-sbom.json
node scripts/release/sbom.mjs --input release/licenses/pnpm-sbom.json
```

## S-008-1 records

A provider adapter or library ships inside the app only when its S-008-1 row says it may (ADR-008 item 1). The rows
live in one record, the results table of [`S-008-1.md`](S-008-1.md), with one row
per package and pinned version. `scripts/release/s008-records.mjs` reads that table.

A package is in scope when `S008_SCOPE` in `scripts/release/s008-records.mjs` names it, or when an S-008-1 row names
it. The issue that bundles a new adapter or library adds the package to `S008_SCOPE` and adds its row in the same
change.

### Row template

Add a row to the results table of `docs/licenses/S-008-1.md` with these columns. A row with a new version replaces
nothing: a pin that moves gets its own row.

| Column                      | What to write                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| Package and pinned version  | the package name in backticks, a space, then the exact version, for example `` `@scope/name` 1.2.3 `` |
| License (SPDX)              | the SPDX expression the package declares                                                              |
| Redistribution              | `allowed`, or what the licence forbids                                                                |
| GPL-3.0-or-later compatible | `yes` or `no`, then the source of the verdict (the FSF licence list is the reference)                 |
| NOTICE / attribution        | whether the package ships a `NOTICE` file, and what the third-party notices must carry                |
| Runtime dependencies        | what the package pulls in at runtime                                                                  |
| Pinning                     | the pinning policy, for example `exact 1.2.3`                                                         |
| Owner decision (`<date>`)   | `**bundle: yes**` or `**bundle: no**`, with the drivers a "no" disables                               |

The record's front matter and "Decision" section carry the date and the reviewer role (release/legal). The check passes
a package only when its row says `yes` for GPL-3.0-or-later compatibility and `bundle: yes`.

## Third-party notices

`THIRD-PARTY-NOTICES.md` holds, in this order:

1. the product licence line;
2. Electron's licence, and a pointer to `LICENSES.chromium.html`, which Electron ships beside the executable;
3. each bundled provider adapter or library, with its `NOTICE` text and licence text;
4. every other production dependency, with its SPDX licence and licence text;
5. the font, audio and artwork credits.

A platform binary that ships no licence file of its own (such as `@napi-rs/keyring-win32-x64-msvc`) carries the licence
text of its main package, as its S-008-1 row records.
