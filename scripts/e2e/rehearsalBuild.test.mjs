import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '../../src/contracts/host-protocol/protocolVersion.ts'
import {
  PROTOCOL_VERSION_MODULE,
  REHEARSAL_PLUGIN_NAME,
  REPO_ROOT,
  nextPatchVersion,
  rehearsalBuildPlugin
} from './rehearsalBuild.mjs'

/**
 * scripts/e2e/rehearsalBuild.mjs (ISSUE-057; 21 §2.1 item 1; ADR-002 D8): the electron-vite plugin that makes the
 * cut-0 rollback rehearsal's second build, a build of this tree with a higher app version and another
 * `protocolVersion`, written into its own folder. It is passed inline by `build-rehearsal-app.mjs` only, so the
 * release build never runs it and keeps the real PROTOCOL_VERSION.
 */

const OUT_ROOT = path.join(REPO_ROOT, 'test-results', 'rehearsal-build-test')

function hook(plugin, name) {
  const entry = plugin[name]
  return typeof entry === 'function' ? entry : entry.handler
}

function plugin(overrides = {}) {
  return rehearsalBuildPlugin({
    outRoot: OUT_ROOT,
    protocolVersion: PROTOCOL_VERSION + 1,
    appVersion: '9.9.9',
    ...overrides
  })
}

describe('the rollback rehearsal build (ISSUE-057)', () => {
  it('[ADR-002] the rehearsal build replaces only the contracts protocolVersion module, with its own protocol version', () => {
    const load = hook(plugin(), 'load')
    // Vite hands ids with forward slashes, on Windows too.
    const asVite = PROTOCOL_VERSION_MODULE.split(path.sep).join('/')
    expect(load(asVite)).toBe(`export const PROTOCOL_VERSION = ${PROTOCOL_VERSION + 1}\n`)
    expect(load(PROTOCOL_VERSION_MODULE)).toBe(
      `export const PROTOCOL_VERSION = ${PROTOCOL_VERSION + 1}\n`
    )
    expect(load(path.join(REPO_ROOT, 'src', 'contracts', 'index.ts'))).toBeNull()
    expect(load(path.join(REPO_ROOT, 'src', 'host', 'main.ts'))).toBeNull()
  })

  it('[ADR-002] the rehearsal build writes every target under its own out folder, never into the repository out/', () => {
    const config = hook(plugin(), 'config')
    // The app's main target names a relative folder; electron-vite's renderer preset an absolute one.
    expect(config({ build: { outDir: 'out/ui-main' } })).toEqual({
      build: { outDir: path.join(OUT_ROOT, 'out', 'ui-main') }
    })
    expect(
      config({ root: './src/renderer', build: { outDir: path.join(REPO_ROOT, 'out', 'renderer') } })
    ).toEqual({ build: { outDir: path.join(OUT_ROOT, 'out', 'renderer') } })
    expect(() => config({ build: { outDir: 'dist/elsewhere' } })).toThrow(/outside out/)
  })

  it('[ADR-002] the rehearsal build stamps its own app version where the config stamps one', () => {
    const config = hook(plugin(), 'config')
    const host = config({
      define: { __DWARFAI_APP_VERSION__: '"0.0.1"', __DWARFAI_BUILD_ID__: '"abc"' },
      build: { outDir: 'out/host' }
    })
    expect(host.define).toEqual({ __DWARFAI_APP_VERSION__: '"9.9.9"' })
    expect(config({ build: { outDir: 'out/ui-main' } })).not.toHaveProperty('define')
  })

  it('[ADR-002] the rollback build version is one patch above the faulty build', () => {
    expect(nextPatchVersion('0.13.1')).toBe('0.13.2')
    expect(nextPatchVersion('1.0.9')).toBe('1.0.10')
    expect(() => nextPatchVersion('1.0')).toThrow(/version/)
  })

  it('[ADR-002] the release build keeps the real PROTOCOL_VERSION: no build config or package script reaches the rehearsal override', () => {
    const configs = [
      'electron.vite.config.ts',
      'electron.vite.host.config.ts',
      'electron.vite.jevMcpServer.config.ts'
    ]
    for (const file of configs) {
      const source = readFileSync(path.join(REPO_ROOT, file), 'utf8')
      expect(source, file).not.toMatch(/rehearsal|scripts\/e2e/i)
      expect(source, file).not.toContain(REHEARSAL_PLUGIN_NAME)
    }
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
    for (const [name, script] of Object.entries(pkg.scripts)) {
      expect(script, name).not.toMatch(/rehearsal|scripts\/e2e/i)
    }
    // The constant is a literal of the source, not a build-time hook a define could reach.
    expect(readFileSync(PROTOCOL_VERSION_MODULE, 'utf8')).toMatch(
      new RegExp(`^export const PROTOCOL_VERSION = ${PROTOCOL_VERSION}$`, 'm')
    )
  })
})
