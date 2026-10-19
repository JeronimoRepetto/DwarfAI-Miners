// The dependency rules of record: 05 §5.1 (R1–R11, R14–R17) as configured in 05 §5.2, unchanged in
// rule names and semantics (ADR-004 item 3: every rule is an error, no warning level). The legacy
// exclude only shrank, cut by cut, and is gone since cut 5 (ISSUE-248): scripts/checks/legacy-exclude.baseline.json,
// its ratchet (21 §1 item 7, 17 §1.7 "Legacy window"), is empty, so every rule covers all of src/; checked by
// scripts/checks/depcruise-rules.test.mjs.
//
// Deviations from 05 §5.2 (package detail gaps resolved in development, owner ruling for ISSUE-004):
// 1. options.preserveSymlinks: true — pnpm links node_modules/<pkg> into node_modules/.pnpm/, so without
//    it every `^node_modules/<pkg>` pattern (R9 zod, all R11 package rules) never matches.
// 2. R1-domain-pure: the test-file `pathNot` of R1-domain-no-builtins — domain tests beside their
//    aggregate (17 §1.1) import vitest and fakes (16 §2.8).
// 3. R8-renderer-no-node: the same test-file `pathNot` — renderer tests read files with node:fs/path/url;
//    production renderer code stays covered, and R8-renderer-isolated is unchanged.
// 4. R16-legacy-only-through-bridge could not fire against excluded legacy targets while the legacy
//    `exclude` stood (it drops those dependencies, dependency-cruiser src/extract/extract-dependencies.mjs:180-181);
//    ISSUE-248 removed the exclude after cut 5, and the R16-runtime canary proves the rule fires on an import of
//    src/main/runtime/runtime.ts. The ISSUE-005 canary R16 proves ESLint's arch/legacy-only-through-bridge mirror.
// 5. R9 split, owner-approved 2026-10-15, ISSUE-200 (deviation from 05 §5.1 R9, which lets the relay
//    shim import contracts/logging only): the relay `host/modules/delegation/adapters/mcp/relay/**`
//    may also import `contracts/host-protocol/**` by relative path (the ADR-003 item 4 frame codec,
//    `McpHello`, the ADR-002 D2 endpoint rule), never the `@dwarfai/contracts` barrel; the diagnostics
//    adapters stay logging-only (R9-diagnostics-only-logging, R9-relay-only-logging-and-host-protocol).
// 6. R6-relay-entry-not-imported (ISSUE-200, security review of #1328): `relayMain.ts` is the relay
//    process's entry (built as out/host/dwarfai-mcp.js by electron.vite.relay.config.ts) and holds the credential; nothing imports it
//    but its own tests (`relay/*.test.ts`), not even the composition root. What the Host needs of
//    the relay (the entry file name, the variable name, the 15 §4 entry) lives in relayEntry.ts.
// 7. R9 split and R6-viewer-entry-not-imported, owner-approved 2026-10-17, ISSUE-170, on the relay's
//    precedent (deviations 5 and 6): the console viewer `host/modules/conversation/adapters/console/
//    viewer/**` (ADR-031 item 2, built as out/host/dwarfai-viewer.js by
//    electron.vite.viewer.config.ts) may import `contracts/logging/**` (its FM-040 `shim-` segment)
//    and `contracts/host-protocol/**` (the ADR-003 item 4 frame codec, the ADR-002 D2 endpoint rule)
//    by relative path, never the `@dwarfai/contracts` barrel (R9-viewer-only-logging-and-host-protocol);
//    and `viewerMain.ts` is the viewer process's entry, which reads the per-view token: nothing
//    imports it but its own tests (`viewer/*.test.ts`), not even the composition root. What the Host
//    needs of the viewer (the entry file name, the token file layout) lives in viewerEntry.ts and
//    viewerTokenFile.ts.
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
// Type-only module→module edges: the importer may name the target's types (`import type`) and
// nothing else, so a value import is still an R4 violation. Owner amendment N (AMENDMENT-14,
// OQ-85), addendum A14-07, 2026-10-15: delegation's `issueFor` returns suppliers'
// `DelegationInjection` (15 §1.2) and reads `ProviderCapabilities['mcpInjection']`.
const TYPE_ONLY_EDGES = {
  delegation: ['suppliers']
}
const edgeRules = Object.entries(EDGES).map(([from, allowed]) => ({
  name: `R4-module-edge-${from}`,
  severity: 'error',
  comment: `${from} may import only ${allowed.join(', ') || 'no other module'} (05 §1.3; ADR-004 P3)`,
  from: { path: `^src/host/modules/${from}/` },
  to: {
    path: '^src/host/modules/[^/]+/index\\.ts$',
    pathNot: [
      `^src/host/modules/(${[from, ...allowed, ...(TYPE_ONLY_EDGES[from] ?? [])].join('|')})/index\\.ts$`
    ]
  }
}))
const typeOnlyEdgeRules = Object.entries(TYPE_ONLY_EDGES).map(([from, typesOf]) => ({
  name: `R4-module-edge-${from}-type-only`,
  severity: 'error',
  comment: `${from} may import only the types of ${typesOf.join(', ')} (05 §1.3, AMENDMENT-14 A14-07; ADR-004 P3)`,
  from: { path: `^src/host/modules/${from}/` },
  to: {
    path: `^src/host/modules/(${typesOf.join('|')})/index\\.ts$`,
    dependencyTypesNot: ['type-only']
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
    ...typeOnlyEdgeRules,
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
      name: 'R6-relay-entry-not-imported',
      comment:
        'the relay entry relayMain.ts is imported only by its own tests (05 R6, deviation 6; ADR-004 P4)',
      severity: 'error',
      from: {
        pathNot: '^src/host/modules/delegation/adapters/mcp/relay/[^/]+\.test\.ts$'
      },
      to: { path: '^src/host/modules/delegation/adapters/mcp/relay/relayMain\.ts$' }
    },
    {
      name: 'R6-viewer-entry-not-imported',
      comment:
        'the console viewer entry viewerMain.ts is imported only by its own tests (05 R6, deviation 7; ADR-004 P4)',
      severity: 'error',
      from: {
        pathNot: '^src/host/modules/conversation/adapters/console/viewer/[^/]+\.test\.ts$'
      },
      to: { path: '^src/host/modules/conversation/adapters/console/viewer/viewerMain\.ts$' }
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
        'module adapters never import contracts, except diagnostics, the relay shim and the console viewer (05 R9; ADR-004 P5)',
      severity: 'error',
      from: {
        path: `${M}adapters/`,
        pathNot:
          '^src/host/modules/(diagnostics/adapters|delegation/adapters/mcp/relay|conversation/adapters/console/viewer)/'
      },
      to: { path: '^src/contracts/' }
    },
    {
      name: 'R9-diagnostics-only-logging',
      comment: 'diagnostics adapters import only contracts/logging (05 R9; ADR-004 P5, P13)',
      severity: 'error',
      from: { path: '^src/host/modules/diagnostics/adapters/' },
      to: { path: '^src/contracts/', pathNot: '^src/contracts/logging/' }
    },
    {
      name: 'R9-relay-only-logging-and-host-protocol',
      comment:
        'the relay shim imports only contracts/logging and contracts/host-protocol (05 R9, deviation 5; ADR-004 P5, P13)',
      severity: 'error',
      from: { path: '^src/host/modules/delegation/adapters/mcp/relay/' },
      to: { path: '^src/contracts/', pathNot: '^src/contracts/(logging|host-protocol)/' }
    },
    {
      name: 'R9-viewer-only-logging-and-host-protocol',
      comment:
        'the console viewer imports only contracts/logging and contracts/host-protocol (05 R9, deviation 7; ADR-004 P5, P13)',
      severity: 'error',
      from: { path: '^src/host/modules/conversation/adapters/console/viewer/' },
      to: { path: '^src/contracts/', pathNot: '^src/contracts/(logging|host-protocol)/' }
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
      // ISSUE-184 removed the package, so a planted import resolves to nothing: the bare module name matches too.
      to: { path: '^(node_modules/)?@anthropic-ai/claude-agent-sdk' }
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
