import * as nodeFs from 'node:fs'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeClock } from '../../src/host/kernel/fakes/FakeClock.ts'
import { FakeScheduler } from '../../src/host/kernel/fakes/FakeScheduler.ts'
import {
  SIMULATED_HANDSHAKE_MS,
  SimulatedDriver
} from '../../src/host/modules/suppliers/adapters/drivers/simulated/SimulatedDriver.ts'
import { checkFixturesLayout } from '../checks/fixtures-layout.mjs'
import { laneRefusal, parseScenario, RECORDING_ADAPTERS, runRecord } from './record.mjs'
import { runScrub } from './scrub.mjs'

/**
 * L7 tests of `record.mjs` (17 §1.4 recording steps 2–3, §5.5). No real provider runs here: the
 * driver under recording is the SimulatedDriver (ISSUE-143), reached through a test-only recording
 * adapter, and every path lives in a per-test `mkdtemp` directory.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const LANE_ENV = { RUN_INTEGRATION: '1', DWARFAI_REAL_CLI: 'canary,simulated' }

/**
 * Provider credential and login stores the harness must never open (ADR-008 item 2): file names
 * and folder names of the providers DwarfAI supports, and the OS keychains.
 */
const CREDENTIAL_PATH =
  /\.credentials\.json|(?:^|[\\/])auth\.json$|oauth_creds\.json|google_accounts\.json|antigravity-oauth-token|\.pb$|[\\/]\.claude(?:[\\/]|$)|[\\/]\.codex(?:[\\/]|$)|[\\/]\.gemini(?:[\\/]|$)|[\\/]opencode[\\/]auth|keychain|keyring/i

const CAPABILITIES = {
  launch: true,
  observe: true,
  sendTurn: true,
  interrupt: true,
  permission: 'none',
  question: 'none',
  answeredElsewhere: false,
  staleAnswerSafe: true,
  resume: 'none',
  adopt: false,
  turnEnd: 'reliable',
  reactionEvidence: 'turn-id',
  subagents: 'none',
  usage: { fidelity: 0, rateLimits: false },
  mcpInjection: 'none',
  console: 'log',
  earlyFailure: 'handshake',
  installDetection: 'none',
  observedPermission: 'none',
  observedQuestion: 'none'
}

/** Lets every pending promise continuation run (no timers: the scheduler is fake). */
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/**
 * The test-only recording adapter: drives the SimulatedDriver through the scenario's turns and
 * tees what it would send and what it receives, as a real driver's adapter tees stdin and stdout.
 */
function simulatedAdapter(calls) {
  return {
    async detect() {
      return { providerVersion: '1.0.0', capabilities: CAPABILITIES }
    },
    async run({ repoDir, scenario, tee }) {
      calls.push(repoDir)
      const clock = new FakeClock(Date.parse('2026-09-30T14:21:07.250Z'))
      const scheduler = new FakeScheduler(clock)
      const driver = new SimulatedDriver({
        profile: {
          id: 'simulated',
          label: 'Simulated',
          binaries: [],
          models: [],
          efforts: [],
          permissionModes: [],
          drivers: ['acp'],
          publicLaunch: 'enabled'
        },
        transport: 'acp',
        capabilities: CAPABILITIES,
        seed: 'record-test',
        clock,
        scheduler
      })
      const [first] = scenario.turns
      tee.mark('spawned')
      const pending = driver.launch({
        launchId: 'launch-1',
        install: {
          providerId: 'simulated',
          binaryPath: 'simulated',
          version: '1.0.0',
          resolvedVia: 'path',
          statMtimeMs: 0
        },
        cwd: repoDir,
        prompt: first.text,
        permissionMode: null,
        delegation: null,
        spawnTag: 'v1:install:launch-1:epoch',
        onSpawned: async () => {}
      })
      await settle()
      clock.advance(SIMULATED_HANDSHAKE_MS)
      const session = await pending
      tee.received.write(`${JSON.stringify({ type: 'session', ref: session.ref })}\n`)
      for (const [index, turn] of scenario.turns.entries()) {
        tee.sent.write(
          `${JSON.stringify({ type: 'turn', messageId: `message-${index + 1}`, text: turn.text })}\n`
        )
        await session.sendTurn({
          messageId: `message-${index + 1}`,
          kind: 'message',
          text: turn.text,
          attachments: []
        })
        clock.advance(10_000)
        for await (const event of session.events()) {
          tee.received.write(`${JSON.stringify(event)}\n`)
          if (event.t === 'status' && event.value === 'idle') break
        }
      }
      tee.mark('exit', { code: 0 })
    }
  }
}

/** A `node:fs` that records the first argument (the path) of every call. */
function recordingFs(touched) {
  return new Proxy(nodeFs, {
    get(target, name) {
      const value = target[name]
      if (typeof value !== 'function') return value
      return (...args) => {
        touched.push(String(args[0]))
        return value.apply(target, args)
      }
    }
  })
}

let tempRoots = []

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true })
  tempRoots = []
})

function tempDir(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

/** A recording request over temp directories, with the lane switched on. */
function request(overrides = {}) {
  const calls = []
  const touched = []
  const logged = []
  const fixturesRoot = tempDir('fixtures-record-')
  const tmp = tempDir('record-tmp-')
  return {
    calls,
    touched,
    logged,
    fixturesRoot,
    tmp,
    request: {
      provider: 'simulated',
      driver: 'acp',
      caseName: 'simple-turn',
      env: LANE_ENV,
      adapters: { 'simulated/acp': simulatedAdapter(calls) },
      fixturesRoot,
      scenariosDir: path.join(here, 'scenarios'),
      tmp,
      fs: recordingFs(touched),
      now: () => Date.parse('2026-09-30T14:21:07.250Z'),
      platform: 'linux',
      log: (line) => logged.push(line),
      ...overrides
    }
  }
}

describe('record.mjs (17 §1.4, §5.5)', () => {
  it('[ADR-008] the recorder refuses to run when CI is set and never opens a provider credential path', async () => {
    const refused = request({ env: { ...LANE_ENV, CI: 'true' } })

    expect(await runRecord(refused.request)).toBe(2)
    expect(refused.logged.join('\n')).toMatch(/CI is set/)
    expect(refused.calls).toEqual([])
    expect(refused.touched).toEqual([])

    const allowed = request()
    expect(await runRecord(allowed.request)).toBe(0)
    expect(allowed.touched.length).toBeGreaterThan(0)
    expect(allowed.touched.filter((p) => CREDENTIAL_PATH.test(p))).toEqual([])
    // Every path the recorder touches is the scenario, the fixture folder or its throwaway repo.
    const allowedRoots = [allowed.fixturesRoot, allowed.tmp, path.join(here, 'scenarios')]
    for (const touched of allowed.touched) {
      expect(allowedRoots.some((root) => path.resolve(touched).startsWith(root))).toBe(true)
    }
    // The ADR-008 static check over the harness itself (17 §5.5): no credential store file and no
    // keychain access tool is named (the doc comments may say "keychain" in prose).
    for (const file of ['record.mjs', 'scrub.mjs', 'lib/scrubRules.mjs']) {
      const source = readFileSync(path.join(here, file), 'utf8')
      expect(source).not.toMatch(
        /\.credentials\.json|auth\.json|oauth_creds|google_accounts|oauth-token|keytar|find-generic-password|secret-tool|CredRead/i
      )
    }
  })

  it('[ADR-008] the recorder runs only in the opt-in lane: RUN_INTEGRATION=1 and the provider listed in DWARFAI_REAL_CLI', () => {
    expect(laneRefusal({ ...LANE_ENV, CI: '' }, 'canary')).toBeNull()
    expect(laneRefusal({ ...LANE_ENV, CI: 'false' }, 'canary')).toMatch(/CI is set/)
    expect(laneRefusal({ DWARFAI_REAL_CLI: 'canary' }, 'canary')).toMatch(/RUN_INTEGRATION=1/)
    expect(laneRefusal({ RUN_INTEGRATION: '1' }, 'canary')).toMatch(/DWARFAI_REAL_CLI/)
    expect(laneRefusal({ RUN_INTEGRATION: '1', DWARFAI_REAL_CLI: 'other' }, 'canary')).toMatch(
      /DWARFAI_REAL_CLI/
    )
    expect(
      laneRefusal({ RUN_INTEGRATION: '1', DWARFAI_REAL_CLI: ' other , canary ' }, 'canary')
    ).toBeNull()
  })

  it('[ADR-008] a scenario is scripted: unknown fields, an empty turn or a file outside the repository are refused', () => {
    const valid = {
      case: 'simple-turn',
      description: 'One prompt.',
      repoFiles: { 'README.md': '# Throwaway\n' },
      turns: [{ text: 'Say hello.' }]
    }
    const text = (overrides) => JSON.stringify({ ...valid, ...overrides })

    expect(parseScenario('simple-turn', text({}))).toEqual(valid)
    expect(() => parseScenario('other-case', text({}))).toThrow(/case/)
    expect(() => parseScenario('simple-turn', text({ notes: 'free text' }))).toThrow(/notes/)
    expect(() => parseScenario('simple-turn', text({ turns: [] }))).toThrow(/turns/)
    expect(() => parseScenario('simple-turn', text({ turns: [{ text: ' ' }] }))).toThrow(/turns/)
    expect(() => parseScenario('simple-turn', text({ repoFiles: { '../x': '' } }))).toThrow(
      /repoFiles/
    )
    expect(() => parseScenario('simple-turn', text({ repoFiles: { '/etc/x': '' } }))).toThrow(
      /repoFiles/
    )
    // The committed example is valid.
    const example = readFileSync(path.join(here, 'scenarios', 'simple-turn.json'), 'utf8')
    expect(parseScenario('simple-turn', example).turns.length).toBeGreaterThan(0)
  })

  it('[ADR-008] records the scenario through the tee transport into <case>.raw.* beside the target, from a throwaway repository it deletes', async () => {
    const run = request()

    expect(await runRecord(run.request)).toBe(0)

    expect(run.calls).toHaveLength(1)
    const [repoDir] = run.calls
    expect(path.basename(repoDir)).toMatch(/^dwarfai-rec-\d+$/)
    expect(path.dirname(repoDir)).toBe(run.tmp)
    expect(readdirSync(run.tmp)).toEqual([])
    const folder = path.join(run.fixturesRoot, 'simulated', 'acp', '1.0.0')
    expect(readdirSync(folder).sort()).toEqual([
      'simple-turn.raw.jsonl',
      'simple-turn.raw.meta.json',
      'simple-turn.raw.sent.jsonl',
      'simple-turn.raw.timing.jsonl'
    ])
    const meta = JSON.parse(readFileSync(path.join(folder, 'simple-turn.raw.meta.json'), 'utf8'))
    expect(meta).toMatchObject({
      provider: 'simulated',
      driver: 'acp',
      providerVersion: '1.0.0',
      os: 'linux',
      capturedAt: '2026-09-30',
      capabilities: CAPABILITIES,
      repoRoot: repoDir
    })
    const sent = readFileSync(path.join(folder, 'simple-turn.raw.sent.jsonl'), 'utf8')
    const scenario = JSON.parse(
      readFileSync(path.join(here, 'scenarios', 'simple-turn.json'), 'utf8')
    )
    expect(sent).toContain(JSON.stringify(scenario.turns[0].text))
    const received = readFileSync(path.join(folder, 'simple-turn.raw.jsonl'), 'utf8')
    expect(received).toMatch(/"t":"turn.ended"/)

    // Recording step 4: the raw capture scrubs into a valid fixture set (layout check).
    for (const fixed of ['bin', 'db', 'ipc/capabilities'])
      nodeFs.mkdirSync(path.join(run.fixturesRoot, fixed), { recursive: true })
    const rawPaths = readdirSync(folder).map((name) => path.join(folder, name))
    const identity = { home: 'C:\\Users\\canary.user', user: 'canary.user', host: 'canary-host' }
    expect(runScrub(rawPaths, { identity, log: () => {} })).toBe(0)
    expect(checkFixturesLayout(run.fixturesRoot)).toEqual([])
  })

  it('[ADR-008] a failed recording deletes its partial raw capture and its throwaway repository', async () => {
    const run = request({
      adapters: {
        'simulated/acp': {
          detect: async () => ({ providerVersion: '1.0.0', capabilities: CAPABILITIES }),
          run: async ({ tee }) => {
            tee.received.write('{"partial":true}\n')
            throw new Error('the provider exited')
          }
        }
      }
    })

    expect(await runRecord(run.request)).toBe(1)
    expect(readdirSync(run.tmp)).toEqual([])
    expect(readdirSync(path.join(run.fixturesRoot, 'simulated', 'acp', '1.0.0'))).toEqual([])
  })

  it('[ADR-008] no adapter is registered until a driver issue records with it, and an unknown one is a usage error', async () => {
    expect(RECORDING_ADAPTERS).toEqual({})
    const run = request({ adapters: RECORDING_ADAPTERS })
    expect(await runRecord(run.request)).toBe(2)
    expect(run.logged.join('\n')).toMatch(/no recording adapter for simulated\/acp/)
  })

  it('[ADR-008] no workflow file names the real-CLI lane or the recorder', () => {
    const LANE =
      /test:real-cli|scripts\/fixtures\/(?:record|scrub)|DWARFAI_REAL_CLI|RUN_INTEGRATION/
    // The guard bites: a workflow step that runs the lane is caught.
    expect('      - run: pnpm test:real-cli').toMatch(LANE)
    const workflows = path.join(repoRoot, '.github', 'workflows')
    const files = readdirSync(workflows).filter((name) => /\.ya?ml$/.test(name))
    expect(files.length).toBeGreaterThan(0)
    for (const name of files) {
      const text = readFileSync(path.join(workflows, name), 'utf8')
      expect(text, name).not.toMatch(LANE)
    }
    // The lane's script exists and runs only the opt-in integration files (17 §5.5).
    const { scripts } = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
    expect(scripts['test:real-cli']).toMatch(/^vitest run .*integration\.test$/)
  })
})
