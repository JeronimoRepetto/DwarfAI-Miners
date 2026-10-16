// layer: L7
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ALLOWANCE_FILE,
  buildLicenceReport,
  judgeLicence,
  parseLockfile,
  PRODUCT_LICENSE,
  productionPackages,
  readDenied
} from './licenses.mjs'
import { checkS008Records, parseS008Rows } from './s008-records.mjs'
import { buildNotices } from './third-party-notices.mjs'

/**
 * The licence report, the S-008-1 record check and the third-party notices (`20` §2.4, §2.5; `18` C-34, C-35, C-36;
 * ISSUE-272). Each case builds a small project in its own temporary folder: a package.json, a hand-written pnpm
 * lockfile and the pnpm virtual store the report reads the installed licences from, so nothing reaches the network.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const denied = readDenied(path.join(repoRoot, 'scripts', 'release', 'licenses.denied.json'))

let dir
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'licences-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function write(relative, text) {
  const file = path.join(dir, relative)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}

/**
 * A project with the given production dependencies (each `{ name, version, license, files?, requires? }`), one
 * dev dependency that never counts, and every package installed in the pnpm virtual store.
 */
function project({ license = PRODUCT_LICENSE, deps, transitive = [] }) {
  write(
    'package.json',
    JSON.stringify({ name: 'fixture-app', version: '1.2.3', license, dependencies: {} })
  )
  const devDep = { name: 'dev-only', version: '9.0.0', license: 'UNLICENSED' }
  const all = [...deps, ...transitive, devDep]
  const entry = (d) =>
    `      '${d.name}':\n        specifier: ${d.version}\n        version: ${d.version}\n`
  const requires = (d) =>
    d.requires?.length
      ? `    dependencies:\n${d.requires.map((r) => `      '${r.name}': ${r.version}\n`).join('')}`
      : ''
  write(
    'pnpm-lock.yaml',
    [
      "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n\nimporters:\n\n  .:\n",
      `    dependencies:\n${deps.map(entry).join('')}`,
      `    devDependencies:\n${entry(devDep)}`,
      '\npackages:\n\n',
      all
        .map(
          (d) =>
            `  '${d.name}@${d.version}':\n    resolution: {integrity: sha512-x}\n${d.platform ?? ''}\n`
        )
        .join(''),
      'snapshots:\n\n',
      all
        .map((d) => `  '${d.name}@${d.version}':${requires(d) ? `\n${requires(d)}` : ' {}\n'}\n`)
        .join('')
    ].join('')
  )
  for (const d of all.filter((p) => p.installed !== false)) {
    const store = `node_modules/.pnpm/${d.name.replace('/', '+')}@${d.version}/node_modules/${d.name}`
    write(
      `${store}/package.json`,
      JSON.stringify({ name: d.name, version: d.version, license: d.license })
    )
    for (const [name, text] of Object.entries(d.files ?? {})) write(`${store}/${name}`, text)
  }
}

describe('licence report and notices (20 §2.4)', () => {
  it('[ADR-008] a production dependency with a denied licence fails the report', () => {
    project({
      deps: [
        {
          name: 'left-pad',
          version: '1.0.0',
          license: 'MIT',
          requires: [{ name: 'tiny', version: '2.0.0' }]
        },
        { name: 'closed-thing', version: '3.1.0', license: 'UNLICENSED' },
        { name: 'see-readme', version: '0.1.0', license: 'SEE LICENSE IN README.md' },
        { name: 'dual', version: '4.0.0', license: '(MIT OR GPL-2.0-only)' },
        { name: 'both', version: '5.0.0', license: 'MIT AND CC-BY-NC-4.0' }
      ],
      transitive: [{ name: 'tiny', version: '2.0.0', license: 'ISC' }]
    })
    const report = buildLicenceReport({ rootDir: dir, denied })
    expect(report.packages.map((p) => [`${p.name}@${p.version}`, p.license, p.verdict])).toEqual([
      ['both@5.0.0', 'MIT AND CC-BY-NC-4.0', 'denied'],
      ['closed-thing@3.1.0', 'UNLICENSED', 'denied'],
      ['dual@4.0.0', '(MIT OR GPL-2.0-only)', 'allowed'],
      ['left-pad@1.0.0', 'MIT', 'allowed'],
      ['see-readme@0.1.0', 'SEE LICENSE IN README.md', 'unknown'],
      ['tiny@2.0.0', 'ISC', 'allowed']
    ])
    expect(report.failures).toEqual([
      'both@5.0.0: licence "MIT AND CC-BY-NC-4.0" is denied (CC-BY-NC-4.0)',
      'closed-thing@3.1.0: licence "UNLICENSED" is denied (UNLICENSED)',
      'see-readme@0.1.0: licence "SEE LICENSE IN README.md" is not an SPDX expression'
    ])
  })

  it('[ADR-008] a dependency with no licence at all, or not installed, fails rather than passing unread', () => {
    project({ deps: [{ name: 'bare', version: '1.0.0' }] })
    rmSync(path.join(dir, 'node_modules/.pnpm/bare@1.0.0/node_modules/bare/package.json'))
    expect(buildLicenceReport({ rootDir: dir, denied }).failures).toEqual([
      'bare@1.0.0: not installed, so its licence cannot be read'
    ])
    project({ deps: [{ name: 'bare', version: '1.0.0' }] })
    expect(buildLicenceReport({ rootDir: dir, denied }).failures).toEqual([
      'bare@1.0.0: package.json declares no licence'
    ])
  })

  it('[ADR-008] a platform package no artifact installs may be absent on this runner; one an artifact installs may not', () => {
    project({
      deps: [
        {
          name: 'core-linux-x64-musl',
          version: '1.0.0',
          license: 'MIT',
          installed: false,
          platform: '    cpu: [x64]\n    os: [linux]\n    libc: [musl]\n'
        },
        {
          name: 'core-win32-x64',
          version: '1.0.0',
          license: 'MIT',
          installed: false,
          platform: '    cpu: [x64]\n    os: [win32]\n'
        }
      ]
    })
    const report = buildLicenceReport({ rootDir: dir, denied })
    expect(report.notShipped).toEqual(['core-linux-x64-musl@1.0.0'])
    expect(report.packages.map((p) => [p.name, p.verdict])).toEqual([
      ['core-linux-x64-musl', 'not-shipped'],
      ['core-win32-x64', 'unknown']
    ])
    expect(report.failures).toEqual([
      'core-win32-x64@1.0.0: not installed, so its licence cannot be read'
    ])
  })

  it('[ADR-008, S-008-1] a bundled adapter without a closed GPL-compatible record fails; one with it passes', () => {
    const acp = {
      name: '@agentclientprotocol/sdk',
      version: '1.6.0',
      license: 'Apache-2.0'
    }
    const header =
      '| Package and pinned version | License (SPDX) | Redistribution | GPL-3.0-or-later compatible | NOTICE / attribution | Runtime dependencies | Pinning | Owner decision (2026-10-16) |\n' +
      '| --- | --- | --- | --- | --- | --- | --- | --- |\n'
    const row = (version, compatible, decision) =>
      `| \`@agentclientprotocol/sdk\` ${version} | Apache-2.0 | allowed | ${compatible} | none | none | exact ${version} | ${decision} |\n`
    project({ deps: [acp, { name: 'left-pad', version: '1.0.0', license: 'MIT' }] })
    const packages = buildLicenceReport({ rootDir: dir, denied }).packages

    expect(checkS008Records({ packages, rows: parseS008Rows(header) }).failures).toEqual([
      '@agentclientprotocol/sdk@1.6.0: no S-008-1 row for this pinned version'
    ])
    expect(
      checkS008Records({
        packages,
        rows: parseS008Rows(header + row('1.5.0', 'yes', '**bundle: yes**'))
      }).failures
    ).toEqual(['@agentclientprotocol/sdk@1.6.0: no S-008-1 row for this pinned version'])
    expect(
      checkS008Records({
        packages,
        rows: parseS008Rows(header + row('1.6.0', 'no', '**bundle: yes**'))
      }).failures
    ).toEqual([
      '@agentclientprotocol/sdk@1.6.0: its S-008-1 row is not GPL-3.0-or-later compatible'
    ])
    expect(
      checkS008Records({
        packages,
        rows: parseS008Rows(header + row('1.6.0', 'yes', '**bundle: no**'))
      }).failures
    ).toEqual(['@agentclientprotocol/sdk@1.6.0: its S-008-1 row does not decide to bundle it'])

    const closed = checkS008Records({
      packages,
      rows: parseS008Rows(header + row('1.6.0', 'yes', '**bundle: yes**'))
    })
    expect(closed.failures).toEqual([])
    expect(closed.checked).toEqual(['@agentclientprotocol/sdk@1.6.0'])
  })

  it('[ADR-008, S-008-1] the committed S-008-1 record parses into one closed row per package it decided', () => {
    const rows = parseS008Rows(
      readFileSync(path.join(repoRoot, 'spike-results', 'S-008-1.md'), 'utf8')
    )
    expect(rows.map((r) => [`${r.name}@${r.version}`, r.licence, r.compatible, r.bundle])).toEqual([
      ['@agentclientprotocol/sdk@1.6.0', 'Apache-2.0', true, true],
      ['@napi-rs/keyring@2.1.0', 'MIT', true, true],
      ['@napi-rs/keyring-win32-x64-msvc@2.1.0', 'MIT', true, true]
    ])
  })

  it("[NFR-COMP-07] the generated notices list every production dependency, the Electron licence file, each bundled adapter's NOTICE and the font, audio and artwork credits", () => {
    project({
      deps: [
        {
          name: '@agentclientprotocol/sdk',
          version: '1.6.0',
          license: 'Apache-2.0',
          files: { LICENSE: 'Apache License text', NOTICE: 'ACP NOTICE text' }
        },
        {
          name: 'left-pad',
          version: '1.0.0',
          license: 'MIT',
          files: { 'LICENSE.md': 'MIT text of left-pad' }
        },
        {
          name: '@napi-rs/keyring',
          version: '2.1.0',
          license: 'MIT',
          files: { LICENSE: 'MIT text of keyring' }
        },
        { name: '@napi-rs/keyring-win32-x64-msvc', version: '2.1.0', license: 'MIT' }
      ]
    })
    write(
      'node_modules/electron/package.json',
      JSON.stringify({ name: 'electron', version: '44.0.0', license: 'MIT' })
    )
    write('node_modules/electron/LICENSE', 'Copyright (c) Electron contributors')
    write('FONT-CREDITS.md', '# Font credits\n\nPixelify Sans, OFL-1.1\n')
    write('AUDIO-CREDITS.md', '# Audio credits\n\nCC0 picks\n')
    write('ARTWORK-LICENSE.md', '# Artwork License\n\nAll rights reserved artwork\n')

    const report = buildLicenceReport({ rootDir: dir, denied })
    const notices = buildNotices({ rootDir: dir, report })

    expect(notices).toContain('fixture-app 1.2.3 is licensed under GPL-3.0-or-later')
    for (const p of report.packages)
      expect(notices).toContain(`### ${p.name} ${p.version} (${p.license})`)
    expect(notices).toContain('MIT text of left-pad')
    expect(notices).toContain('### Electron 44.0.0 (MIT)')
    expect(notices).toContain('Copyright (c) Electron contributors')
    expect(notices).toContain('`LICENSES.chromium.html`')
    expect(notices).toContain('ACP NOTICE text')
    expect(notices).toContain('Apache License text')
    // A platform binary that ships no licence file carries its main package's text (S-008-1 decision).
    const binary = notices.slice(notices.indexOf('### @napi-rs/keyring-win32-x64-msvc 2.1.0'))
    expect(binary.slice(0, binary.indexOf('\n### ', 4))).toContain('MIT text of keyring')
    expect(notices).toContain('Pixelify Sans, OFL-1.1')
    expect(notices).toContain('CC0 picks')
    expect(notices).toContain('All rights reserved artwork')
  })

  it('[NFR-COMP-07] the notices refuse to be written without a credits file or the Electron licence', () => {
    project({ deps: [{ name: 'left-pad', version: '1.0.0', license: 'MIT' }] })
    const report = buildLicenceReport({ rootDir: dir, denied })
    expect(() => buildNotices({ rootDir: dir, report })).toThrow(
      /node_modules\/electron\/LICENSE is missing/
    )
    write(
      'node_modules/electron/package.json',
      JSON.stringify({ name: 'electron', version: '44.0.0', license: 'MIT' })
    )
    write('node_modules/electron/LICENSE', 'Electron')
    expect(() => buildNotices({ rootDir: dir, report })).toThrow(/FONT-CREDITS\.md is missing/)
  })

  it('[ADR-008] the report states GPL-3.0-or-later for the product and it matches package.json license', () => {
    project({ deps: [{ name: 'left-pad', version: '1.0.0', license: 'MIT' }] })
    const report = buildLicenceReport({ rootDir: dir, denied })
    expect(report.product).toEqual({
      name: 'fixture-app',
      version: '1.2.3',
      license: 'GPL-3.0-or-later'
    })
    expect(report.failures).toEqual([])

    project({ license: 'MIT', deps: [{ name: 'left-pad', version: '1.0.0', license: 'MIT' }] })
    expect(buildLicenceReport({ rootDir: dir, denied }).failures).toEqual([
      'package.json license is "MIT", but the product is GPL-3.0-or-later'
    ])

    const real = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
    expect(real.license).toBe(PRODUCT_LICENSE)
  })
})

describe('the legacy Agent SDK allowance (ISSUE-273 provider-scan.allowance.json)', () => {
  /** The committed allowance itself, read from ISSUE-273's file rather than copied into a fixture. */
  const allowance = JSON.parse(readFileSync(path.join(repoRoot, ALLOWANCE_FILE), 'utf8'))
  const sdk = [
    {
      name: '@anthropic-ai/claude-agent-sdk',
      version: '0.3.258',
      license: 'SEE LICENSE IN README.md'
    },
    {
      name: '@anthropic-ai/claude-agent-sdk-win32-x64',
      version: '0.3.258',
      license: 'SEE LICENSE IN LICENSE.md'
    },
    { name: 'left-pad', version: '1.0.0', license: 'MIT' },
    { name: 'closed-thing', version: '3.1.0', license: 'UNLICENSED' }
  ]

  it('[ADR-008] the Agent SDK packages pass, printed as allowed, while the legacy SDK path exists; nothing else does', () => {
    project({ deps: sdk })
    write('src/main/sessionLaunch/sdkHeldSession.ts', 'export {}\n')
    const report = buildLicenceReport({ rootDir: dir, denied, allowance })
    expect(report.allowed).toEqual([
      '@anthropic-ai/claude-agent-sdk@0.3.258 by the legacy allowance @anthropic-ai/claude-agent-sdk* (removedBy step-3a)',
      '@anthropic-ai/claude-agent-sdk-win32-x64@0.3.258 by the legacy allowance @anthropic-ai/claude-agent-sdk* (removedBy step-3a)'
    ])
    expect(report.packages.find((p) => p.name === '@anthropic-ai/claude-agent-sdk').verdict).toBe(
      'allowance'
    )
    expect(report.failures).toEqual([
      'closed-thing@3.1.0: licence "UNLICENSED" is denied (UNLICENSED)'
    ])
  })

  it('[ADR-008] once the legacy SDK path is gone the allowance is stale: it fails, and the SDK packages fail again', () => {
    project({ deps: sdk.slice(0, 3) })
    const report = buildLicenceReport({ rootDir: dir, denied, allowance })
    expect(report.allowed).toEqual([])
    expect(report.failures).toEqual([
      'allowance: the legacy allowance is not empty but src/main/sessionLaunch/sdkHeldSession.ts is gone: remove @anthropic-ai/claude-agent-sdk* (removedBy step-3a)',
      '@anthropic-ai/claude-agent-sdk@0.3.258: licence "SEE LICENSE IN README.md" is not an SPDX expression',
      '@anthropic-ai/claude-agent-sdk-win32-x64@0.3.258: licence "SEE LICENSE IN LICENSE.md" is not an SPDX expression'
    ])
  })

  it('[ADR-008] the repository report passes today only by that allowance', () => {
    const report = buildLicenceReport({ rootDir: repoRoot, denied, allowance })
    expect(report.failures).toEqual([])
    expect(report.allowed.length).toBeGreaterThan(0)
    for (const line of report.allowed) expect(line).toMatch(/^@anthropic-ai\/claude-agent-sdk/)
  })
})

describe('the lockfile and SPDX reading behind the report (20 §2.4)', () => {
  it('[ADR-008] walks dependencies and optionalDependencies of the root importer, never devDependencies', () => {
    const lock = parseLockfile(
      [
        "lockfileVersion: '9.0'",
        'importers:',
        '  .:',
        '    dependencies:',
        "      '@scope/a':",
        '        specifier: 1.0.0',
        '        version: 1.0.0(peer@2.0.0)',
        '    optionalDependencies:',
        '      bin-win:',
        '        specifier: 1.0.0',
        '        version: 1.0.0',
        '    devDependencies:',
        '      vitest:',
        '        specifier: 4.0.0',
        '        version: 4.0.0',
        'packages:',
        "  '@scope/a@1.0.0':",
        '    resolution: {integrity: sha512-a}',
        '  bin-win@1.0.0:',
        '    resolution: {integrity: sha512-b}',
        '    cpu: [x64]',
        '    os: [win32]',
        'snapshots:',
        "  '@scope/a@1.0.0(peer@2.0.0)':",
        '    dependencies:',
        '      peer: 2.0.0',
        '    transitivePeerDependencies:',
        '      - supports-color',
        '      - bufferutil',
        '  peer@2.0.0: {}',
        '  bin-win@1.0.0:',
        '    optional: true',
        '  vitest@4.0.0: {}',
        ''
      ].join('\r\n')
    )
    expect(lock.packages['bin-win@1.0.0']).toMatchObject({ os: ['win32'], cpu: ['x64'] })
    expect(lock.snapshots['@scope/a@1.0.0(peer@2.0.0)'].transitivePeerDependencies).toEqual([
      'supports-color',
      'bufferutil'
    ])
    expect(productionPackages(lock)).toEqual([
      { name: '@scope/a', version: '1.0.0' },
      { name: 'bin-win', version: '1.0.0' },
      { name: 'peer', version: '2.0.0' }
    ])
  })

  it('[ADR-008] does not follow an optional peer edge: the peer is provided by whoever installs the package, not shipped by it', () => {
    // vue@3.5.42 declares `typescript` an optional peer; the lockfile resolves it under vue's optionalDependencies
    // only because the root has typescript as a dev dependency (main-line run 38939771861).
    const lock = parseLockfile(
      [
        "lockfileVersion: '9.0'",
        'importers:',
        '  .:',
        '    dependencies:',
        '      vue:',
        '        specifier: 3.5.42',
        '        version: 3.5.42(typescript@6.0.3)',
        '      needs-peer:',
        '        specifier: 1.0.0',
        '        version: 1.0.0(zod@3.0.0)',
        '    devDependencies:',
        '      typescript:',
        '        specifier: 6.0.3',
        '        version: 6.0.3',
        'packages:',
        '  vue@3.5.42:',
        '    resolution: {integrity: sha512-a}',
        '    peerDependencies:',
        "      typescript: '*'",
        '    peerDependenciesMeta:',
        '      typescript:',
        '        optional: true',
        '  needs-peer@1.0.0:',
        '    resolution: {integrity: sha512-b}',
        '    peerDependencies:',
        "      zod: '^3.0.0'",
        'snapshots:',
        '  vue@3.5.42(typescript@6.0.3):',
        '    optionalDependencies:',
        '      typescript: 6.0.3',
        '  needs-peer@1.0.0(zod@3.0.0):',
        '    dependencies:',
        '      zod: 3.0.0',
        '  zod@3.0.0: {}',
        '  typescript@6.0.3: {}',
        ''
      ].join('\n')
    )
    expect(productionPackages(lock)).toEqual([
      { name: 'needs-peer', version: '1.0.0' },
      { name: 'vue', version: '3.5.42' },
      { name: 'zod', version: '3.0.0' }
    ])
    expect(productionPackages(lock, { optionalPeers: true }).map((p) => p.name)).toEqual([
      'needs-peer',
      'typescript',
      'vue',
      'zod'
    ])
  })

  it('[ADR-008] judges an SPDX expression: OR needs one allowed alternative, AND needs every term allowed', () => {
    expect(judgeLicence('MIT', denied).verdict).toBe('allowed')
    expect(judgeLicence('Apache-2.0 WITH LLVM-exception', denied).verdict).toBe('allowed')
    expect(judgeLicence('(GPL-2.0-only OR MIT)', denied).verdict).toBe('allowed')
    expect(judgeLicence('GPL-2.0-only', denied)).toEqual({
      verdict: 'denied',
      denied: ['GPL-2.0-only']
    })
    expect(judgeLicence('MIT AND (SSPL-1.0 OR BUSL-1.1)', denied)).toEqual({
      verdict: 'denied',
      denied: ['SSPL-1.0', 'BUSL-1.1']
    })
    expect(judgeLicence('MIT OR', denied).verdict).toBe('unknown')
    expect(judgeLicence('', denied).verdict).toBe('unknown')
  })
})
