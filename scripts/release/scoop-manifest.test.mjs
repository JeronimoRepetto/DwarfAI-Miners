// layer: L7
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildScoopManifest, scoopZipName } from './scoop-manifest.mjs'

// The manifest of the owner's Scoop bucket (20 §6; ADR-027 item 1; ADR-016 item 7; 18 C-31; ISSUE-275). The expected
// values below are copied by hand from the 20 §6 outline; the generator must reproduce them, never rewrite them.

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const REPOSITORY = 'https://github.com/JeronimoRepetto/DwarfAI-Miners'
const ZIP_HASH = 'a'.repeat(63) + 'b'
const SUMS = [
  `${'c'.repeat(64)}  DwarfAI-Miners-Setup-1.2.3-x64.exe`,
  `${ZIP_HASH}  DwarfAI-Miners-1.2.3-win-x64.zip`,
  `${'d'.repeat(64)}  DwarfAI-Miners-1.2.3-x86_64.AppImage`,
  ''
].join('\n')

/**
 * Whether a Scoop hook runs `--revert-integrations` when Scoop's hook context `$cmd` is `cmd`. Scoop runs
 * `pre_uninstall` on `scoop update` as well as on `scoop uninstall` (libexec/scoop-update.ps1 calls
 * `Invoke-HookScript -HookType 'pre_uninstall'` before it removes the old version), and its `exec` function names the
 * subcommand `$cmd` (lib/commands.ps1). So only an `if ($cmd -eq '<name>') { … }` guard around the whole hook keeps it
 * from running on update; an unguarded command runs on both. The Windows `package` leg proves the same with Scoop
 * itself (scripts/release/scoop/scoop-check.ps1).
 */
function revertRunsOn(hook, cmd) {
  const script = [hook].flat().join('\n')
  const guarded = /^if \(\$cmd -eq '([a-z]+)'\) \{ ([^{}]+) \}$/.exec(script)
  const body = guarded === null ? script : guarded[2]
  if (!body.includes('--revert-integrations')) return false
  return guarded === null || guarded[1] === cmd
}

let dir
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'scoop-manifest-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('Scoop manifest (20 §6)', () => {
  it("[ADR-027] the manifest hash equals the zip's SHA-256 in SHA256SUMS and the url names the version's zip", () => {
    const manifest = buildScoopManifest({ version: '1.2.3', sha256sums: SUMS })

    expect(scoopZipName('1.2.3')).toBe('DwarfAI-Miners-1.2.3-win-x64.zip')
    expect(manifest.version).toBe('1.2.3')
    expect(manifest.architecture).toEqual({
      '64bit': {
        url: `${REPOSITORY}/releases/download/v1.2.3/DwarfAI-Miners-1.2.3-win-x64.zip`,
        hash: `sha256:${ZIP_HASH}`
      }
    })
  })

  it("[ADR-027] a SHA256SUMS that does not list the version's zip is refused, never written with a guessed hash", () => {
    expect(() => buildScoopManifest({ version: '9.9.9', sha256sums: SUMS })).toThrow(
      'SHA256SUMS lists no DwarfAI-Miners-9.9.9-win-x64.zip'
    )
  })

  it('[ADR-027] a url override moves only the download, and the hash still comes from SHA256SUMS', () => {
    const url = 'http://127.0.0.1:8080/DwarfAI-Miners-1.2.3-win-x64.zip'
    const manifest = buildScoopManifest({ version: '1.2.3', sha256sums: SUMS, url })

    expect(manifest.architecture['64bit']).toEqual({ url, hash: `sha256:${ZIP_HASH}` })
    expect(manifest.autoupdate.architecture['64bit'].url).toBe(
      `${REPOSITORY}/releases/download/v$version/DwarfAI-Miners-$version-win-x64.zip`
    )
  })

  it('[ADR-027] bin, shortcuts, empty persist, license GPL-3.0-or-later, checkver and autoupdate follow 20 §6', () => {
    const manifest = buildScoopManifest({ version: '1.2.3', sha256sums: SUMS })
    const { license } = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))

    expect(Object.keys(manifest)).toEqual([
      'version',
      'description',
      'homepage',
      'license',
      'architecture',
      'bin',
      'shortcuts',
      'persist',
      'pre_uninstall',
      'notes',
      'checkver',
      'autoupdate'
    ])
    expect(manifest.homepage).toBe(REPOSITORY)
    expect(manifest.license).toBe('GPL-3.0-or-later')
    expect(manifest.license).toBe(license)
    expect(manifest.bin).toBe('DwarfAI-Miners.exe')
    expect(manifest.shortcuts).toEqual([['DwarfAI-Miners.exe', 'DwarfAI-Miners']])
    expect(manifest.persist).toEqual([])
    expect(manifest.checkver).toEqual({ github: REPOSITORY })
    expect(manifest.autoupdate).toEqual({
      architecture: {
        '64bit': {
          url: `${REPOSITORY}/releases/download/v$version/DwarfAI-Miners-$version-win-x64.zip`
        }
      },
      hash: { url: '$baseurl/SHA256SUMS' }
    })
  })

  it('[ADR-016, FM-128] pre_uninstall runs --revert-integrations only when the hook context is uninstall, never on update', () => {
    const hook = buildScoopManifest({ version: '1.2.3', sha256sums: SUMS }).pre_uninstall

    expect(revertRunsOn(hook, 'uninstall')).toBe(true)
    expect(revertRunsOn(hook, 'update')).toBe(false)
    // The installed exe of this version, called with the flag alone (NFR-SEC-05), and waited for: PowerShell's call
    // operator returns at once from a GUI-subsystem exe such as Electron's unless its output is piped, which would let
    // Scoop delete the app folder while the revert still runs (measured on Windows PowerShell 5.1, ISSUE-275).
    expect(hook).toBe(
      'if ($cmd -eq \'uninstall\') { & "$dir\\DwarfAI-Miners.exe" --revert-integrations | Out-Null }'
    )
  })

  it('[ADR-027] the notes and description strings equal the 20 §6 outline', () => {
    const manifest = buildScoopManifest({ version: '1.2.3', sha256sums: SUMS })

    expect(manifest.description).toBe(
      'Desktop panel that shows your AI coding sessions as dwarfs working in mines. Runs Claude Code, Codex and OpenCode with your own login.'
    )
    expect(manifest.notes).toEqual([
      'Logs: %APPDATA%\\DwarfAI-Miners\\logs\\ (never contain prompts, names or secrets).',
      'Running Claude Code, Codex or another tool with your subscription: read the risk notice in the README.'
    ])
  })

  it('[ADR-027] the command line writes dwarfai.json from --version, --sums and --url', () => {
    const sums = path.join(dir, 'SHA256SUMS')
    const out = path.join(dir, 'bucket', 'dwarfai.json')
    writeFileSync(sums, SUMS)
    const url = 'http://127.0.0.1:8080/DwarfAI-Miners-1.2.3-win-x64.zip'

    execFileSync(process.execPath, [
      path.join(here, 'scoop-manifest.mjs'),
      '--version',
      '1.2.3',
      '--sums',
      sums,
      '--url',
      url,
      '--out',
      out
    ])

    const written = readFileSync(out, 'utf8')
    expect(written.endsWith('}\n')).toBe(true)
    expect(JSON.parse(written)).toEqual(
      buildScoopManifest({ version: '1.2.3', sha256sums: SUMS, url })
    )
  })
})
