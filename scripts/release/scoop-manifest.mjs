#!/usr/bin/env node
// The manifest of the owner's Scoop bucket (20 §6; ADR-027 item 1; ADR-016 item 7; 18 C-31; ISSUE-275).
//
//   node scripts/release/scoop-manifest.mjs --version <X.Y.Z> --sums <SHA256SUMS> [--url <zip url>] [--out <file>]
//
// It writes `dwarfai.json` (to stdout without `--out`) for the release `<X.Y.Z>`: every field of the 20 §6 outline,
// its strings copied as written there, and the `hash` of `DwarfAI-Miners-<X.Y.Z>-win-x64.zip` read from the release's
// SHA256SUMS (the integrity control of C-31). A SHA256SUMS that does not list that zip is refused. `--url` replaces
// the download url only, for the Windows `package` leg's local Scoop check (scripts/release/scoop/scoop-check.ps1);
// the release manifest keeps the GitHub Release url. Nothing here touches the bucket repository: the owner adds the
// file to it by a reviewed pull request (scripts/release/scoop/README.md).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSha256Sums } from '../ci/sha256sums.mjs'

const REPOSITORY = 'https://github.com/JeronimoRepetto/DwarfAI-Miners'
const EXE = 'DwarfAI-Miners.exe'

/** The Windows zip of a release, as package.json `build.win.artifactName` names it (20 §3.2). */
export function scoopZipName(version) {
  return `DwarfAI-Miners-${version}-win-x64.zip`
}

/**
 * ADR-016 item 7, OQ-59: every uninstall reverts the integrations and an update never does. Scoop runs
 * `pre_uninstall` on `scoop update` too, with its hook context `$cmd` naming the subcommand, so the command runs only
 * when `$cmd` is `uninstall` (20 §6). Package gap resolved in development (ISSUE-275): the outline's call returns at
 * once, because PowerShell does not wait for a GUI-subsystem exe; `| Out-Null` makes Scoop wait for the revert before
 * it removes the app folder.
 */
const PRE_UNINSTALL = `if ($cmd -eq 'uninstall') { & "$dir\\${EXE}" --revert-integrations | Out-Null }`

/** The hash of the version's zip in a SHA256SUMS text; throws when it is not listed. */
function zipHash(version, sha256sums) {
  const name = scoopZipName(version)
  const entry = parseSha256Sums(sha256sums).entries.find((candidate) => candidate.name === name)
  if (entry === undefined) throw new Error(`SHA256SUMS lists no ${name}`)
  return entry.hash
}

/** The bucket manifest of `version`, in the 20 §6 field order. */
export function buildScoopManifest({ version, sha256sums, url }) {
  return {
    version,
    description:
      'Desktop panel that shows your AI coding sessions as dwarfs working in mines. Runs Claude Code, Codex and OpenCode with your own login.',
    homepage: REPOSITORY,
    license: 'GPL-3.0-or-later',
    architecture: {
      '64bit': {
        url: url ?? `${REPOSITORY}/releases/download/v${version}/${scoopZipName(version)}`,
        hash: `sha256:${zipHash(version, sha256sums)}`
      }
    },
    bin: EXE,
    shortcuts: [[EXE, 'DwarfAI-Miners']],
    persist: [],
    pre_uninstall: PRE_UNINSTALL,
    notes: [
      'Logs: %APPDATA%\\DwarfAI-Miners\\logs\\ (never contain prompts, names or secrets).',
      'Running Claude Code, Codex or another tool with your subscription: read the risk notice in the README.'
    ],
    checkver: { github: REPOSITORY },
    autoupdate: {
      architecture: {
        '64bit': {
          url: `${REPOSITORY}/releases/download/v$version/DwarfAI-Miners-$version-win-x64.zip`
        }
      },
      hash: { url: '$baseurl/SHA256SUMS' }
    }
  }
}

const OPTIONS = new Set(['--version', '--sums', '--url', '--out'])

function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (!OPTIONS.has(argv[i]) || argv[i + 1] === undefined) return null
    options[argv[i].slice(2)] = argv[i + 1]
  }
  return options.version && options.sums ? options : null
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2))
  if (options === null) {
    console.error(
      'usage: node scripts/release/scoop-manifest.mjs --version <X.Y.Z> --sums <SHA256SUMS> [--url <zip url>] [--out <file>]'
    )
    process.exit(2)
  }
  try {
    const manifest = buildScoopManifest({
      version: options.version,
      sha256sums: readFileSync(options.sums, 'utf8'),
      url: options.url
    })
    const text = `${JSON.stringify(manifest, null, 2)}\n`
    if (options.out === undefined) {
      process.stdout.write(text)
    } else {
      mkdirSync(path.dirname(options.out), { recursive: true })
      writeFileSync(options.out, text)
    }
  } catch (error) {
    console.error(`scoop-manifest: ${error.message}`)
    process.exit(1)
  }
}
