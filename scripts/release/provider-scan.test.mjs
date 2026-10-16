// layer: L7
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  LEGACY_SDK_PATH,
  checkAllowance,
  loadAllowance,
  loadScanList,
  scanLockfile,
  scanSources
} from './lockfile-provider-scan.mjs'
import { scanArtifact } from './packaged/p03-no-provider-binaries.packaged.mjs'

/**
 * The provider binary scan (`20` §2.3 P-03, R-05; ADR-008 items 1-2; OQ-52; ISSUE-273): one list of provider
 * executables, Agent SDK and provider-CLI packages, checked over every packed app (the asar archive and
 * `app.asar.unpacked`), over the lockfile's production dependencies before packaging, and over production sources for
 * a provider credential store or login. The one legacy allowance lets `@anthropic-ai/claude-agent-sdk*` pass only
 * while the legacy `sdkHeldSession.ts` exists. Every case runs over real temporary trees.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const dirs = []
let list

beforeAll(async () => {
  list = await loadScanList()
})

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function writeFile(root, relative, content = '') {
  const file = path.join(root, ...relative.split('/'))
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
}

/**
 * Writes an asar archive the way @electron/asar lays it out: an 8-byte size pickle holding the header pickle's
 * length, the header pickle (payload size, string length, the JSON header, padded to 4 bytes), then every file's
 * bytes at `8 + headerSize + offset`.
 */
function writeAsar(file, files) {
  const header = { files: {} }
  const chunks = []
  let offset = 0
  for (const [relative, content] of Object.entries(files)) {
    const parts = relative.split('/')
    let node = header
    for (const part of parts.slice(0, -1)) {
      node.files[part] ??= { files: {} }
      node = node.files[part]
    }
    const bytes = Buffer.from(content)
    node.files[parts.at(-1)] = { size: bytes.length, offset: String(offset) }
    chunks.push(bytes)
    offset += bytes.length
  }
  const json = Buffer.from(JSON.stringify(header))
  const padded = Math.ceil(json.length / 4) * 4
  const headerPickle = Buffer.alloc(8 + padded)
  headerPickle.writeUInt32LE(4 + padded, 0)
  headerPickle.writeUInt32LE(json.length, 4)
  json.copy(headerPickle, 8)
  const sizePickle = Buffer.alloc(8)
  sizePickle.writeUInt32LE(4, 0)
  sizePickle.writeUInt32LE(headerPickle.length, 4)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, Buffer.concat([sizePickle, headerPickle, ...chunks]))
}

const manifest = (name) => JSON.stringify({ name, version: '1.0.0' })

/**
 * A packed Windows app in `release/win-unpacked`: `asar` files go into `resources/app.asar`, `unpacked` files into
 * `resources/app.asar.unpacked`, `loose` files anywhere under the app folder.
 */
function packedApp({ asar = {}, unpacked = {}, loose = {} } = {}) {
  const artifactDir = tempDir('p03-artifact-')
  const app = path.join(artifactDir, 'win-unpacked')
  writeAsar(path.join(app, 'resources', 'app.asar'), {
    'package.json': manifest('dwarfai-miners'),
    'out/main/index.js': 'console.log(1)',
    ...asar
  })
  for (const [relative, content] of Object.entries(unpacked)) {
    writeFile(path.join(app, 'resources', 'app.asar.unpacked'), relative, content)
  }
  for (const [relative, content] of Object.entries(loose)) writeFile(app, relative, content)
  writeFile(artifactDir, 'DwarfAI-Miners-Setup-0.20.0-x64.exe', 'installer')
  return artifactDir
}

/** A pnpm 9 lockfile: the root importer's dependency kinds and the snapshots' dependencies. */
function lockfile({
  dependencies = {},
  optionalDependencies = {},
  devDependencies = {},
  snapshots = {}
}) {
  const section = (title, deps) =>
    Object.keys(deps).length === 0
      ? ''
      : `    ${title}:\n` +
        Object.entries(deps)
          .map(
            ([name, version]) =>
              `      '${name}':\n        specifier: ${version}\n        version: ${version}\n`
          )
          .join('')
  const snapshotText = Object.entries(snapshots)
    .map(([key, deps]) => {
      const body = Object.entries(deps)
        .map(([name, version]) => `      '${name}': ${version}\n`)
        .join('')
      return `  '${key}':${body ? `\n    dependencies:\n${body}` : ' {}\n'}\n`
    })
    .join('')
  return (
    `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n\nimporters:\n\n  .:\n` +
    section('dependencies', dependencies) +
    section('optionalDependencies', optionalDependencies) +
    section('devDependencies', devDependencies) +
    `\npackages:\n\n  'vue@3.5.42':\n    resolution: {integrity: sha512-x}\n\nsnapshots:\n\n` +
    snapshotText
  )
}

const SDK_ALLOWANCE = {
  entries: [
    {
      pattern: '@anthropic-ai/claude-agent-sdk*',
      reason: 'legacy Agent SDK path until step 3a',
      removedBy: 'step-3a'
    }
  ]
}

const names = (findings) => findings.map((finding) => finding.name).sort()

describe('provider binary scan (20 P-03)', () => {
  it('[ADR-008, R11, NFR-COMP-03] an artifact containing @anthropic-ai/claude-agent-sdk or any claude-agent-sdk-<os>-<arch> runtime package fails', async () => {
    const sdk = packedApp({
      asar: {
        'node_modules/@anthropic-ai/claude-agent-sdk/package.json': manifest(
          '@anthropic-ai/claude-agent-sdk'
        )
      }
    })
    const runtime = packedApp({
      unpacked: {
        'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/package.json': manifest(
          '@anthropic-ai/claude-agent-sdk-win32-x64'
        ),
        'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/README.md': 'runtime'
      }
    })
    // Found by its folder alone, with no manifest beside it.
    const bare = packedApp({
      unpacked: { 'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/cli.js': '' }
    })

    expect(names((await scanArtifact({ artifactDir: sdk, list, allowance: [] })).findings)).toEqual(
      ['@anthropic-ai/claude-agent-sdk']
    )
    expect(
      names((await scanArtifact({ artifactDir: runtime, list, allowance: [] })).findings)
    ).toEqual(['@anthropic-ai/claude-agent-sdk-win32-x64'])
    expect(
      names((await scanArtifact({ artifactDir: bare, list, allowance: [] })).findings)
    ).toEqual(['@anthropic-ai/claude-agent-sdk-linux-x64'])
  })

  it('[ADR-008, NFR-SEC-02] an artifact containing a claude, codex, opencode, agy, kimi or kiro-cli executable fails, whatever its extension on Windows', async () => {
    const executables = ['claude', 'codex', 'opencode', 'agy', 'kimi', 'kiro-cli']
    for (const [index, name] of executables.entries()) {
      const variants = [name, `${name}.exe`, `${name.toUpperCase()}.CMD`, `${name}.ps1`]
      const artifactDir = packedApp({
        asar: { [`bin/${variants[index % 2]}`]: 'binary' },
        unpacked: { [`tools/${variants[2]}`]: 'binary' },
        loose: { [`resources/${variants[3]}`]: 'binary' }
      })

      const { findings } = await scanArtifact({ artifactDir, list, allowance: [] })

      expect(findings.map((finding) => `${finding.kind} ${finding.name}`)).toEqual([
        `executable ${name}`,
        `executable ${name}`,
        `executable ${name}`
      ])
    }
    // A file that only shares the stem and is not an executable is not a provider binary.
    const notBinaries = packedApp({ asar: { 'docs/claude.md': '', 'out/codex.js': '' } })
    expect(
      (await scanArtifact({ artifactDir: notBinaries, list, allowance: [] })).findings
    ).toEqual([])
  })

  it('[ADR-008] an artifact containing claude-agent-acp, @anthropic-ai/claude-code, @openai/codex or opencode-ai fails', async () => {
    const packages = [
      'claude-agent-acp',
      '@zed-industries/claude-agent-acp',
      '@anthropic-ai/claude-code',
      '@openai/codex',
      'opencode-ai'
    ]
    const asar = {}
    for (const name of packages) asar[`node_modules/${name}/package.json`] = manifest(name)
    // A package whose manifest name is listed is caught even in a folder of another name.
    const renamed = packedApp({
      unpacked: { 'vendor/cli/package.json': manifest('@openai/codex') }
    })

    const { findings } = await scanArtifact({
      artifactDir: packedApp({ asar }),
      list,
      allowance: []
    })

    expect(names(findings)).toEqual([...packages].sort())
    expect(
      names((await scanArtifact({ artifactDir: renamed, list, allowance: [] })).findings)
    ).toEqual(['@openai/codex'])
  })

  it('[ADR-008] a lockfile whose production dependencies include any listed package fails before packaging', () => {
    const lockfileText = lockfile({
      dependencies: { wrapper: '1.0.0', 'claude-agent-acp': '0.5.0' },
      optionalDependencies: { 'opencode-ai': '1.0.0' },
      devDependencies: { '@anthropic-ai/claude-code': '2.0.0' },
      snapshots: {
        'wrapper@1.0.0': { inner: '1.0.0' },
        'inner@1.0.0': { '@openai/codex': '0.9.0' },
        '@openai/codex@0.9.0': {},
        'claude-agent-acp@0.5.0': {},
        'opencode-ai@1.0.0': {},
        '@anthropic-ai/claude-code@2.0.0': {}
      }
    })

    const { findings } = scanLockfile({ lockfileText, list, allowance: [] })

    // The development-only Claude Code CLI never ships, so it is not a finding; the transitive codex is.
    expect(names(findings)).toEqual(['@openai/codex', 'claude-agent-acp', 'opencode-ai'])
  })

  it('[ADR-008] a clean artifact and lockfile pass', async () => {
    const artifactDir = packedApp({
      asar: { 'node_modules/vue/package.json': manifest('vue') },
      unpacked: { 'node_modules/zod/package.json': manifest('zod') }
    })
    const lockfileText = lockfile({
      dependencies: { vue: '3.5.42', zod: '3.25.76' },
      snapshots: { 'vue@3.5.42': {}, 'zod@3.25.76': {} }
    })

    const artifact = await scanArtifact({ artifactDir, list, allowance: [] })
    const lock = scanLockfile({ lockfileText, list, allowance: [] })

    expect(artifact).toMatchObject({ findings: [], apps: 1, scannedPackages: 3 })
    expect(lock).toMatchObject({ findings: [], scannedPackages: 2 })
  })

  it('[ADR-008, R11] an allowance entry lets its package pass only while the legacy sdkHeldSession.ts exists, and a non-empty allowance fails once that file is gone', async () => {
    const artifactDir = packedApp({
      asar: {
        'node_modules/@anthropic-ai/claude-agent-sdk/package.json': manifest(
          '@anthropic-ai/claude-agent-sdk'
        )
      },
      unpacked: {
        'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/package.json': manifest(
          '@anthropic-ai/claude-agent-sdk-win32-x64'
        ),
        // The runtime package carries the Claude Code binary; it passes with its package, and only there.
        'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe': 'binary'
      }
    })

    const withLegacy = tempDir('p03-tree-')
    writeFile(withLegacy, LEGACY_SDK_PATH, 'export {}')
    const legacyPresent = checkAllowance(SDK_ALLOWANCE, { rootDir: withLegacy })
    expect(legacyPresent.errors).toEqual([])
    const passing = await scanArtifact({ artifactDir, list, allowance: legacyPresent.entries })
    expect(passing.findings).toEqual([])
    expect(names(passing.allowed)).toEqual([
      '@anthropic-ai/claude-agent-sdk',
      '@anthropic-ai/claude-agent-sdk-win32-x64'
    ])

    const withoutLegacy = tempDir('p03-tree-')
    const legacyGone = checkAllowance(SDK_ALLOWANCE, { rootDir: withoutLegacy })
    expect(legacyGone.errors).toEqual([
      `the legacy allowance is not empty but ${LEGACY_SDK_PATH} is gone: remove @anthropic-ai/claude-agent-sdk* (removedBy step-3a)`
    ])
    expect(legacyGone.entries).toEqual([])
    expect(
      names((await scanArtifact({ artifactDir, list, allowance: legacyGone.entries })).findings)
    ).toEqual([
      '@anthropic-ai/claude-agent-sdk',
      '@anthropic-ai/claude-agent-sdk-win32-x64',
      'claude'
    ])
    // An empty allowance is the target state and passes with the legacy file gone.
    expect(checkAllowance({ entries: [] }, { rootDir: withoutLegacy })).toEqual({
      errors: [],
      entries: []
    })
  })

  it('[ADR-008] an allowance entry for any package other than @anthropic-ai/claude-agent-sdk* fails', () => {
    const rootDir = tempDir('p03-tree-')
    writeFile(rootDir, LEGACY_SDK_PATH, 'export {}')
    const entry = (pattern) => ({ pattern, reason: 'a reason', removedBy: 'step-3a' })

    for (const pattern of [
      '@openai/codex',
      'claude-agent-acp',
      '@anthropic-ai/*',
      '@anthropic-ai/claude-code'
    ]) {
      const { errors, entries } = checkAllowance({ entries: [entry(pattern)] }, { rootDir })
      expect(errors).toEqual([
        `allowance entry ${pattern} is not allowed: only @anthropic-ai/claude-agent-sdk* may pass`
      ])
      expect(entries).toEqual([])
    }
    // The allowance only shrinks: a second copy of the one entry, or an entry without its reason, is new and fails.
    expect(
      checkAllowance({ entries: [...SDK_ALLOWANCE.entries, ...SDK_ALLOWANCE.entries] }, { rootDir })
        .errors
    ).toEqual(['allowance entry @anthropic-ai/claude-agent-sdk* is listed twice'])
    expect(
      checkAllowance({ entries: [{ pattern: '@anthropic-ai/claude-agent-sdk*' }] }, { rootDir })
        .errors
    ).toEqual([
      'allowance entry @anthropic-ai/claude-agent-sdk* needs a reason and a removedBy step'
    ])
  })

  it('[ADR-008, NFR-SEC-03] a production source that reads a provider credential store or offers a provider login fails the scan', async () => {
    const rootDir = tempDir('p03-tree-')
    writeFile(
      rootDir,
      'src/host/modules/launching/adapters/claudeToken.ts',
      "import path from 'node:path'\nexport const file = (home: string) => path.join(home, '.claude', '.credentials.json')\n"
    )
    writeFile(
      rootDir,
      'src/renderer/src/components/ProviderLogin.vue',
      '<template><a href="#">Sign in</a></template>\n<script setup lang="ts">\nconst url = `https://claude.ai/oauth/authorize?client=${1}`\n</script>\n'
    )
    // Not findings: a comment naming a store, a test, a fake and a contract suite.
    writeFile(
      rootDir,
      'src/host/modules/observation/adapters/store.ts',
      "// never reads `auth.json` (ADR-008 item 2)\nexport const dir = 'storage'\n"
    )
    writeFile(
      rootDir,
      'src/host/modules/launching/claude.test.ts',
      "const leak = 'oauth_creds.json'\n"
    )
    writeFile(
      rootDir,
      'src/host/kernel/fakes/FakeStore.ts',
      "const store = 'google_accounts.json'\n"
    )
    writeFile(
      rootDir,
      'src/host/kernel/ports/secretStore.contract.ts',
      "const store = 'auth.json'\n"
    )

    const { findings, scannedFiles } = await scanSources({ rootDir, list })

    expect(findings.map((finding) => `${finding.kind} ${finding.name} ${finding.where}`)).toEqual([
      'credential .credentials.json src/host/modules/launching/adapters/claudeToken.ts',
      'login claude.ai/oauth src/renderer/src/components/ProviderLogin.vue'
    ])
    expect(scannedFiles).toBe(3)
  })

  it('[ADR-008, R11] the repository lockfile and sources pass, with only @anthropic-ai/claude-agent-sdk* passing by allowance', async () => {
    const allowance = await loadAllowance()
    const { errors } = checkAllowance(allowance, { rootDir: repoRoot })
    expect(errors).toEqual([])

    const output = execFileSync(process.execPath, [path.join(here, 'lockfile-provider-scan.mjs')], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const allowedLines = output.split('\n').filter((line) => line.startsWith('allowed: '))
    expect(allowedLines.length).toBeGreaterThan(0)
    for (const line of allowedLines)
      expect(line).toMatch(/^allowed: @anthropic-ai\/claude-agent-sdk[\w-]*@/)
    expect(output).toMatch(
      /^provider scan ok: \d+ production packages, \d+ source files, no provider binary/m
    )
  })
})
