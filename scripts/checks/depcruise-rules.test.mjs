import { existsSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { cruiseTree, stubPackageEntry } from './depcruise-fixture.mjs'

/**
 * L7 check of the dependency-cruiser rules (05 §5.1–§5.2, ADR-004 item 3, 17 §1.7).
 *
 * Each case writes a small violating (or, for the negative cases, conforming) tree into its own
 * `mkdtemp` directory and runs the pinned dependency-cruiser CLI on it with the repository's
 * `.dependency-cruiser.cjs`. The assertion names the exact rule of 05 §5.2 and the offending
 * edge, so a rule that cannot fire, or fires on the wrong edge, is caught.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const configPath = path.join(repoRoot, '.dependency-cruiser.cjs')
const baselinePath = path.join(here, 'legacy-exclude.baseline.json')

/** One CLI run spawns Node and TypeScript: allow for a slow CI runner. */
const CRUISE_TIMEOUT_MS = 60_000

const TEST_FILE = 'export const value = 1\n'

let tempRoots = []

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true })
  tempRoots = []
})

async function cruise(tree) {
  const result = await cruiseTree(tree)
  tempRoots.push(result.root)
  return result
}

/** Asserts that `rule` is reported for the edge `from` → `to`. */
function expectViolation(result, rule, from, to) {
  const onEdge = result.violations
    .filter((violation) => violation.from === from && violation.to === to)
    .map((violation) => violation.rule)
  expect(onEdge, `rules reported for ${from} -> ${to}`).toContain(rule)
}

/** The exclude list of the config as an array of path patterns. */
function excludeList(config) {
  const exclude = config.options?.exclude
  const value = typeof exclude === 'object' && !Array.isArray(exclude) ? exclude.path : exclude
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

/** The module → module edges of 05 §1.3, written out independently of the config's EDGES. */
const MODULE_GRAPH_EDGES = [
  ['observation', 'mines'],
  ['observation', 'suppliers'],
  ['mines', 'crew'],
  ['crew', 'suppliers'],
  ['launching', 'suppliers'],
  ['launching', 'mines'],
  ['launching', 'jev'],
  ['launching', 'crew'],
  ['conversation', 'suppliers'],
  ['conversation', 'crew'],
  ['asking', 'suppliers'],
  ['asking', 'crew'],
  ['asking', 'conversation'],
  ['delegation', 'jev'],
  ['delegation', 'launching'],
  ['delegation', 'conversation'],
  ['delegation', 'preferences'],
  ['jev', 'suppliers'],
  ['jev', 'preferences'],
  ['attention', 'preferences']
]

describe('dependency-cruiser rules (05 §5.2)', () => {
  it(
    '[R1] a domain file importing node:fs is reported as R1-domain-no-builtins',
    async () => {
      const from = 'src/host/modules/crew/domain/rules.ts'
      const result = await cruise({
        files: {
          [from]: "import { readFileSync } from 'node:fs'\nexport const read = readFileSync\n",
          'src/host/modules/crew/domain/other.ts': TEST_FILE
        }
      })
      const reported = result.violations.filter((violation) => violation.from === from)
      expect(reported.map((violation) => violation.rule)).toContain('R1-domain-no-builtins')
    },
    CRUISE_TIMEOUT_MS
  )

  it(
    "[R1] a domain file importing its module's adapters is reported as R1-domain-pure",
    async () => {
      const from = 'src/host/modules/crew/domain/rules.ts'
      const to = 'src/host/modules/crew/adapters/repo.ts'
      const result = await cruise({
        files: {
          [from]: "import { value } from '../adapters/repo'\nexport const rule = value\n",
          [to]: TEST_FILE
        }
      })
      expectViolation(result, 'R1-domain-pure', from, to)
    },
    CRUISE_TIMEOUT_MS
  )

  it(
    '[R2] a value import in ports/ is reported as R2-ports-type-only',
    async () => {
      const from = 'src/host/modules/crew/ports/Repo.ts'
      const to = 'src/host/modules/crew/domain/dwarf.ts'
      const result = await cruise({
        files: {
          [from]: "import { value } from '../domain/dwarf'\nexport const port = value\n",
          [to]: TEST_FILE
        }
      })
      expectViolation(result, 'R2-ports-type-only', from, to)
    },
    CRUISE_TIMEOUT_MS
  )

  it(
    '[R3] application/ importing adapters/ or contracts/ is reported as R3-application-no-adapters',
    async () => {
      const from = 'src/host/modules/crew/application/endOwned.ts'
      const adapter = 'src/host/modules/crew/adapters/repo.ts'
      const contract = 'src/contracts/wire/views.ts'
      const result = await cruise({
        files: {
          [from]:
            "import { value } from '../adapters/repo'\n" +
            "import { value as view } from '../../../../contracts/wire/views'\n" +
            'export const useCase = [value, view]\n',
          [adapter]: TEST_FILE,
          [contract]: TEST_FILE
        }
      })
      expectViolation(result, 'R3-application-no-adapters', from, adapter)
      expectViolation(result, 'R3-application-no-adapters', from, contract)
    },
    CRUISE_TIMEOUT_MS
  )

  it(
    '[R4] crew importing launching/index.ts is reported as R4-module-edge-crew',
    async () => {
      const from = 'src/host/modules/crew/application/endOwned.ts'
      const to = 'src/host/modules/launching/index.ts'
      const result = await cruise({
        files: {
          [from]: "import { value } from '../../launching/index'\nexport const useCase = value\n",
          [to]: TEST_FILE
        }
      })
      expectViolation(result, 'R4-module-edge-crew', from, to)
    },
    CRUISE_TIMEOUT_MS
  )

  it(
    "[R4] a deep import of another module's domain/ is reported as R4-cross-module-only-index",
    async () => {
      const from = 'src/host/modules/mines/application/listMines.ts'
      const to = 'src/host/modules/crew/domain/dwarf.ts'
      const result = await cruise({
        files: {
          [from]: "import { value } from '../../crew/domain/dwarf'\nexport const useCase = value\n",
          [to]: TEST_FILE
        }
      })
      expectViolation(result, 'R4-cross-module-only-index', from, to)
    },
    CRUISE_TIMEOUT_MS
  )

  it(
    '[R5] two modules importing each other are reported as R5-no-cycles',
    async () => {
      const mines = 'src/host/modules/mines/index.ts'
      const crew = 'src/host/modules/crew/index.ts'
      const result = await cruise({
        files: {
          [mines]: "import { crew } from '../crew/index'\nexport const mines = () => crew\n",
          [crew]: "import { mines } from '../mines/index'\nexport const crew = () => mines\n"
        }
      })
      expect(
        result.violations.filter((violation) => violation.rule === 'R5-no-cycles').length,
        'R5-no-cycles violations'
      ).toBeGreaterThan(0)
    },
    CRUISE_TIMEOUT_MS
  )

  it(
    '[R6] host/transport importing a module adapter is reported as R6-adapters-only-from-roots',
    async () => {
      const from = 'src/host/transport/server.ts'
      const to = 'src/host/modules/crew/adapters/repo.ts'
      const result = await cruise({
        files: {
          [from]:
            "import { value } from '../modules/crew/adapters/repo'\nexport const server = value\n",
          [to]: TEST_FILE
        }
      })
      expectViolation(result, 'R6-adapters-only-from-roots', from, to)
    },
    CRUISE_TIMEOUT_MS
  )

  it(
    '[R7] src/host importing electron is reported as R7-electron-only-ui-main',
    async () => {
      const from = 'src/host/kernel/tray.ts'
      const result = await cruise({
        files: {
          [from]: "import { app } from 'electron'\nexport const tray = app\n",
          'src/host/kernel/other.ts': TEST_FILE
        }
      })
      expectViolation(result, 'R7-electron-only-ui-main', from, 'electron')
    },
    CRUISE_TIMEOUT_MS
  )

  it(
    '[R8] the renderer importing src/host or node:path is reported as R8-renderer-isolated / R8-renderer-no-node',
    async () => {
      const from = 'src/renderer/src/lib/panel.ts'
      const host = 'src/host/kernel/clock.ts'
      const result = await cruise({
        files: {
          [from]:
            "import { value } from '../../../host/kernel/clock'\n" +
            "import { join } from 'node:path'\n" +
            'export const panel = [value, join]\n',
          [host]: TEST_FILE
        }
      })
      expectViolation(result, 'R8-renderer-isolated', from, host)
      const noNode = result.violations.filter(
        (violation) => violation.from === from && violation.rule === 'R8-renderer-no-node'
      )
      expect(
        noNode.map((violation) => violation.to),
        'R8-renderer-no-node targets'
      ).toHaveLength(1)
    },
    CRUISE_TIMEOUT_MS
  )

  it(
    '[R8] a renderer test importing node:fs reports nothing; the same import from a production renderer file is reported as R8-renderer-no-node',
    async () => {
      const rendererTest = 'src/renderer/src/lib/panel.test.ts'
      const rendererFile = 'src/renderer/src/lib/panel.ts'
      const imports = "import { readFileSync } from 'node:fs'\nexport const read = readFileSync\n"
      const result = await cruise({
        files: { [rendererTest]: imports, [rendererFile]: imports }
      })
      const fromTest = result.violations.filter((violation) => violation.from === rendererTest)
      expect(fromTest).toEqual([])
      expectViolation(result, 'R8-renderer-no-node', rendererFile, 'fs')
    },
    CRUISE_TIMEOUT_MS
  )

  it(
    '[R9] src/contracts importing a non-zod package is reported as R9-contracts-self-contained',
    async () => {
      const from = 'src/contracts/wire/views.ts'
      const result = await cruise({
        files: {
          [from]:
            "import { z } from 'zod'\nimport left from 'left-pad'\nexport const view = [z, left]\n",
          'src/contracts/wire/ids.ts': TEST_FILE
        },
        dependencies: ['zod', 'left-pad']
      })
      const reported = result.violations.filter(
        (violation) => violation.from === from && violation.rule === 'R9-contracts-self-contained'
      )
      expect(reported.map((violation) => violation.to)).toEqual([stubPackageEntry('left-pad')])
    },
    CRUISE_TIMEOUT_MS
  )

  it(
    '[R10] src/ui-main importing src/host is reported as R10-ui-not-host',
    async () => {
      const from = 'src/ui-main/index.ts'
      const to = 'src/host/kernel/clock.ts'
      const result = await cruise({
        files: {
          [from]: "import { value } from '../host/kernel/clock'\nexport const ui = value\n",
          [to]: TEST_FILE
        }
      })
      expectViolation(result, 'R10-ui-not-host', from, to)
    },
    CRUISE_TIMEOUT_MS
  )

  it(
    '[R11, NFR-COMP-03] src/host importing @anthropic-ai/claude-agent-sdk is reported as R11-no-claude-agent-sdk',
    async () => {
      const from = 'src/host/modules/suppliers/adapters/drivers/claude/driver.ts'
      const result = await cruise({
        files: {
          [from]: "import sdk from '@anthropic-ai/claude-agent-sdk'\nexport const driver = sdk\n",
          'src/host/modules/suppliers/index.ts': TEST_FILE
        },
        dependencies: ['@anthropic-ai/claude-agent-sdk']
      })
      expectViolation(
        result,
        'R11-no-claude-agent-sdk',
        from,
        stubPackageEntry('@anthropic-ai/claude-agent-sdk')
      )
    },
    CRUISE_TIMEOUT_MS
  )

  it(
    '[R11] node:sqlite outside host/platform/sqlite is reported as R11-sqlite-containment',
    async () => {
      const from = 'src/host/platform/fs/store.ts'
      const result = await cruise({
        files: {
          [from]: "import { DatabaseSync } from 'node:sqlite'\nexport const store = DatabaseSync\n",
          'src/host/platform/sqlite/database.ts':
            "import { DatabaseSync } from 'node:sqlite'\nexport const database = DatabaseSync\n"
        }
      })
      const reported = result.violations.filter(
        (violation) => violation.rule === 'R11-sqlite-containment'
      )
      expect(reported.map((violation) => violation.from)).toEqual([from])
    },
    CRUISE_TIMEOUT_MS
  )

  it(
    '[R14] production code importing a fakes/ file is reported as R14-no-test-code-in-prod',
    async () => {
      const from = 'src/host/wiring/routes.ts'
      const to = 'src/host/kernel/fakes/FakeClock.ts'
      const result = await cruise({
        files: {
          [from]:
            "import { value } from '../kernel/fakes/FakeClock'\nexport const routes = value\n",
          [to]: TEST_FILE
        }
      })
      expectViolation(result, 'R14-no-test-code-in-prod', from, to)
    },
    CRUISE_TIMEOUT_MS
  )

  it(
    "[R15] host/wiring importing a module's application/ is reported as R15-wiring-uses-index",
    async () => {
      const from = 'src/host/wiring/routes.ts'
      const to = 'src/host/modules/crew/application/endOwned.ts'
      const result = await cruise({
        files: {
          [from]:
            "import { value } from '../modules/crew/application/endOwned'\nexport const routes = value\n",
          [to]: TEST_FILE
        }
      })
      expectViolation(result, 'R15-wiring-uses-index', from, to)
    },
    CRUISE_TIMEOUT_MS
  )

  // R16 (only src/legacy-bridge imports src/main or src/shared) is not proven here. The legacy
  // `exclude` drops every dependency whose resolved path matches it
  // (dependency-cruiser 18.4.0 src/extract/extract-dependencies.mjs:180-181), so an import of an
  // excluded legacy file never reaches R16-legacy-only-through-bridge. The ISSUE-005 canary suite
  // owns that proof, through ESLint's IMP.legacy group (05 §5.2 notes, §5.3).

  it(
    '[R17] node:child_process outside the three allowed paths is reported as R17-spawn-containment',
    async () => {
      const from = 'src/host/modules/launching/adapters/spawner.ts'
      const spawn = "import { spawn } from 'node:child_process'\nexport const run = spawn\n"
      const result = await cruise({
        files: {
          [from]: spawn,
          'src/host/platform/process/spawn.ts': spawn,
          'src/ui-main/hostLauncher/launch.ts': spawn,
          'src/ui-main/window/adapters/terminal/open.ts': spawn
        }
      })
      const reported = result.violations.filter(
        (violation) => violation.rule === 'R17-spawn-containment'
      )
      expect(reported.map((violation) => violation.from)).toEqual([from])
    },
    CRUISE_TIMEOUT_MS
  )

  it(
    '[R4] every EDGES edge of 05 §1.3 is allowed: launching importing crew/index.ts reports nothing',
    async () => {
      const files = {}
      const modules = new Set(MODULE_GRAPH_EDGES.flat())
      for (const module of modules) files[`src/host/modules/${module}/index.ts`] = TEST_FILE
      for (const [from, to] of MODULE_GRAPH_EDGES) {
        files[`src/host/modules/${from}/application/uses-${to}.ts`] =
          `import { value } from '../../${to}/index'\nexport const useCase = value\n`
      }
      const result = await cruise({ files })
      expect(result.violations).toEqual([])
    },
    CRUISE_TIMEOUT_MS
  )

  it('[ADR-004] the legacy exclude list is a subset of scripts/checks/legacy-exclude.baseline.json', () => {
    expect(existsSync(configPath), '.dependency-cruiser.cjs').toBe(true)
    expect(existsSync(baselinePath), 'legacy-exclude.baseline.json').toBe(true)
    const config = createRequire(import.meta.url)(configPath)
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
    for (const pattern of excludeList(config)) {
      expect(baseline, `exclude path ${pattern} is not in the baseline`).toContain(pattern)
    }
  })

  it(
    '[R1, R9] a domain test and a contracts test importing vitest and a fake report nothing',
    async () => {
      const fake = 'src/host/kernel/fakes/FakeClock.ts'
      const imports =
        "import { it } from 'vitest'\nimport { value } from '__FAKE__'\nexport const t = [it, value]\n"
      const domainTest = 'src/host/modules/crew/domain/dwarf.test.ts'
      const contractsTest = 'src/contracts/text/truncate.test.ts'
      const domainFile = 'src/host/modules/crew/domain/dwarf.ts'
      const contractsFile = 'src/contracts/text/truncate.ts'
      const result = await cruise({
        files: {
          [fake]: TEST_FILE,
          [domainTest]: imports.replace('__FAKE__', '../../../kernel/fakes/FakeClock'),
          [contractsTest]: imports.replace('__FAKE__', '../../host/kernel/fakes/FakeClock'),
          [domainFile]: "import { it } from 'vitest'\nexport const dwarf = it\n",
          [contractsFile]: "import { it } from 'vitest'\nexport const truncate = it\n"
        },
        devDependencies: ['vitest']
      })
      const fromTests = result.violations.filter(
        (violation) => violation.from === domainTest || violation.from === contractsTest
      )
      expect(fromTests).toEqual([])
      expectViolation(result, 'R1-domain-no-builtins', domainFile, stubPackageEntry('vitest'))
      expectViolation(
        result,
        'R9-contracts-self-contained',
        contractsFile,
        stubPackageEntry('vitest')
      )
    },
    CRUISE_TIMEOUT_MS
  )
})
