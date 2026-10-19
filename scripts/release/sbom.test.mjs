// layer: L7
import { describe, expect, it } from 'vitest'
import { parseLockfile } from './licenses.mjs'
import {
  ARTIFACT_OSES,
  checkSbomMatchesLockfile,
  sbomDifferences,
  sbomForArtifact
} from './sbom.mjs'

/**
 * One SBOM per artifact (`20` §2.4 "SBOM", §3.2 `sbom-<os>.json`; `18` C-36; ISSUE-272). The generator is the pinned
 * pnpm's own `pnpm sbom` (CycloneDX); this script cuts its whole-lockfile document into the components each OS's
 * artifact installs, by the `os`, `cpu` and `libc` fields the lockfile records, and refuses a document that does not
 * list exactly the lockfile's production packages.
 */

const LOCK = parseLockfile(
  [
    "lockfileVersion: '9.0'",
    'importers:',
    '  .:',
    '    dependencies:',
    "      '@scope/core':",
    '        specifier: 1.0.0',
    '        version: 1.0.0',
    '    optionalDependencies:',
    "      '@scope/core-win32-x64':",
    '        specifier: 1.0.0',
    '        version: 1.0.0',
    "      '@scope/core-darwin-arm64':",
    '        specifier: 1.0.0',
    '        version: 1.0.0',
    "      '@scope/core-linux-x64-musl':",
    '        specifier: 1.0.0',
    '        version: 1.0.0',
    "      '@scope/core-linux-x64':",
    '        specifier: 1.0.0',
    '        version: 1.0.0',
    '      not-windows:',
    '        specifier: 2.0.0',
    '        version: 2.0.0',
    'packages:',
    "  '@scope/core@1.0.0':",
    '    resolution: {integrity: sha512-a}',
    "  '@scope/core-win32-x64@1.0.0':",
    '    resolution: {integrity: sha512-b}',
    '    cpu: [x64]',
    '    os: [win32]',
    "  '@scope/core-darwin-arm64@1.0.0':",
    '    resolution: {integrity: sha512-c}',
    '    cpu: [arm64]',
    '    os: [darwin]',
    "  '@scope/core-linux-x64-musl@1.0.0':",
    '    resolution: {integrity: sha512-d}',
    '    cpu: [x64]',
    '    os: [linux]',
    '    libc: [musl]',
    "  '@scope/core-linux-x64@1.0.0':",
    '    resolution: {integrity: sha512-e}',
    '    cpu: [x64]',
    '    os: [linux]',
    '    libc: [glibc]',
    '  not-windows@2.0.0:',
    '    resolution: {integrity: sha512-f}',
    "    os: ['!win32']",
    'snapshots:',
    "  '@scope/core@1.0.0': {}",
    "  '@scope/core-win32-x64@1.0.0': {}",
    "  '@scope/core-darwin-arm64@1.0.0': {}",
    "  '@scope/core-linux-x64-musl@1.0.0': {}",
    "  '@scope/core-linux-x64@1.0.0': {}",
    '  not-windows@2.0.0: {}',
    ''
  ].join('\n')
)

const ref = (name, version) => `pkg:npm/${name.replace('@', '%40')}@${version}`
const component = (name, version) => {
  const slash = name.lastIndexOf('/')
  return {
    type: 'library',
    ...(slash === -1 ? { name } : { group: name.slice(0, slash), name: name.slice(slash + 1) }),
    version,
    'bom-ref': ref(name, version),
    licenses: [{ license: { id: 'MIT' } }]
  }
}
const NAMES = [
  ['@scope/core', '1.0.0'],
  ['@scope/core-win32-x64', '1.0.0'],
  ['@scope/core-darwin-arm64', '1.0.0'],
  ['@scope/core-linux-x64-musl', '1.0.0'],
  ['@scope/core-linux-x64', '1.0.0'],
  ['not-windows', '2.0.0']
]
const root = ref('fixture-app', '1.2.3')
const BOM = {
  bomFormat: 'CycloneDX',
  specVersion: '1.7',
  metadata: {
    component: { type: 'application', name: 'fixture-app', version: '1.2.3', 'bom-ref': root }
  },
  components: NAMES.map(([n, v]) => component(n, v)),
  dependencies: [
    { ref: root, dependsOn: NAMES.map(([n, v]) => ref(n, v)) },
    ...NAMES.map(([n, v]) => ({ ref: ref(n, v), dependsOn: [] }))
  ]
}

const names = (bom) => bom.components.map((c) => (c.group ? `${c.group}/${c.name}` : c.name))

describe('one SBOM per artifact (20 §2.4, §3.2)', () => {
  it('[NFR-COMP-07] each OS SBOM keeps only the components that OS installs, and its dependency graph with them', () => {
    expect(ARTIFACT_OSES).toEqual(['windows', 'macos', 'linux'])
    const windows = sbomForArtifact(BOM, LOCK, 'windows')
    expect(names(windows)).toEqual(['@scope/core', '@scope/core-win32-x64'])
    expect(names(sbomForArtifact(BOM, LOCK, 'macos'))).toEqual([
      '@scope/core',
      '@scope/core-darwin-arm64',
      'not-windows'
    ])
    expect(names(sbomForArtifact(BOM, LOCK, 'linux'))).toEqual([
      '@scope/core',
      '@scope/core-linux-x64',
      'not-windows'
    ])
    expect(windows.dependencies.map((d) => d.ref)).toEqual([
      root,
      ref('@scope/core', '1.0.0'),
      ref('@scope/core-win32-x64', '1.0.0')
    ])
    expect(windows.dependencies[0].dependsOn).toEqual([
      ref('@scope/core', '1.0.0'),
      ref('@scope/core-win32-x64', '1.0.0')
    ])
    expect(windows.metadata.properties).toContainEqual({
      name: 'dwarfai:artifact-os',
      value: 'windows'
    })
    // The whole-lockfile document is not changed.
    expect(BOM.components).toHaveLength(6)
  })

  it('[ADR-008] an SBOM that does not list exactly the lockfile production packages is an error', () => {
    expect(checkSbomMatchesLockfile(BOM, LOCK)).toEqual([])
    const missing = { ...BOM, components: BOM.components.slice(1) }
    const extra = { ...BOM, components: [...BOM.components, component('stray', '0.0.1')] }
    expect(checkSbomMatchesLockfile(missing, LOCK)).toEqual([
      'the SBOM is missing @scope/core@1.0.0, a production package of the lockfile'
    ])
    expect(checkSbomMatchesLockfile(extra, LOCK)).toEqual([
      'the SBOM lists stray@0.0.1, which is not a production package of the lockfile'
    ])
    expect(checkSbomMatchesLockfile({ bomFormat: 'SPDX' }, LOCK)).toEqual([
      'the SBOM is not a CycloneDX document with components'
    ])
  })
})

/**
 * What the generator legitimately leaves out or adds, reproduced from the main-line failure of 2026-10-16 (run
 * 38939771861): on a glibc Linux runner pnpm installs no musl binary, so `pnpm sbom` lists none; and an optional peer
 * (vue's `typescript`) is resolved in the lockfile only because the root has it as a dev dependency, which pnpm
 * 11.28.6's `pnpm sbom --prod` leaves out while 11.1.1 lists it.
 */
const PEER_LOCK = parseLockfile(
  [
    "lockfileVersion: '9.0'",
    'importers:',
    '  .:',
    '    dependencies:',
    '      app-lib:',
    '        specifier: 1.0.0',
    '        version: 1.0.0(peer-tool@2.0.0)',
    '      needs-peer:',
    '        specifier: 1.0.0',
    '        version: 1.0.0(zod@3.0.0)',
    '    optionalDependencies:',
    '      core-linux-x64-musl:',
    '        specifier: 1.0.0',
    '        version: 1.0.0',
    '      core-win32-x64:',
    '        specifier: 1.0.0',
    '        version: 1.0.0',
    '    devDependencies:',
    '      peer-tool:',
    '        specifier: 2.0.0',
    '        version: 2.0.0',
    'packages:',
    '  app-lib@1.0.0:',
    '    resolution: {integrity: sha512-a}',
    '    peerDependencies:',
    "      peer-tool: '*'",
    '    peerDependenciesMeta:',
    '      peer-tool:',
    '        optional: true',
    '  needs-peer@1.0.0:',
    '    resolution: {integrity: sha512-b}',
    '    peerDependencies:',
    "      zod: '^3.0.0'",
    '  zod@3.0.0:',
    '    resolution: {integrity: sha512-c}',
    '  peer-tool@2.0.0:',
    '    resolution: {integrity: sha512-d}',
    '  core-linux-x64-musl@1.0.0:',
    '    resolution: {integrity: sha512-e}',
    '    cpu: [x64]',
    '    os: [linux]',
    '    libc: [musl]',
    '  core-win32-x64@1.0.0:',
    '    resolution: {integrity: sha512-f}',
    '    cpu: [x64]',
    '    os: [win32]',
    'snapshots:',
    '  app-lib@1.0.0(peer-tool@2.0.0):',
    '    optionalDependencies:',
    '      peer-tool: 2.0.0',
    '  needs-peer@1.0.0(zod@3.0.0):',
    '    dependencies:',
    '      zod: 3.0.0',
    '  zod@3.0.0: {}',
    '  peer-tool@2.0.0: {}',
    '  core-linux-x64-musl@1.0.0:',
    '    optional: true',
    '  core-win32-x64@1.0.0:',
    '    optional: true',
    ''
  ].join('\n')
)
const peerBom = (pairs) => ({
  bomFormat: 'CycloneDX',
  specVersion: '1.7',
  metadata: {
    component: { type: 'application', name: 'fixture-app', version: '1.2.3', 'bom-ref': root }
  },
  components: pairs.map(([n, v]) => component(n, v)),
  dependencies: [{ ref: root, dependsOn: pairs.map(([n, v]) => ref(n, v)) }]
})

describe('what the SBOM generator may leave out or add (20 §2.4; run 38939771861)', () => {
  it('[NFR-COMP-07] a platform package no artifact ships may be missing from the SBOM, and is listed; one an artifact ships may not', () => {
    const shipped = [
      ['app-lib', '1.0.0'],
      ['needs-peer', '1.0.0'],
      ['zod', '3.0.0'],
      ['core-win32-x64', '1.0.0']
    ]
    expect(checkSbomMatchesLockfile(peerBom(shipped), PEER_LOCK)).toEqual([])
    expect(sbomDifferences(peerBom(shipped), PEER_LOCK)).toEqual([
      'core-linux-x64-musl@1.0.0: not in the SBOM and not shipped by any artifact (not installed on this runner)'
    ])
    expect(checkSbomMatchesLockfile(peerBom(shipped.slice(0, 3)), PEER_LOCK)).toEqual([
      'the SBOM is missing core-win32-x64@1.0.0, a production package of the lockfile'
    ])
  })

  it('[NFR-COMP-07] an optional peer resolved only by a dev dependency is not shipped: either generator answer passes, it is listed, and no OS SBOM keeps it', () => {
    const shipped = [
      ['app-lib', '1.0.0'],
      ['needs-peer', '1.0.0'],
      ['zod', '3.0.0'],
      ['core-win32-x64', '1.0.0'],
      ['core-linux-x64-musl', '1.0.0']
    ]
    const withPeer = peerBom([...shipped, ['peer-tool', '2.0.0']])
    expect(checkSbomMatchesLockfile(peerBom(shipped), PEER_LOCK)).toEqual([])
    expect(checkSbomMatchesLockfile(withPeer, PEER_LOCK)).toEqual([])
    expect(sbomDifferences(withPeer, PEER_LOCK)).toEqual([
      'peer-tool@2.0.0: in the SBOM, but only an optional peer of a production package, so no artifact ships it'
    ])
    for (const os of ARTIFACT_OSES) {
      expect(names(sbomForArtifact(withPeer, PEER_LOCK, os))).not.toContain('peer-tool')
    }
  })
})
