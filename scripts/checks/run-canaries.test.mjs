import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { judgeCanary, loadCanaries, runCanary } from './run-canaries.mjs'

/**
 * L7 check of the canary job (05 §5.2, ADR-004 item 3, 17 §1.7).
 *
 * Every directory under `lint-canaries/` holds one minimal violating tree and an `expect.json`
 * naming the rule it must trip. The runner writes each tree into a fresh scratch directory, runs
 * dependency-cruiser and ESLint on it with the repository's configs, and accepts the canary only
 * when every reported violation belongs to that rule and the named rule itself is among them. A
 * rule that cannot fire, or a canary that trips another rule, fails the job.
 */

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const runnerPath = path.join(here, 'run-canaries.mjs')

/** Each canary spawns dependency-cruiser and loads ESLint: allow for a slow CI runner. */
const JOB_TIMEOUT_MS = 600_000
const ONE_CANARY_TIMEOUT_MS = 120_000

const GRAPH_RULES = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10']
const SYNTAX_RULES = ['R11', 'R12', 'R13', 'R14', 'R15', 'R16', 'R17', 'R18', 'R19']

let tempRoots = []

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true })
  tempRoots = []
})

/** Runs every canary of `ruleIds` in sequence and asserts each one reports exactly its rule. */
async function expectCanariesHold(ruleIds, requiredNames = []) {
  const canaries = loadCanaries()
  const covered = new Set(canaries.map((canary) => canary.ruleId))
  for (const ruleId of ruleIds) expect([...covered], `a canary for ${ruleId}`).toContain(ruleId)
  const names = canaries.map((canary) => canary.name)
  for (const name of requiredNames) expect(names, `the canary directory ${name}`).toContain(name)
  for (const canary of canaries.filter((each) => ruleIds.includes(each.ruleId))) {
    const result = await runCanary(canary)
    expect(result.ok, `${canary.name}: ${result.reason}`).toBe(true)
  }
}

describe('canary job (05 §5.2)', () => {
  it(
    '[R1, R2, R3, R4, R5, R6, R7, R8, R9, R10] every graph-rule canary reports exactly its rule',
    async () => {
      await expectCanariesHold(GRAPH_RULES)
    },
    JOB_TIMEOUT_MS
  )

  it(
    '[R11, R12, R13, R14, R15, R16, R17, R18, R19] every syntax and containment canary reports exactly its rule',
    async () => {
      await expectCanariesHold(SYNTAX_RULES, ['R11-no-claude-agent-sdk', 'R16'])
    },
    JOB_TIMEOUT_MS
  )

  it(
    '[R11] the Agent SDK canary is rejected from src/host, src/ui-main, src/preload and src/renderer',
    async () => {
      const agentSdk = loadCanaries().find((canary) => canary.name === 'R11-no-claude-agent-sdk')
      expect(agentSdk, 'the R11-no-claude-agent-sdk canary').toBeDefined()
      const [content] = Object.values(agentSdk.files)
      const roots = ['src/host', 'src/ui-main', 'src/preload', 'src/renderer/src']
      for (const root of roots) {
        const canary = {
          ...agentSdk,
          name: `R11-no-claude-agent-sdk in ${root}`,
          files: { [`${root}/__canary__/importsAgentSdk.ts`]: content }
        }
        const result = await runCanary(canary)
        expect(result.ok, `${canary.name}: ${result.reason}`).toBe(true)
      }
    },
    JOB_TIMEOUT_MS
  )

  it(
    '[ADR-004] a canary that produces no violation fails the job',
    async () => {
      const canariesDir = mkdtempSync(path.join(tmpdir(), 'lint-canaries-'))
      tempRoots.push(canariesDir)
      const harmless = path.join(canariesDir, 'R7', 'src', 'host', 'kernel', '__canary__')
      mkdirSync(harmless, { recursive: true })
      writeFileSync(
        path.join(canariesDir, 'R7', 'expect.json'),
        JSON.stringify({ rule: 'R7-electron-only-ui-main', tool: 'depcruise' })
      )
      writeFileSync(
        path.join(harmless, 'harmless.ts'),
        "import { clock } from './clock'\nexport const now = clock\n"
      )
      writeFileSync(path.join(harmless, 'clock.ts'), 'export const clock = 1\n')

      let exitCode = 0
      try {
        await execFileAsync(process.execPath, [runnerPath, '--canaries', canariesDir])
      } catch (error) {
        exitCode = error.code
      }
      expect(exitCode, 'runner exit code').not.toBe(0)
    },
    ONE_CANARY_TIMEOUT_MS
  )

  it('[ADR-004] a canary that also reports another rule fails the job', () => {
    const canary = {
      name: 'R7',
      ruleId: 'R7',
      rule: 'R7-electron-only-ui-main',
      tool: 'depcruise',
      files: {}
    }
    const own = { tool: 'depcruise', rule: 'R7-electron-only-ui-main', ruleIds: ['R7'] }
    const mirror = { tool: 'eslint', rule: 'no-restricted-imports', ruleIds: ['R7'] }
    const other = { tool: 'depcruise', rule: 'R10-host-not-ui', ruleIds: ['R10'] }
    const unrelated = { tool: 'eslint', rule: '@typescript-eslint/no-unused-vars', ruleIds: [] }

    expect(judgeCanary(canary, [own, mirror]).ok, 'own rule and its ESLint mirror').toBe(true)
    expect(judgeCanary(canary, [own, other]).ok, 'another architecture rule').toBe(false)
    expect(judgeCanary(canary, [own, unrelated]).ok, 'a rule outside R1–R19').toBe(false)
    expect(judgeCanary(canary, [mirror]).ok, 'the named rule missing').toBe(false)
    expect(judgeCanary(canary, []).ok, 'no violation').toBe(false)
  })
})
