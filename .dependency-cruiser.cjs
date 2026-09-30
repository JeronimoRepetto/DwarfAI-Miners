// The dependency rules of record: 05 §5.1 (R1–R11, R14–R17) as configured in 05 §5.2, unchanged in
// rule names and semantics (ADR-004 item 3: every rule is an error, no warning level). The legacy
// exclude below may only shrink: scripts/checks/legacy-exclude.baseline.json is its ratchet (21 §1
// item 7, 17 §1.7 "Legacy window"), checked by scripts/checks/depcruise-rules.test.mjs.
//
// Deviations from 05 §5.2 (package detail gaps resolved in development, owner ruling for ISSUE-004):
// 1. options.preserveSymlinks: true — pnpm links node_modules/<pkg> into node_modules/.pnpm/, so without
//    it every `^node_modules/<pkg>` pattern (R9 zod, all R11 package rules) never matches.
// 2. R1-domain-pure: the test-file `pathNot` of R1-domain-no-builtins — domain tests beside their
//    aggregate (17 §1.1) import vitest and fakes (16 §2.8).
// 3. R8-renderer-no-node: the same test-file `pathNot` — renderer tests read files with node:fs/path/url;
//    production renderer code stays covered, and R8-renderer-isolated is unchanged.
// 4. R16-legacy-only-through-bridge is kept but cannot fire against excluded legacy targets (`exclude`
//    drops those dependencies, dependency-cruiser src/extract/extract-dependencies.mjs:180-181); the
//    ISSUE-005 canary suite proves R16 through ESLint's arch/legacy-only-through-bridge rule
//    (eslint.config.mjs, which replaces 05 §5.3's IMP.legacy group).
//
// Each rule's `comment` names the ADR-004 principle it enforces, or "05 local rule" (05 §5.1 column
// "ADR-004"); scripts/checks/rule-principles.test.mjs reads them (ADR-004 Verification).

/** @type {import('dependency-cruiser').IConfiguration} */
const M = '^src/host/modules/([^/]+)/'

// Allowed module→module edges (§1.3). Anything not listed is forbidden.
const EDGES = {
  observation: ['mines', 'suppliers'],
  mines: ['crew'],
  crew: ['suppliers'],
  launching: ['suppliers', 'mines', 'jev', 'crew'],
  conversation: ['suppliers', 'crew'],
  asking: ['suppliers', 'crew', 'conversation'],
  delegation: ['jev', 'launching', 'conversation', 'preferences'],
  jev: ['suppliers', 'preferences'],
  attention: ['preferences'],
  suppliers: [],
  ledger: [],
  preferences: [],
  diagnostics: []
}
const edgeRules = Object.entries(EDGES).map(([from, allowed]) => ({
  name: `R4-module-edge-${from}`,
  severity: 'error',
  comment: `${from} may import only ${allowed.join(', ') || 'no other module'} (05 §1.3; ADR-004 P3)`,
  from: { path: `^src/host/modules/${from}/` },
  to: {
    path: '^src/host/modules/[^/]+/index\\.ts$',
    pathNot: [`^src/host/modules/(${[from, ...allowed].join('|')})/index\\.ts$`]
  }
}))

module.exports = {
  forbidden: [
    {
      name: 'R1-domain-pure',
      comment: 'domain imports only its own domain and kernel/domain (05 R1; ADR-004 P1)',
      severity: 'error',
      from: {
        path: `${M}domain/`,
        pathNot: '\\.test\\.(ts|mjs)$|\\.contract\\.ts$|/testing/|/fakes/'
      },
      to: { pathNot: ['^src/host/modules/$1/domain/', '^src/host/kernel/domain/'] }
    },
    {
      name: 'R1-domain-no-builtins',
      comment: 'domain is pure: no Node, Electron or package imports (05 R1; ADR-004 P1)',
      severity: 'error', // electron is a built-in here (options below)
      from: {
        path: `${M}domain/`,
        pathNot: '\\.test\\.(ts|mjs)$|\\.contract\\.ts$|/testing/|/fakes/'
      },
      to: { dependencyTypes: ['core', 'npm', 'npm-dev', 'npm-optional', 'npm-peer'] }
    },
    {
      name: 'R2-ports-type-only',
      comment: 'ports are type-only (05 R2; ADR-004 P3)',
      severity: 'error',
      from: { path: `${M}ports/` },
      to: { dependencyTypesNot: ['type-only'] }
    },
    {
      name: 'R2-ports-targets',
      comment:
        'ports import their own domain and ports, the kernel and the index.ts of other modules (05 R2; ADR-004 P3)',
      severity: 'error', // other modules' index.ts allowed, narrowed by the R4 edges
      from: { path: `${M}ports/` },
      to: {
        pathNot: [
          '^src/host/modules/$1/(domain|ports)/',
          '^src/host/kernel/',
          '^src/host/modules/[^/]+/index\\.ts$'
        ]
      }
    },
    {
      name: 'R3-application-no-adapters',
      comment: 'application uses ports, never adapters, platform or contracts (05 R3; ADR-004 P3)',
      severity: 'error',
      from: { path: `${M}application/` },
      to: { path: ['/adapters/', '^src/host/platform/', '^src/contracts/'] }
    },
    {
      name: 'R3-application-no-io',
      comment: 'application orchestrates ports and does no I/O (05 R3; ADR-004 P3)',
      severity: 'error',
      from: {
        path: `${M}application/`,
        pathNot: '\\.test\\.(ts|mjs)$|\\.contract\\.ts$|/testing/|/fakes/'
      },
      to: { dependencyTypes: ['core', 'npm'] }
    },
    {
      name: 'R4-cross-module-only-index',
      comment: 'another module only through its index.ts (05 R4; ADR-004 P3)',
      severity: 'error',
      from: { path: M },
      to: {
        path: '^src/host/modules/([^/]+)/',
        pathNot: ['^src/host/modules/$1/', '^src/host/modules/[^/]+/index\\.ts$']
      }
    },
    ...edgeRules,
    {
      name: 'R5-no-cycles',
      comment: 'the module graph is acyclic (05 R5; ADR-004 P10)',
      severity: 'error',
      from: { path: '^src/' },
      to: { circular: true }
    },
    // R6: cross-module adapter imports are already caught by R4; this catches transport/platform/kernel
    // reaching into any module's adapters. Same-module application→adapters is caught by R3.
    {
      name: 'R6-adapters-only-from-roots',
      comment: 'adapters are wired only by host/main.ts and host/wiring (05 R6; ADR-004 P4)',
      severity: 'error',
      from: {
        path: '^src/host/',
        pathNot: ['^src/host/modules/', '^src/host/main\\.ts$', '^src/host/wiring/']
      },
      to: { path: '^src/host/modules/[^/]+/adapters/' }
    },
    {
      name: 'R7-electron-only-ui-main',
      comment: 'electron only in src/ui-main and src/preload (05 R7; ADR-004 P2)',
      severity: 'error',
      from: { path: '^src/', pathNot: ['^src/ui-main/', '^src/preload/'] },
      to: { path: '^electron$', dependencyTypes: ['core'] }
    },
    {
      name: 'R8-renderer-isolated',
      comment:
        'the renderer imports only the renderer and contracts, never contracts/logging (05 R8; ADR-004 P6, P13)',
      severity: 'error',
      from: { path: '^src/renderer/' },
      to: { path: ['^src/(host|ui-main|preload|legacy-bridge)/', '^src/contracts/logging/'] }
    },
    {
      name: 'R8-renderer-no-node',
      comment: 'the renderer imports no Node API (05 R8; ADR-004 P6)',
      severity: 'error', // also catches electron (declared core)
      from: {
        path: '^src/renderer/',
        pathNot: '\\.test\\.(ts|mjs)$|\\.contract\\.ts$|/testing/|/fakes/'
      },
      to: { dependencyTypes: ['core'] }
    },
    {
      name: 'R9-contracts-self-contained',
      comment: 'contracts import only themselves and zod (05 R9; ADR-004 P5, P13)',
      severity: 'error',
      from: {
        path: '^src/contracts/',
        pathNot: '\\.test\\.(ts|mjs)$|\\.contract\\.ts$|/testing/|/fakes/'
      },
      to: { pathNot: ['^src/contracts/', '^node_modules/zod/'] }
    },
    {
      name: 'R9-core-no-contracts',
      comment: 'domain, application and ports never import contracts (05 R9; ADR-004 P5)',
      severity: 'error',
      from: { path: `${M}(domain|application|ports)/` },
      to: { path: '^src/contracts/' }
    },
    {
      name: 'R9-adapters-no-contracts',
      comment:
        'module adapters never import contracts, except diagnostics and the relay shim (05 R9; ADR-004 P5)',
      severity: 'error',
      from: {
        path: `${M}adapters/`,
        pathNot: '^src/host/modules/(diagnostics/adapters|delegation/adapters/mcp/relay)/'
      },
      to: { path: '^src/contracts/' }
    },
    {
      name: 'R9-diagnostics-only-logging',
      comment:
        'diagnostics adapters and the relay shim import only contracts/logging (05 R9; ADR-004 P5, P13)',
      severity: 'error',
      from: { path: '^src/host/modules/(diagnostics/adapters|delegation/adapters/mcp/relay)/' },
      to: { path: '^src/contracts/', pathNot: '^src/contracts/logging/' }
    },
    {
      name: 'R10-host-not-ui',
      comment: 'the Host never imports the UI trees (05 R10; ADR-004 P5)',
      severity: 'error',
      from: { path: '^src/host/' },
      to: { path: '^src/(ui-main|preload|renderer)/' }
    },
    {
      name: 'R10-ui-not-host',
      comment: 'the UI trees never import the Host (05 R10; ADR-004 P5)',
      severity: 'error',
      from: { path: '^src/(ui-main|preload|renderer)/' },
      to: { path: '^src/host/' }
    },
    {
      name: 'R11-no-claude-agent-sdk',
      comment: 'the Claude Agent SDK is nowhere in the rebuild (05 R11; ADR-004 P11)',
      severity: 'error', // AMENDMENT-2 (OQ-52): not a dependency of the rebuild
      from: { path: '^src/(host|ui-main|preload|renderer)/' },
      to: { path: '^node_modules/@anthropic-ai/claude-agent-sdk' }
    },
    {
      name: 'R11-acp-sdk-containment',
      comment: 'the ACP SDK only in the ACP drivers (05 R11; ADR-004 P11)',
      severity: 'error',
      from: { pathNot: '^src/host/modules/suppliers/adapters/drivers/acp[^/]*/' },
      to: { path: '^node_modules/@agentclientprotocol/' }
    },
    {
      name: 'R11-typesafe-sdk-containment',
      comment: 'the TypeSafe SDK only in jev/adapters/typesafe (05 R11; ADR-004 P11)',
      severity: 'error',
      from: { pathNot: '^src/host/modules/jev/adapters/typesafe/' },
      to: { path: '^node_modules/@typesafe-ai/' }
    },
    {
      name: 'R11-mcp-sdk-containment',
      comment: 'the MCP SDK only in delegation/adapters/mcp (05 R11; ADR-004 P11)',
      severity: 'error',
      from: { pathNot: '^src/host/modules/delegation/adapters/mcp/' },
      to: { path: '^node_modules/@modelcontextprotocol/' }
    },
    {
      name: 'R11-keyring-containment',
      comment:
        'the keyring library only in preferences/adapters/secret-store (05 R11; ADR-004 P11)',
      severity: 'error', // candidate library, gated by ADR-017's spike
      from: { pathNot: '^src/host/modules/preferences/adapters/secret-store/' },
      to: { path: '^node_modules/@napi-rs/keyring' }
    },
    {
      name: 'R11-sqlite-containment',
      comment: 'node:sqlite only in host/platform/sqlite (05 R11, a 05 local rule)',
      severity: 'error',
      from: { pathNot: '^src/host/platform/sqlite/' },
      to: { path: '^(node:)?sqlite$', dependencyTypes: ['core'] }
    },
    {
      name: 'R11-kimi-sdk-containment',
      comment: 'the Kimi SDK only in the kimi-sdk driver (05 R11; ADR-004 P11)',
      severity: 'error', // 15 §4.9, gated by SP-07; revised 2026-09-30
      from: { pathNot: '^src/host/modules/suppliers/adapters/drivers/kimi-sdk/' },
      to: { path: '^node_modules/@moonshot-ai/kimi-agent-sdk' }
    },
    {
      name: 'R14-no-test-code-in-prod',
      comment: 'production code never imports test code or fakes (05 R14, a 05 local rule)',
      severity: 'error',
      from: { pathNot: '\\.test\\.ts$|/testing/|/fakes/' },
      to: { path: '\\.test\\.ts$|/testing/|/fakes/' }
    },
    {
      name: 'R15-wiring-uses-index',
      comment: 'wiring and transport reach a module only through its index.ts (05 R15; ADR-004 P3)',
      severity: 'error',
      from: { path: '^src/host/(wiring|transport)/' },
      to: { path: `${M}(domain|application|ports)/` }
    },
    {
      name: 'R16-legacy-only-through-bridge',
      comment: 'only src/legacy-bridge imports src/main or src/shared (05 R16; ADR-004 P12)',
      severity: 'error',
      from: { path: '^src/', pathNot: ['^src/legacy-bridge/', '^src/(main|shared)/'] },
      to: { path: '^src/(main|shared)/' }
    },
    {
      name: 'R16-bridge-only-from-roots',
      comment: 'only the composition roots import src/legacy-bridge (05 R16; ADR-004 P12)',
      severity: 'error',
      from: {
        path: '^src/',
        pathNot: ['^src/legacy-bridge/', '^src/host/main\\.ts$', '^src/ui-main/index\\.ts$']
      },
      to: { path: '^src/legacy-bridge/' }
    },
    {
      name: 'R17-spawn-containment',
      comment: 'node:child_process only in the three spawning paths (05 R17; ADR-004 P7)',
      severity: 'error',
      from: {
        path: '^src/',
        pathNot: [
          '^src/host/platform/process/',
          '^src/ui-main/hostLauncher/',
          '^src/ui-main/window/adapters/terminal/'
        ]
      },
      to: { path: '^(node:)?child_process$', dependencyTypes: ['core'] }
    }
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '^src/(main|shared)/' }, // legacy during the strangler; shrink per cut (ADR-001)
    builtInModules: { add: ['electron'] }, // so `electron` resolves to "electron" (core), not node_modules/…
    tsConfig: { fileName: 'tsconfig.node.json' },
    tsPreCompilationDeps: true, // so `import type` edges exist and carry 'type-only' (R2)
    preserveSymlinks: true, // pnpm links node_modules/<pkg> into .pnpm/: keep the link path so node_modules/<pkg>/ patterns match
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default']
    }
  }
}
