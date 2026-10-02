import path from 'node:path'
import prettierConfig from 'eslint-config-prettier'
import pluginVue from 'eslint-plugin-vue'
import tseslint from 'typescript-eslint'
import { CATALOG_PROVIDER_IDS } from './src/contracts/catalog/ids.mjs' // R12: derived, never hand-kept
import { providerLiteralPattern } from './src/contracts/catalog/providerLiteral.mjs'

// ---- boundary rules (05 §5.3): ESLint is editor feedback, dependency-cruiser the source of truth ----
//
// In a flat config the later object's options for a rule replace the earlier ones, so every rule
// below is set by exactly one object per disjoint file set, built from the named groups. Every
// violation is an error (ADR-004 item 3). scripts/checks/eslint-print-config.test.mjs asserts the
// merged result per file set; lint-canaries/ (pnpm test:canaries) proves each rule fires.
//
// Deviations from 05 §5.3 (package detail gaps resolved in development for ISSUE-005):
// 1. R16 is the local rule `arch/legacy-only-through-bridge`, not the IMP.legacy group:
//    `no-restricted-imports` matches the import string, so `**/src/main/**` never matches the
//    relative specifiers new code would use (`../../main/…`), and a generic `../main/` pattern
//    would also hit folders that are not the legacy tree (the renderer's own `main.ts`). The rule
//    resolves each relative specifier against the importing file instead.
// 2. `@dwarfai/contracts` (the contracts alias, tsconfig `paths`) joins domainScope and appScope:
//    `**/contracts/**` never matches the bare alias.
// 3. Renderer test files (`*.test.ts`) keep electron and rendererScope but not `node:*` (they read
//    fixtures with node:fs/path/url, the ISSUE-004 R8-renderer-no-node ruling), and leave the
//    renderer syntax objects, as Host tests already leave theirs in 05 §5.3.
// 4. The found tree's renderer and preload, rebuilt in place by later cuts (21 §6), still break R12,
//    R13 and R16 in 29 places. Those are frozen in ESLint's bulk-suppressions file
//    (eslint-suppressions.json, applied by `eslint` from the repository root): a new violation, or
//    one more in a suppressed file, fails the lint, and a suppression that no longer occurs fails
//    it too, so the list only shrinks. scripts/checks/arch-exception-ratchet.test.mjs caps its
//    total and keeps it to src/renderer and src/preload.
// 5. ADR-019 item 1 "no `new BrowserWindow(` outside the factory" (ISSUE-046) is not in 05 §5.3's
//    table, and 05 §5.1 gives it no number of its own. It is tagged R19, the rule 05 §5.1 already
//    gives to ADR-019 (principle column "— (ADR-019)"), so it stays traceable (rule-principles) and
//    has its canary (lint-canaries/R19-browser-window). It is the `browserWindow` selector in every
//    syntax object of the new trees, the adapters included, except the factory file itself. The
//    legacy trees carry no boundary object, so the legacy window (src/main/shell/window.ts) keeps
//    its own until ISSUE-058 deletes it.
// 6. The Host's one native binary, the owner-only pipe helper of ADR-003 item 2 (ISSUE-022), is
//    loaded only in src/host/platform/endpoint/win-pipe. 05 §5.1 has no row for it; it follows R11's
//    containment pattern ("X only in Y", like `node:sqlite` only in host/platform/sqlite) and is
//    tagged R11. A binary is loaded with `process.dlopen` at run time, which no import rule sees, so
//    it is the `nativeLoad` selector in every syntax object except that folder's, and has its canary
//    (lint-canaries/R11-native-binding).
// 7. The UI's launch helper (ADR-002 D6 item 1: job breakaway from inside UI main, built from its
//    own source so the UI never loads the Host's binary, R10) is the second native load site:
//    src/ui-main/hostLauncher/win-launch. The same R11 pattern; that folder keeps every Host
//    launcher selector except `nativeLoad`, and the rest of the Host launcher keeps `nativeLoad`
//    (canary lint-canaries/R11-native-binding-launcher).
// 8. ADR-026 Verification and 17 §1.7 "Misc static": `console.*` only in the logger. 05 §5.1 gives it
//    no R number, so it is ESLint's own `no-console`, one object of its own (it sets no other rule),
//    owned by ADR-026 and proved by lint-canaries/ADR-026-no-console. It covers the four new trees,
//    tests excluded (a test may print from a child program it runs). Neither logger writes to the
//    console (each writes its segments), so no file of those trees is exempt; the legacy trees
//    (src/main, src/shared) and the found renderer keep their calls until their cuts replace them.

// ---- import groups (no-restricted-imports) ----
const IMP = {
  electron: {
    group: ['electron'],
    message: 'R7 (P2): electron only in src/ui-main and src/preload.'
  },
  nodeBuiltins: {
    group: ['node:*', 'fs', 'path', 'child_process', 'os', 'crypto'],
    message: 'R1 (P1): domain is pure; pass values in.'
  },
  sdks: {
    group: [
      'zod',
      '@anthropic-ai/*',
      '@typesafe-ai/*',
      '@modelcontextprotocol/*',
      '@agentclientprotocol/*',
      '@napi-rs/keyring'
    ],
    message: 'R1/R3 (P1, P3): no frameworks or SDKs here.'
  },
  domainScope: {
    group: ['**/adapters/**', '**/application/**', '**/contracts/**', '@dwarfai/contracts'],
    message: 'R1 (P1): domain imports only its own domain and kernel/domain.'
  },
  appIo: { group: ['node:*'], message: 'R3 (P3): application orchestrates ports; no I/O.' },
  appScope: {
    group: ['**/adapters/**', '**/host/platform/**', '**/contracts/**', '@dwarfai/contracts'],
    message: 'R3 (P3): use ports, not adapters.'
  },
  deepModule: {
    group: [
      '../../*/domain/**',
      '../../*/application/**',
      '../../*/ports/**',
      '../../*/adapters/**'
    ],
    message: 'R4 (P3): another module only via its index.ts.'
  },
  rendererScope: {
    group: [
      '**/host/**',
      '**/ui-main/**',
      '**/preload/**',
      '**/legacy-bridge/**',
      '**/contracts/logging/**'
    ],
    message: 'R8 (P6): the renderer talks only through window.api and imports only contracts.'
  },
  rendererNode: {
    group: ['node:*'],
    message: 'R8 (P6): the renderer talks only through window.api and imports only contracts.'
  }
}
const imports = (...groups) => ({ 'no-restricted-imports': ['error', { patterns: groups }] })

// ---- syntax selectors (no-restricted-syntax), built per catalog so R12 follows it ----
const R12_MESSAGE = 'R12 (P9): branch on ProviderCapabilities, never on a provider id.'
const R19_DATA = 'R19 (ADR-019 D4): provider text stays data.'

/** @param {ReadonlyArray<string>} providerIds */
function syntaxSelectors(providerIds) {
  const providerLiteral = providerLiteralPattern(providerIds)
  return {
    providerIdCompare: {
      selector: `BinaryExpression[operator=/^[!=]==$/] > Literal[value=${providerLiteral}]`,
      message: R12_MESSAGE
    },
    providerIdCase: {
      selector: `SwitchCase > Literal[value=${providerLiteral}]`,
      message: R12_MESSAGE
    },
    windowApi: {
      selector: "MemberExpression[object.name='window'][property.name='api']",
      message: 'R13 (P6): window.api only in composables, App.vue and main.ts.'
    },
    innerHtml: {
      selector: 'AssignmentExpression > MemberExpression[property.name=/^(innerHTML|outerHTML)$/]',
      message: R19_DATA
    },
    insertHtml: {
      selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
      message: R19_DATA
    },
    newFunction: {
      selector: "NewExpression[callee.name='Function']",
      message: 'R19 (ADR-019 D4): no code from strings.'
    },
    shellTrue: {
      selector: "Property[key.name='shell'][value.value=true]",
      message: 'R17 (P7): shell: true is forbidden.'
    },
    browserWindow: {
      selector:
        "NewExpression[callee.name='BrowserWindow'], NewExpression[callee.property.name='BrowserWindow']",
      message: 'R19 (ADR-019 D1): build every BrowserWindow through secureWindowOptions.'
    },
    nativeLoad: {
      selector: "MemberExpression[object.name='process'][property.name='dlopen']",
      message:
        'R11 (P11): a native binary is loaded only in host/platform/endpoint/win-pipe and ui-main/hostLauncher/win-launch.'
    },
    osBranch: {
      selector:
        "MemberExpression[object.name='process'][property.name='platform'], CallExpression[callee.object.name='os'][callee.property.name='platform']",
      message:
        'R18 (P8): OS branching only in platform/module/UI adapters and the UI Host launcher.'
    }
  }
}
const syntax = (...sels) => ({ 'no-restricted-syntax': ['error', ...sels] })

// ---- R16: only src/legacy-bridge reaches the legacy trees (deviation 1) ----
const NEW_TREE = /^(.*?)[\\/]src[\\/](?:host|contracts|renderer|ui-main|preload)[\\/]/
const LEGACY_TREE = /^src\/(?:main|shared)(?:\/|$)/

/** @type {import('eslint').Rule.RuleModule} */
const legacyOnlyThroughBridge = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'R16 (05 §5.1): new code reaches src/main and src/shared only through src/legacy-bridge'
    },
    schema: [],
    messages: { legacy: 'R16 (P12): reach legacy code only through src/legacy-bridge.' }
  },
  create(context) {
    const root = NEW_TREE.exec(context.filename)?.[1]
    if (root === undefined) return {}
    const check = (source) => {
      if (source?.type !== 'Literal' || typeof source.value !== 'string') return
      if (!source.value.startsWith('.')) return // legacy code has no package name or alias
      const target = path.resolve(path.dirname(context.filename), source.value)
      const fromRoot = path.relative(root, target).split(path.sep).join('/')
      if (LEGACY_TREE.test(fromRoot)) context.report({ node: source, messageId: 'legacy' })
    }
    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source)
    }
  }
}
const archPlugin = { rules: { 'legacy-only-through-bridge': legacyOnlyThroughBridge } }

// ---- disjoint file sets ----
const ADAPTERS = [
  'src/host/modules/*/adapters/**',
  'src/host/platform/**',
  'src/ui-main/**/adapters/**',
  'src/contracts/catalog/**'
]
const RENDERER_VIEWS = [
  'src/renderer/src/lib/**/*.{ts,vue}',
  'src/renderer/src/components/**/*.{ts,vue}'
]
const WINDOW_FACTORY = 'src/ui-main/window/adapters/secureWindowOptions.ts' // the one `new BrowserWindow(` (ADR-019 item 1)
const NATIVE_LOADER = 'src/host/platform/endpoint/win-pipe/**' // the one `process.dlopen` (deviation 6)
const HOST_LAUNCHER = ['src/ui-main/hostLauncher/**'] // not an adapter: may branch on the OS (R18), never on a provider id (R12)
const LAUNCH_HELPER_LOADER = 'src/ui-main/hostLauncher/win-launch/**' // the UI's one `process.dlopen` (deviation 7)
const GOLDEN = 'src/renderer/src/golden/**'
const TESTS = '**/*.test.ts'

/**
 * The boundary objects of 05 §5.3 for a catalog, so a test can prove that a new catalog id is
 * covered by R12 (17 §1.7, HO-14).
 *
 * @param {ReadonlyArray<string>} providerIds
 */
export function createBoundaryConfigs(providerIds) {
  const S = syntaxSelectors(providerIds)
  const COMMON = [
    S.providerIdCompare,
    S.providerIdCase,
    S.shellTrue,
    S.osBranch,
    S.browserWindow,
    S.nativeLoad
  ]
  return [
    // imports: one object per disjoint file set
    {
      files: ['src/host/modules/*/domain/**/*.ts'],
      rules: imports(IMP.nodeBuiltins, IMP.electron, IMP.sdks, IMP.domainScope)
    },
    {
      files: ['src/host/modules/*/ports/**/*.ts'],
      rules: {
        ...imports(IMP.nodeBuiltins, IMP.electron, IMP.sdks, IMP.deepModule),
        '@typescript-eslint/consistent-type-imports': [
          'error',
          { prefer: 'type-imports', disallowTypeAnnotations: false }
        ]
      }
    },
    {
      files: ['src/host/modules/*/application/**/*.ts'],
      rules: imports(IMP.appIo, IMP.electron, IMP.sdks, IMP.appScope, IMP.deepModule)
    },
    {
      files: ['src/host/**/*.ts', 'src/contracts/**/*.ts'],
      ignores: [
        'src/host/modules/*/domain/**',
        'src/host/modules/*/ports/**',
        'src/host/modules/*/application/**'
      ],
      rules: imports(IMP.electron)
    },
    {
      files: ['src/renderer/**/*.{ts,vue}'],
      ignores: [TESTS],
      rules: imports(IMP.electron, IMP.rendererScope, IMP.rendererNode)
    },
    { files: [`src/renderer/${TESTS}`], rules: imports(IMP.electron, IMP.rendererScope) },

    // R16: one object, the only one that sets the rule
    {
      files: ['src/{host,contracts,renderer,ui-main,preload}/**/*.{ts,vue}'],
      plugins: { arch: archPlugin },
      rules: { 'arch/legacy-only-through-bridge': 'error' }
    },

    // syntax: one object per disjoint file set; each lists every selector that applies to it
    {
      files: RENDERER_VIEWS,
      ignores: [GOLDEN, TESTS],
      rules: syntax(...COMMON, S.windowApi, S.innerHtml, S.insertHtml, S.newFunction)
    },
    {
      files: ['src/renderer/src/**/*.{ts,vue}'],
      ignores: [...RENDERER_VIEWS, GOLDEN, TESTS],
      rules: syntax(...COMMON, S.innerHtml, S.insertHtml, S.newFunction)
    },
    {
      files: ['src/{host,ui-main,preload,contracts}/**/*.{ts,vue}'],
      ignores: [...ADAPTERS, ...HOST_LAUNCHER, TESTS],
      rules: syntax(...COMMON)
    },
    {
      files: HOST_LAUNCHER,
      ignores: [TESTS, LAUNCH_HELPER_LOADER],
      rules: syntax(
        S.providerIdCompare,
        S.providerIdCase,
        S.shellTrue,
        S.browserWindow,
        S.nativeLoad
      ) // R18 exempt only
    },
    {
      files: [LAUNCH_HELPER_LOADER],
      ignores: [TESTS],
      rules: syntax(S.providerIdCompare, S.providerIdCase, S.shellTrue, S.browserWindow) // R18, R11 exempt
    },
    // adapters may name providers and OSes; only the factory builds a BrowserWindow, and only the
    // owner-only pipe helper's folder loads a native binary
    {
      files: ADAPTERS,
      ignores: [TESTS, WINDOW_FACTORY, NATIVE_LOADER],
      rules: syntax(S.shellTrue, S.browserWindow, S.nativeLoad)
    },
    { files: [WINDOW_FACTORY], rules: syntax(S.shellTrue, S.nativeLoad) },
    { files: [NATIVE_LOADER], ignores: [TESTS], rules: syntax(S.shellTrue, S.browserWindow) },

    {
      files: ['src/renderer/src/**/*.vue'],
      ignores: [GOLDEN],
      rules: { 'vue/no-v-html': 'error' }
    },

    // ADR-026: console.* only in the logger (deviation 8)
    {
      files: ['src/{host,ui-main,contracts,legacy-bridge}/**/*.{ts,mts,cts}'],
      ignores: [TESTS],
      rules: { 'no-console': 'error' }
    }
  ]
}

export const boundaryConfigs = createBoundaryConfigs(CATALOG_PROVIDER_IDS)

/**
 * The whole flat config for a catalog: today's base config with the boundary objects appended.
 *
 * @param {ReadonlyArray<string>} providerIds
 */
export function createConfig(providerIds) {
  return tseslint.config(
    // lint-canaries/ holds deliberate violations: only the canary job (pnpm test:canaries) lints
    // them, inside a scratch tree; the lint of the real tree never does.
    { ignores: ['out/**', 'dist/**', 'node_modules/**', '.design/**', 'lint-canaries/**'] },
    tseslint.configs.recommended,
    ...pluginVue.configs['flat/recommended'],
    {
      files: ['**/*.vue'],
      languageOptions: {
        parserOptions: {
          parser: tseslint.parser
        }
      }
    },
    {
      rules: {
        // A leading underscore is this codebase's existing convention for an
        // intentionally-unused parameter (e.g. IPC handlers' `_event`).
        '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
      }
    },
    prettierConfig,
    ...createBoundaryConfigs(providerIds)
  )
}

export default createConfig(CATALOG_PROVIDER_IDS)
