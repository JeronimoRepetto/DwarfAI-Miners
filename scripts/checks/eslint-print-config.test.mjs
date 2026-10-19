import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'
import { createConfig } from '../../eslint.config.mjs'
import { CATALOG_PROVIDER_IDS } from '../../src/contracts/catalog/ids.mjs'

/**
 * L7 flat-config test (05 §5.3, 17 §1.7).
 *
 * In a flat config the later object's options for a rule replace the earlier ones, so two
 * overlapping objects setting `no-restricted-imports` or `no-restricted-syntax` silently drop
 * rules. This test resolves the merged config for one sample path per disjoint file set, exactly
 * what `eslint --print-config <path>` prints (`ESLint#calculateConfigForFile`), and asserts the
 * exact import groups and syntax selectors each set must carry. The expectations are written out
 * here from 05 §5.3, independently of the config's own constants.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')

const eslint = new ESLint({ cwd: repoRoot })

// ---- 05 §5.3 import groups, by the rule tag of their message ----
const GROUPS = {
  electron: ['electron'],
  nodeBuiltins: ['node:*', 'fs', 'path', 'child_process', 'os', 'crypto'],
  sdks: [
    'zod',
    '@anthropic-ai/*',
    '@typesafe-ai/*',
    '@modelcontextprotocol/*',
    '@agentclientprotocol/*',
    '@napi-rs/keyring'
  ],
  domainScope: ['**/adapters/**', '**/application/**', '**/contracts/**', '@dwarfai/contracts'],
  appIo: ['node:*'],
  appScope: ['**/adapters/**', '**/host/platform/**', '**/contracts/**', '@dwarfai/contracts'],
  deepModule: [
    '../../*/domain/**',
    '../../*/application/**',
    '../../*/ports/**',
    '../../*/adapters/**'
  ],
  rendererScope: [
    '**/host/**',
    '**/ui-main/**',
    '**/preload/**',
    '**/legacy-bridge/**',
    '**/contracts/logging/**'
  ],
  rendererNode: ['node:*']
}

// ---- 05 §5.3 syntax selectors, by a fragment only that selector has ----
const SELECTORS = {
  providerIdCompare: 'BinaryExpression[operator=/^[!=]==$/] > Literal[value=',
  providerIdCase: 'SwitchCase > Literal[value=',
  windowApi: "MemberExpression[object.name='window'][property.name='api']",
  innerHtml: 'AssignmentExpression > MemberExpression[property.name=/^(innerHTML|outerHTML)$/]',
  insertHtml: "CallExpression[callee.property.name='insertAdjacentHTML']",
  newFunction: "NewExpression[callee.name='Function']",
  shellTrue: "Property[key.name='shell'][value.value=true]",
  osBranch: "MemberExpression[object.name='process'][property.name='platform']",
  // ADR-019 item 1, ISSUE-046 (eslint.config.mjs deviation 5): not in 05 §5.3's table
  browserWindow: "NewExpression[callee.name='BrowserWindow']",
  // The owner-only pipe helper's binary, ISSUE-022 (eslint.config.mjs deviation 6): R11's pattern
  nativeLoad: "MemberExpression[object.name='process'][property.name='dlopen']"
}
// AMENDED for ISSUE-022 (was: without 'nativeLoad'): no process.dlopen outside the win-pipe folder.
const COMMON = [
  'providerIdCompare',
  'providerIdCase',
  'shellTrue',
  'osBranch',
  'browserWindow',
  'nativeLoad'
]
const LEGACY_RULE = 'arch/legacy-only-through-bridge'

async function configOf(file, engine = eslint) {
  return engine.calculateConfigForFile(path.join(repoRoot, ...file.split('/')))
}

/** The import groups a file carries, each as its sorted pattern list. */
function importGroups(config) {
  const entry = config.rules?.['no-restricted-imports']
  if (!Array.isArray(entry) || entry[0] !== 2) return []
  return entry[1].patterns.map((pattern) => [...pattern.group].sort()).sort()
}

function expectedGroups(names) {
  return names.map((name) => [...GROUPS[name]].sort()).sort()
}

/** The names of the 05 §5.3 selectors a file carries, in config order. */
function selectorNames(config) {
  const entry = config.rules?.['no-restricted-syntax']
  if (!Array.isArray(entry) || entry[0] !== 2) return []
  return entry.slice(1).map((option) => {
    const selector = typeof option === 'string' ? option : option.selector
    const name = Object.keys(SELECTORS).find((key) => selector.includes(SELECTORS[key]))
    return name ?? `unknown selector ${selector}`
  })
}

function severity(config, rule) {
  const entry = config.rules?.[rule]
  return Array.isArray(entry) ? entry[0] : (entry ?? 0)
}

describe('flat config (05 §5.3)', () => {
  it('[R1, R3] domain and application files carry their import groups', async () => {
    const domain = await configOf('src/host/modules/crew/domain/dwarf.ts')
    expect(importGroups(domain), 'domain import groups').toEqual(
      expectedGroups(['nodeBuiltins', 'electron', 'sdks', 'domainScope'])
    )
    const application = await configOf('src/host/modules/crew/application/endOwned.ts')
    expect(importGroups(application), 'application import groups').toEqual(
      expectedGroups(['appIo', 'electron', 'sdks', 'appScope', 'deepModule'])
    )
    expect(severity(domain, LEGACY_RULE), 'domain legacy rule').toBe(2)
    expect(severity(application, LEGACY_RULE), 'application legacy rule').toBe(2)
  })

  it('[R2, R7, R8, R16] ports, Host, contracts, renderer and UI files carry their import groups and the legacy rule', async () => {
    const ports = await configOf('src/host/modules/crew/ports/DwarfRepository.ts')
    expect(importGroups(ports), 'ports import groups').toEqual(
      expectedGroups(['nodeBuiltins', 'electron', 'sdks', 'deepModule'])
    )
    expect(ports.rules['@typescript-eslint/consistent-type-imports'], 'ports type imports').toEqual(
      [2, { prefer: 'type-imports', disallowTypeAnnotations: false }]
    )
    for (const file of ['src/host/kernel/clock.ts', 'src/contracts/wire/views.ts']) {
      expect(importGroups(await configOf(file)), `${file} import groups`).toEqual(
        expectedGroups(['electron'])
      )
    }
    for (const file of ['src/renderer/src/lib/panel.ts', 'src/renderer/src/components/Panel.vue']) {
      expect(importGroups(await configOf(file)), `${file} import groups`).toEqual(
        expectedGroups(['electron', 'rendererScope', 'rendererNode'])
      )
    }
    // Renderer tests read fixtures with node:fs/path/url (the ISSUE-004 R8-renderer-no-node ruling).
    expect(
      importGroups(await configOf('src/renderer/src/lib/panel.test.ts')),
      'renderer test import groups'
    ).toEqual(expectedGroups(['electron', 'rendererScope']))
    for (const file of ['src/ui-main/index.ts', 'src/preload/index.ts']) {
      expect(importGroups(await configOf(file)), `${file} import groups`).toEqual([])
    }

    const newTrees = [
      'src/host/modules/crew/ports/DwarfRepository.ts',
      'src/host/kernel/clock.ts',
      'src/contracts/wire/views.ts',
      'src/renderer/src/lib/panel.ts',
      'src/renderer/src/components/Panel.vue',
      'src/renderer/src/lib/panel.test.ts',
      'src/ui-main/index.ts',
      'src/preload/index.ts'
    ]
    for (const file of newTrees) {
      expect(severity(await configOf(file), LEGACY_RULE), `${file} legacy rule`).toBe(2)
    }
    for (const file of ['src/legacy-bridge/settings.ts', 'src/main/index.ts']) {
      expect(severity(await configOf(file), LEGACY_RULE), `${file} legacy rule`).toBe(0)
    }
  })

  it('[R12, R17, R18] common selectors are present in every non-adapter object and only shellTrue in adapters', async () => {
    const nonAdapters = {
      'src/host/modules/crew/domain/dwarf.ts': COMMON,
      'src/host/kernel/clock.ts': COMMON,
      'src/ui-main/index.ts': COMMON,
      'src/preload/index.ts': COMMON,
      'src/contracts/wire/views.ts': COMMON,
      'src/renderer/src/composables/usePanel.ts': [
        ...COMMON,
        'innerHtml',
        'insertHtml',
        'newFunction'
      ],
      'src/renderer/src/lib/panel.ts': [
        ...COMMON,
        'windowApi',
        'innerHtml',
        'insertHtml',
        'newFunction'
      ],
      'src/ui-main/hostLauncher/spawnHost.ts': [
        'providerIdCompare',
        'providerIdCase',
        'shellTrue',
        'browserWindow',
        'nativeLoad'
      ]
    }
    for (const [file, expected] of Object.entries(nonAdapters)) {
      expect(selectorNames(await configOf(file)), `${file} selectors`).toEqual(expected)
    }
    const adapters = [
      'src/host/modules/crew/adapters/repository.ts',
      'src/host/platform/process/killTree.ts',
      'src/ui-main/window/adapters/tray.ts',
      'src/contracts/catalog/ids.ts'
    ]
    for (const file of adapters) {
      // AMENDED for ISSUE-046 (was: `['shellTrue']`): adapters build no BrowserWindow either (ADR-019 item 1).
      // AMENDED for ISSUE-022 (was: without 'nativeLoad'): nor load a native binary (R11).
      expect(selectorNames(await configOf(file)), `${file} selectors`).toEqual([
        'shellTrue',
        'browserWindow',
        'nativeLoad'
      ])
    }
  })

  it('[ADR-019] only the window factory file may build a BrowserWindow', async () => {
    expect(
      selectorNames(await configOf('src/ui-main/window/adapters/secureWindowOptions.ts')),
      'the factory selectors'
      // AMENDED for ISSUE-022 (was: `['shellTrue']` and `['shellTrue', 'browserWindow']`): nativeLoad.
    ).toEqual(['shellTrue', 'nativeLoad'])
    expect(
      selectorNames(await configOf('src/ui-main/window/adapters/ElectronWindows.ts')),
      'a sibling adapter selectors'
    ).toEqual(['shellTrue', 'browserWindow', 'nativeLoad'])
  })

  it('[R11] only the owner-only pipe helper folder may load a native binary (process.dlopen)', async () => {
    expect(
      selectorNames(await configOf('src/host/platform/endpoint/win-pipe/nativeOwnerOnlyPipe.ts')),
      'the helper folder selectors'
    ).toEqual(['shellTrue', 'browserWindow'])
    expect(
      selectorNames(await configOf('src/host/platform/endpoint/nodeEndpointEnv.ts')),
      'a sibling platform adapter selectors'
    ).toEqual(['shellTrue', 'browserWindow', 'nativeLoad'])
  })

  // ADDED (fix: Windows Host launch timeout; eslint.config.mjs deviation 7): the UI's launch helper
  // is the second load site. Its folder keeps every Host launcher selector except nativeLoad; the
  // rest of the Host launcher still may not load a binary.
  it('[R11] only the UI launch helper folder of the Host launcher may load its native binary (process.dlopen)', async () => {
    expect(
      selectorNames(await configOf('src/ui-main/hostLauncher/win-launch/nativeWinLaunch.ts')),
      'the launch helper folder selectors'
    ).toEqual(['providerIdCompare', 'providerIdCase', 'shellTrue', 'browserWindow'])
    expect(
      selectorNames(await configOf('src/ui-main/hostLauncher/windows.ts')),
      'a sibling Host launcher file selectors'
    ).toEqual(['providerIdCompare', 'providerIdCase', 'shellTrue', 'browserWindow', 'nativeLoad'])
  })

  it('[R13, R19] renderer views carry windowApi, innerHtml, insertHtml and newFunction; golden/** is ignored', async () => {
    const views = ['src/renderer/src/components/Panel.vue', 'src/renderer/src/lib/panel.ts']
    for (const file of views) {
      expect(selectorNames(await configOf(file)), `${file} selectors`).toEqual([
        ...COMMON,
        'windowApi',
        'innerHtml',
        'insertHtml',
        'newFunction'
      ])
    }
    for (const file of ['src/renderer/src/components/Panel.vue', 'src/renderer/src/App.vue']) {
      expect(severity(await configOf(file), 'vue/no-v-html'), `${file} vue/no-v-html`).toBe(2)
    }
    const golden = await configOf('src/renderer/src/golden/renders.ts')
    expect(selectorNames(golden), 'golden selectors').toEqual([])
    const goldenVue = await configOf('src/renderer/src/golden/Specimen.vue')
    expect(severity(goldenVue, 'vue/no-v-html'), 'golden vue/no-v-html').not.toBe(2)
  })

  it('[R12] a synthetic catalog id added to CATALOG_PROVIDER_IDS is covered by the providerIdCompare selector', async () => {
    const synthetic = 'synthetic-provider'
    const withSynthetic = new ESLint({
      cwd: repoRoot,
      overrideConfigFile: true,
      overrideConfig: createConfig([...CATALOG_PROVIDER_IDS, synthetic])
    })
    const domainFile = 'src/host/modules/crew/domain/dwarf.ts'
    const syntaxRule = (await configOf(domainFile, withSynthetic)).rules['no-restricted-syntax']
    const compare = (syntaxRule ?? [])
      .slice(1)
      .find((option) => option.selector.includes(SELECTORS.providerIdCompare))
    expect(compare?.selector ?? '', 'providerIdCompare selector').toContain('synthetic\\-provider')

    const code = `export const isSynthetic = (id: string): boolean => id === '${synthetic}'\n`
    const lint = async (engine, filePath) =>
      (await engine.lintText(code, { filePath: path.join(repoRoot, ...filePath.split('/')) }))
        .flatMap((result) => result.messages)
        .filter((message) => message.ruleId === 'no-restricted-syntax')
        .map((message) => message.message)
    expect(await lint(withSynthetic, domainFile), 'synthetic id in a domain').toEqual([
      'R12 (P9): branch on ProviderCapabilities, never on a provider id.'
    ])
    expect(
      await lint(withSynthetic, 'src/host/modules/crew/adapters/repository.ts'),
      'synthetic id in an adapter'
    ).toEqual([])
    expect(await lint(eslint, domainFile), 'synthetic id with the real catalog').toEqual([])
  })

  // ADDED (cut-0 conformance, ADR-026 Verification; 17 §1.7 "Misc static"): console.* only in the
  // logger. The new trees carry no console call at all (the logger writes segments, never the
  // console); the legacy trees and tests keep theirs.
  it('[ADR-026] no-console is an error in src/host, src/ui-main, src/contracts and src/legacy-bridge, and off elsewhere', async () => {
    const newTrees = [
      'src/host/kernel/clock.ts',
      'src/host/modules/diagnostics/adapters/HostDiagnosticsLog.ts',
      'src/ui-main/index.ts',
      'src/ui-main/diagnostics/uiLogger.ts',
      'src/contracts/wire/views.ts',
      'src/legacy-bridge/LegacyRuntimeRoute.ts'
    ]
    for (const file of newTrees) {
      expect(severity(await configOf(file), 'no-console'), `${file} no-console`).toBe(2)
    }
    const elsewhere = [
      'src/main/index.ts',
      'src/renderer/src/lib/panel.ts',
      'src/ui-main/index.test.ts',
      'src/host/wiring/flows/boot.test.ts'
    ]
    for (const file of elsewhere) {
      expect(severity(await configOf(file), 'no-console'), `${file} no-console`).toBe(0)
    }
  })

  it('[ADR-004] lint-canaries/** is ignored by the lint of the real tree', async () => {
    const canary = 'lint-canaries/R1/src/host/modules/crew/domain/__canary__/importsFs.ts'
    expect(await eslint.isPathIgnored(path.join(repoRoot, ...canary.split('/')))).toBe(true)
  })
})
