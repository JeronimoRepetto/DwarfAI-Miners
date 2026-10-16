// The HostedCommandDriver ("Other…", `stdio-raw`, 15 §4.11) against the conformance suite (15 §6)
// over the synthetic streams of `fixtures/other/stdio-raw/1/` (ISSUE-157 TC-157-01), plus its
// driver-specific cases: the spawn is the person's parsed argv with no shell and the allowlisted
// environment (TC-157-02; NFR-SEC-09, C-23), composer text goes to stdin and the captured output
// comes back as log entries, the 3 s early-failure window, kill-only close and the identity report.
// The cases H1's capabilities make inapplicable are declared and asserted at their fail-closed value.
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../../../kernel/fakes/FakeScheduler'
import type { SpawnSpec } from '../../../../../kernel/ports/processControl'
import type { PermissionModeSpec } from '../../../domain/profile'
import { CATALOG_RECORDS } from '../../catalog/profiles'
import type {
  DriverLaunchError,
  DriverLaunchRequest,
  InstalledProvider,
  ProviderDriver
} from '../../../ports/providerDriver'
import {
  CANARY_TOKEN,
  driverConformance,
  LOGIN_ENV,
  runScript,
  type ConformanceOptions,
  type DriverFactory,
  type Run
} from '../../../testing/driverConformance'
import { readFixtureSet, type FixtureVariant, type ScriptStep } from '../../../testing/fixtureSet'
import { RecordingSpawn, type SpawnScript } from '../../../testing/recordingSpawn'
import { FORBIDDEN_FLAGS } from '../shared/forbiddenFlags'
import { HostedCommandDriver } from './HostedCommandDriver'
import { HOSTED_COMMAND_CEILING, HOSTED_COMMAND_PROFILE } from './profile'

const FIXTURE_DIR = fileURLToPath(
  new URL('../../../../../../../fixtures/other/stdio-raw/1/', import.meta.url)
)
const FIXTURES = readFixtureSet(FIXTURE_DIR)

/** What `parseHostedCommand()` (later: ISSUE-165) hands the driver: the person's own argv. */
const ARGV: readonly string[] = [
  '/usr/local/bin/my-agent',
  '--non-interactive',
  '--title',
  'two words; not a shell'
]

const INSTALL: InstalledProvider = {
  providerId: HOSTED_COMMAND_PROFILE.id,
  binaryPath: ARGV[0] as string,
  version: null,
  resolvedVia: 'path',
  statMtimeMs: 0
}

/** The driver as launching hands it a request: the parsed argv rides on every launch. */
function withArgv(driver: ProviderDriver, argv: readonly string[] | undefined): ProviderDriver {
  return {
    profile: driver.profile,
    transport: driver.transport,
    detect: () => driver.detect(),
    probe: (install) => driver.probe(install),
    launch: (req) => driver.launch(argv === undefined ? req : { ...req, customArgv: argv })
  }
}

function factoryFor(argv: readonly string[] | undefined): DriverFactory {
  return (rig) =>
    withArgv(
      new HostedCommandDriver({
        processControl: rig.processControl,
        clock: rig.clock,
        scheduler: rig.scheduler,
        loginEnv: rig.loginEnv,
        platform: 'linux',
        // The redaction rule is wiring's to bind (05 R9); outputTail.test.ts shows it is applied.
        redact: (text) => text
      }),
      argv
    )
}

const NO_ASK = 'permission and question are none: a raw stdio program opens no ask (15 §4.11)'

const OPTIONS: ConformanceOptions = {
  ceiling: HOSTED_COMMAND_CEILING,
  install: INSTALL,
  cases: {
    'C-06': { inapplicable: NO_ASK },
    'C-07': { inapplicable: NO_ASK },
    'C-08': { inapplicable: 'interrupt is false: kill only (15 §4.11)' },
    'C-09': { inapplicable: NO_ASK },
    'C-10': { inapplicable: NO_ASK },
    'C-11': { inapplicable: NO_ASK },
    'C-12': { inapplicable: 'answeredElsewhere is false' },
    'C-13': { inapplicable: NO_ASK },
    'C-14': { inapplicable: NO_ASK },
    'C-15': { inapplicable: NO_ASK },
    'C-16': { inapplicable: 'resume is none (15 §4.11)' },
    'C-17': { inapplicable: 'adopt is false' },
    'C-20': { inapplicable: 'turnEnd is none: a raw program has no turn-end vocabulary' },
    'C-21': { inapplicable: 'usage fidelity is 0: no usage (15 §4.11)' },
    'C-22': { inapplicable: 'permissionMode is null for stdio-raw: no policy-only mode' },
    'C-26': { inapplicable: 'the driver is not a stream-json driver' },
    'C-27': { inapplicable: 'the "Other…" profile has no answer-channel gate' }
  }
}

driverConformance('HostedCommandDriver conformance', factoryFor(ARGV), FIXTURES, OPTIONS)

// ---------- driver-specific cases ----------

function fixture(name: string): { script: readonly ScriptStep[]; variant: FixtureVariant } {
  const found = FIXTURES.cases.find((entry) => entry.name === name)
  const variant = found?.variants[0]
  if (found === undefined || variant === undefined) throw new Error(`no fixture ${name}`)
  return { script: found.expected.script, variant }
}

async function run(
  script: readonly ScriptStep[],
  options: {
    argv?: readonly string[] | undefined
    variant?: FixtureVariant | null
    spawn?: (spec: SpawnSpec, fixture: () => SpawnScript) => SpawnScript
  } = {}
): Promise<Run> {
  const argv = 'argv' in options ? options.argv : ARGV
  return runScript(
    factoryFor(argv),
    script,
    {
      variant: options.variant ?? null,
      ...(options.spawn === undefined ? {} : { spawn: options.spawn })
    },
    OPTIONS
  )
}

function rejection(outcome: unknown): Partial<DriverLaunchError> | undefined {
  return (outcome as { rejected?: Partial<DriverLaunchError> } | null)?.rejected
}

const SHELLS = /(^|[\\/])(sh|bash|zsh|dash|cmd|cmd\.exe|powershell|powershell\.exe|pwsh)$/i

describe('HostedCommandDriver', () => {
  it('[C-01, NFR-SEC-09] the recorded spawn is the parsed argv array with shell false', async () => {
    const { script, variant } = fixture('c-01-launch')
    const result = await run(script, { variant })
    const spawn = result.spawn.spawns[0]
    expect(result.spawn.spawns).toHaveLength(1)
    // The argv array itself: program, then each argument as typed, never joined into one string.
    expect(spawn?.executable).toBe(ARGV[0])
    expect(spawn?.args).toEqual(ARGV.slice(1))
    // No shell anywhere: not as the program, not as a `-c` / `/c` command line (C-17, R17).
    expect(SHELLS.test(spawn?.executable ?? '')).toBe(false)
    expect(spawn?.args).not.toContain('-c')
    expect(spawn?.args).not.toContain('/c')
    expect(spawn?.processGroup).toBe('own')
    expect(spawn?.stdio).toBe('pipe')
    // The first prompt goes on stdin, never into argv (15 §1.2 `prompt`).
    expect(result.sent).toEqual(['first prompt'])
    expect(spawn?.args.join(' ')).not.toContain('first prompt')
  })

  it('[C-23, NFR-SEC-09] the spawn gets the allowlisted child env with DWARFAI_SPAWN and nothing internal', async () => {
    const { script, variant } = fixture('c-01-launch')
    const result = await run(script, { variant })
    const env = result.spawn.spawns[0]?.env ?? {}
    expect(env).toEqual({
      PATH: '/usr/local/bin:/usr/bin',
      HOME: '/home/j',
      LANG: 'en_US.UTF-8',
      DWARFAI_SPAWN: 'v1:conformance:launch-1:1'
    })
    expect(JSON.stringify(env)).not.toContain(CANARY_TOKEN)
  })

  it('[C-05] composer text is written to stdin and the captured output appears as log entries', async () => {
    const { script, variant } = fixture('c-05-send-turn')
    const result = await run(script, { variant })
    expect(result.sent).toEqual(['first prompt', 'list the files'])
    expect(result.outcomes[2]).toEqual({
      confidence: 'confirmed',
      heldUntilTurnEnd: false,
      correlation: 'launch-1:m-1'
    })
    const entries = result.events.flatMap((event) =>
      event.t === 'message'
        ? [`${event.record.role} ${event.record.text}`]
        : event.t === 'activity'
          ? [`step ${event.step.summary}`]
          : []
    )
    expect(entries).toEqual([
      'step warning: running without a config file',
      'dwarf Agent ready. Reading the prompt.',
      'person list the files',
      'dwarf Listing the files.',
      'dwarf a.txt b.txt'
    ])
  })

  it('[C-04] an exit at 2 999 ms after spawn is exited-at-once and at 3 000 ms the launch has succeeded', async () => {
    const exitAt = (afterMs: number) => (): SpawnScript => ({
      kind: 'exit',
      afterMs,
      code: 1,
      stderr: 'fatal: no config'
    })
    const script: ScriptStep[] = [{ do: 'launch' }, { do: 'advance', ms: 3_001 }]
    const early = await run(script, { spawn: exitAt(2_999) })
    expect(rejection(early.outcomes[0])).toEqual({
      cause: 'exited-at-once',
      detail: 'exited with code 1 before the 3 s early-failure window ended',
      toolOutputTail: 'fatal: no config'
    })
    // Bound as soon as the window passed, so the run collects the session's events.
    const bound: ScriptStep[] = [
      { do: 'launch', readyAfterMs: 3_000 },
      { do: 'advance', ms: 1 }
    ]
    const late = await run(bound, { spawn: exitAt(3_000) })
    expect(late.outcomes[0]).toEqual({ resolved: true })
    expect(late.events.at(-1)).toEqual({ t: 'exited', code: 1 })
  })

  it('[C-28] close answers failed unsupported and the driver signals no process', async () => {
    const { script, variant } = fixture('c-28-close')
    const result = await run(script, { variant })
    expect(result.outcomes.slice(1)).toEqual([
      { kind: 'failed', reason: 'unsupported' },
      { kind: 'failed', reason: 'unsupported' },
      { kind: 'failed', reason: 'unsupported' }
    ])
    expect(result.spawn.killTreeCalls).toBe(0)
    expect(result.spawn.fake.signals).toEqual([])
    expect(result.sent).toEqual(['first prompt'])
  })

  it('[C-29] onSpawned is called once with the root identity before launch resolves', async () => {
    const { script, variant } = fixture('c-01-launch')
    const result = await run(script, { variant })
    const reported = result.launches[0]?.spawned ?? []
    expect(reported).toHaveLength(1)
    const marks = result.spawn.log
    expect(marks.indexOf(`spawn ${reported[0]?.pid}`)).toBeLessThan(
      marks.indexOf(`onSpawned ${reported[0]?.pid}`)
    )
    expect(marks.indexOf(`onSpawned ${reported[0]?.pid}`)).toBeLessThan(
      marks.indexOf('launch-resolved')
    )
    expect(result.session?.ref).toMatchObject({
      providerId: 'other',
      providerSessionId: 'launch-1',
      pid: reported[0]?.pid,
      processStartTimeMs: reported[0]?.processStartTimeMs
    })
  })

  describe('refuses a launch without spawning (ADR-020 item 3: could-not-start)', () => {
    const refusals: [string, readonly string[] | undefined][] = [
      ['no customArgv', undefined],
      ['an empty customArgv', []],
      ['an empty program', ['', '--flag']],
      ['a program other than the install', ['/usr/bin/other-agent', '--flag']],
      ['a NUL inside an argument', [ARGV[0] as string, 'a\u0000b']],
      ['a line break inside an argument', [ARGV[0] as string, 'a\nb']]
    ]
    for (const [label, argv] of refusals) {
      it(`[C-03] ${label} is could-not-start and spawns nothing`, async () => {
        const result = await run([{ do: 'launch' }], { argv })
        expect(rejection(result.outcomes[0])?.cause).toBe('could-not-start')
        expect(result.spawn.spawns).toEqual([])
      })
    }

    it('[C-24] a forbidden auto-approve flag is could-not-start and spawns nothing', async () => {
      const result = await run([{ do: 'launch' }], {
        argv: [ARGV[0] as string, FORBIDDEN_FLAGS[0] as string]
      })
      expect(rejection(result.outcomes[0])?.cause).toBe('could-not-start')
      expect(result.spawn.spawns).toEqual([])
    })

    it('[C-03] a second launch with the same launchId is could-not-start and spawns once', async () => {
      const { variant } = fixture('c-01-launch')
      const script: ScriptStep[] = [
        { do: 'launch', launchId: 'same' },
        { do: 'launch', launchId: 'same' }
      ]
      const result = await run(script, { variant })
      expect(rejection(result.outcomes[1])?.cause).toBe('could-not-start')
      expect(result.spawn.spawns).toHaveLength(1)
    })

    it('[C-03] a permission mode or a delegation injection is could-not-start for stdio-raw', async () => {
      const clock = new FakeClock(0)
      const scheduler = new FakeScheduler(clock)
      const processControl = new RecordingSpawn({
        clock,
        scheduler,
        decide: () => ({ kind: 'exit', afterMs: 60_000, code: 0 })
      })
      const driver = factoryFor(ARGV)({ clock, scheduler, processControl, loginEnv: LOGIN_ENV })
      const base: DriverLaunchRequest = {
        launchId: 'l-1' as DriverLaunchRequest['launchId'],
        install: INSTALL,
        cwd: '/work/mine' as DriverLaunchRequest['cwd'],
        prompt: 'go',
        permissionMode: null,
        delegation: null,
        spawnTag: 'v1:i:l-1:1',
        onSpawned: async () => {}
      }
      const mode: PermissionModeSpec = {
        id: 'ask',
        label: 'Ask',
        needs: 'policy-only',
        providerArgs: {}
      }
      await expect(driver.launch({ ...base, permissionMode: mode })).rejects.toMatchObject({
        cause: 'could-not-start'
      })
      await expect(
        driver.launch({
          ...base,
          launchId: 'l-2' as DriverLaunchRequest['launchId'],
          delegation: { mechanism: 'ticket-file', credentialFilePath: '/run/mcp/l-2.cred' }
        })
      ).rejects.toMatchObject({ cause: 'could-not-start' })
      expect(processControl.spawns).toEqual([])
    })
  })

  it('[INV-43] the "Other…" profile is no catalog provider and probes without a process', async () => {
    expect(CATALOG_RECORDS.map((record) => record.profile.id)).not.toContain(
      HOSTED_COMMAND_PROFILE.id
    )
    const result = await run([{ do: 'probe' }])
    expect(result.outcomes[0]).toEqual(HOSTED_COMMAND_CEILING)
    expect(result.spawn.spawns).toEqual([])
  })
})
