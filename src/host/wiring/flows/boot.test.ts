import { describe, expect, it } from 'vitest'
import type { AppPaths } from '../../kernel/ports/appPaths'
import { FakeAppPaths } from '../../kernel/fakes/FakeAppPaths'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeFs } from '../../kernel/fakes/FakeFs'
import { FakeProcessControl } from '../../kernel/fakes/FakeProcessControl'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { EnvAppPaths } from '../../platform/paths/EnvAppPaths'
import type { PrivilegeReport } from '../../platform/process/privilege'
import {
  BOOT_STEP_NAMES,
  runBoot,
  type BootDeps,
  type BootStep,
  type BootStepName,
  type HostStateReport
} from '../boot'
import { createBootSteps } from '../bootSteps'
import { BOOT_FAILED_EXIT_CODE, EXIT_CODES } from '../exitCodes'

// L2 flow (17 §1.2): the Host boot of 16 §8.2 / ADR-015 item 3 with every port faked. The step
// list is the real one of bootSteps.ts unless a case replaces one step to give it behaviour.

const DAY_MS = 24 * 60 * 60 * 1_000

const NOT_ELEVATED: PrivilegeReport = {
  elevated: { ok: true, value: false },
  inJob: { ok: true, value: false }
}

interface Harness {
  deps: BootDeps
  log: RecordingDiagnosticsLog
  clock: FakeClock
  scheduler: FakeScheduler
  states: HostStateReport[]
  exits: number[]
  /** The real step list over the harness's fakes. */
  realSteps: (paths: AppPaths) => readonly BootStep[]
}

function harness(
  overrides: { privilege?: PrivilegeReport; paths?: BootDeps['paths'] } = {}
): Harness {
  const log = new RecordingDiagnosticsLog()
  const clock = new FakeClock(1_790_000_000_000)
  const scheduler = new FakeScheduler(clock)
  const states: HostStateReport[] = []
  const exits: number[] = []
  const deps: BootDeps = {
    log,
    clock,
    state: { report: (report) => states.push(report) },
    privilege: () => Promise.resolve(overrides.privilege ?? NOT_ELEVATED),
    paths: overrides.paths ?? { ok: true, value: new FakeAppPaths() },
    runtime: { os: 'win32', arch: 'x64', node: '24.18.1', electron: '44.0.0' },
    exit: (code) => exits.push(code)
  }
  const realSteps = (paths: AppPaths): readonly BootStep[] =>
    createBootSteps({
      paths,
      clock,
      scheduler,
      ids: new SequenceIdGenerator(),
      fs: new FakeFs(),
      processControl: new FakeProcessControl(),
      log
    })
  return { deps, log, clock, scheduler, states, exits, realSteps }
}

/** The real list with the step `name` replaced by `run`. */
function withStep(
  realSteps: Harness['realSteps'],
  name: BootStepName,
  run: BootStep['run']
): (paths: AppPaths) => readonly BootStep[] {
  return (paths) => realSteps(paths).map((step) => (step.name === name ? { name, run } : step))
}

/**
 * The step names in the order their `host.boot.step` records were written. Each record's class is
 * its step, so the ADR-026 item 6 fold (one record per event, subsystem, causeClass and dwarfId in
 * 60 s) keeps every step's record instead of folding seven of them into a count.
 */
function loggedSteps(log: RecordingDiagnosticsLog): string[] {
  return log.byEvent('host.boot.step').map((entry) => entry.causeClass ?? '')
}

describe('Host boot sequence (16 §8.2, ADR-015 item 3)', () => {
  it('[ADR-015, S12.04, S12.06] boot runs the 16 §8.2 steps in order and reports starting then ready', async () => {
    const h = harness()

    const outcome = await runBoot(h.realSteps, h.deps)

    expect(outcome).toEqual({ kind: 'ready' })
    expect(BOOT_STEP_NAMES).toEqual([
      'bind-endpoint',
      'open-db-and-migrate',
      'resume-reset-saga',
      'construct-modules',
      'recover-sessions',
      'start-endpoints',
      'start-observation',
      'answer-ready'
    ])
    expect(h.realSteps(new FakeAppPaths()).map((step) => step.name)).toEqual(BOOT_STEP_NAMES)
    expect(loggedSteps(h.log)).toEqual(BOOT_STEP_NAMES)
    // Every step is still a placeholder: each says it was skipped and which issue owns it.
    expect(h.log.byEvent('host.boot.step').map((entry) => entry.outcome)).toEqual(
      BOOT_STEP_NAMES.map(() => 'skipped')
    )
    expect(h.states).toEqual([
      { state: 'starting', jobStatus: 'none' },
      { state: 'ready', jobStatus: 'none' }
    ])
    expect(h.log.byEvent('host.start')).toEqual([
      expect.objectContaining({ level: 'info', subsystem: 'host', outcome: 'ok' })
    ])
    expect(h.log.byEvent('host.ready')).toEqual([
      expect.objectContaining({ level: 'info', subsystem: 'host', durationMs: 0 })
    ])
    expect(h.exits).toEqual([])
  })

  it('[ADR-015] starting is reported once the endpoint step is done, before any later step runs', async () => {
    const h = harness()
    const seen: Array<HostStateReport['state'][]> = []
    const steps = withStep(h.realSteps, 'open-db-and-migrate', () => {
      seen.push(h.states.map((report) => report.state))
      return Promise.resolve({ kind: 'done' })
    })

    await runBoot(steps, h.deps)

    expect(seen).toEqual([['starting']])
    expect(h.log.byEvent('host.boot.step')[1]).toEqual(
      expect.objectContaining({ outcome: 'ok', msg: 'step open-db-and-migrate done' })
    )
  })

  it('[S12.05] a migrating step reports migrating and returns to starting before ready', async () => {
    const h = harness()
    const steps = withStep(h.realSteps, 'open-db-and-migrate', (context) => {
      context.reportMigrating()
      h.clock.advance(1_500)
      return Promise.resolve({ kind: 'done' })
    })

    expect(await runBoot(steps, h.deps)).toEqual({ kind: 'ready' })

    expect(h.states.map((report) => report.state)).toEqual([
      'starting',
      'migrating',
      'starting',
      'ready'
    ])
    expect(h.log.byEvent('host.migrating')).toEqual([
      expect.objectContaining({ level: 'info', subsystem: 'host', durationMs: 1_500 })
    ])
    expect(h.log.byEvent('host.ready')).toEqual([expect.objectContaining({ durationMs: 1_500 })])
  })

  it('[S12.03, FM-011] an elevated start exits ELEVATED_REFUSED before binding anything', async () => {
    const h = harness({ privilege: { ...NOT_ELEVATED, elevated: { ok: true, value: true } } })
    const ran: string[] = []
    const steps = (paths: AppPaths): readonly BootStep[] =>
      h.realSteps(paths).map((step) => ({
        name: step.name,
        run: (context) => {
          ran.push(step.name)
          return step.run(context)
        }
      }))

    const outcome = await runBoot(steps, h.deps)

    expect(outcome).toEqual({ kind: 'refused', refusal: 'ELEVATED_REFUSED' })
    expect(h.exits).toEqual([EXIT_CODES.ELEVATED_REFUSED])
    expect(ran).toEqual([])
    expect(h.states).toEqual([])
    expect(h.log.byEvent('host.elevated-refused')).toEqual([
      expect.objectContaining({ level: 'error', subsystem: 'host' })
    ])
  })

  it('[S12.03, FM-011] an elevation that cannot be read is refused like an elevated start', async () => {
    const h = harness({
      privilege: { ...NOT_ELEVATED, elevated: { ok: false, cause: 'timed out after 5000 ms' } }
    })

    expect(await runBoot(h.realSteps, h.deps)).toEqual({
      kind: 'refused',
      refusal: 'ELEVATED_REFUSED'
    })
    expect(h.exits).toEqual([EXIT_CODES.ELEVATED_REFUSED])
    expect(h.log.byEvent('host.elevated-refused')).toEqual([
      expect.objectContaining({ level: 'error', causeClass: 'unreadable' })
    ])
    expect(h.log.byEvent('host.boot.step')).toEqual([])
  })

  it('[FM-012] an in-job Host records jobStatus in-job and logs host.job-status as degraded, and still boots', async () => {
    const h = harness({ privilege: { ...NOT_ELEVATED, inJob: { ok: true, value: true } } })

    expect(await runBoot(h.realSteps, h.deps)).toEqual({ kind: 'ready' })

    expect(h.log.byEvent('host.job-status')).toEqual([
      expect.objectContaining({ level: 'warn', subsystem: 'host', outcome: 'degraded' })
    ])
    expect(h.states).toEqual([
      { state: 'starting', jobStatus: 'in-job' },
      { state: 'ready', jobStatus: 'in-job' }
    ])
    expect(h.exits).toEqual([])
  })

  it('[FM-012] the job status is none outside a job, n/a off Windows, and in-job when it cannot be read', async () => {
    const cases: Array<[PrivilegeReport['inJob'], string, 'info' | 'warn']> = [
      [{ ok: true, value: false }, 'none', 'info'],
      ['not-applicable', 'n/a', 'info'],
      [{ ok: false, cause: 'exited with code 4' }, 'in-job', 'warn']
    ]
    for (const [inJob, jobStatus, level] of cases) {
      const h = harness({ privilege: { ...NOT_ELEVATED, inJob } })

      await runBoot(h.realSteps, h.deps)

      expect(
        h.states.map((report) => report.jobStatus),
        jobStatus
      ).toEqual([jobStatus, jobStatus])
      expect(h.log.byEvent('host.job-status'), jobStatus).toEqual([
        expect.objectContaining({ level })
      ])
    }
  })

  it('[ADR-002] a missing DWARFAI_HOST_DATA_DIR refuses to start with NO_DATA_DIR and a logged reason', async () => {
    const paths = EnvAppPaths.create({
      env: {},
      execPath: 'fake-install/DwarfAI-Miners',
      resourcesPath: undefined,
      isPackaged: false
    })
    const h = harness({ paths })

    const outcome = await runBoot(h.realSteps, h.deps)

    expect(outcome).toEqual({ kind: 'refused', refusal: 'NO_DATA_DIR' })
    expect(h.exits).toEqual([EXIT_CODES.NO_DATA_DIR])
    expect(h.log.byEvent('host.no-data-dir')).toEqual([
      expect.objectContaining({
        level: 'error',
        subsystem: 'host',
        causeClass: 'host-data-dir-missing'
      })
    ])
    expect(h.log.byEvent('host.boot.step')).toEqual([])
    expect(h.states).toEqual([])
  })

  it('[S12.02, FM-009] a bind step that finds a running Host exits ALREADY_RUNNING and logs host.already-running', async () => {
    const h = harness()
    const steps = withStep(h.realSteps, 'bind-endpoint', () =>
      Promise.resolve({ kind: 'refused', refusal: 'ALREADY_RUNNING' })
    )

    expect(await runBoot(steps, h.deps)).toEqual({ kind: 'refused', refusal: 'ALREADY_RUNNING' })

    expect(h.exits).toEqual([EXIT_CODES.ALREADY_RUNNING])
    expect(h.log.byEvent('host.already-running')).toEqual([
      expect.objectContaining({ level: 'info', subsystem: 'host' })
    ])
    expect(loggedSteps(h.log)).toEqual([])
    expect(h.states).toEqual([])
  })

  it('[FM-008] a step that throws stops the boot, logs an error record and exits non-zero', async () => {
    const h = harness()
    const later: string[] = []
    const steps = (paths: AppPaths): readonly BootStep[] =>
      withStep(h.realSteps, 'resume-reset-saga', () =>
        Promise.reject(Object.assign(new Error('journal unreadable'), { code: 'EIO' }))
      )(paths).map((step) =>
        BOOT_STEP_NAMES.indexOf(step.name) > BOOT_STEP_NAMES.indexOf('resume-reset-saga')
          ? {
              name: step.name,
              run: (context) => {
                later.push(step.name)
                return step.run(context)
              }
            }
          : step
      )

    const outcome = await runBoot(steps, h.deps)

    expect(outcome).toEqual({ kind: 'failed', step: 'resume-reset-saga' })
    expect(h.exits).toEqual([BOOT_FAILED_EXIT_CODE])
    expect(BOOT_FAILED_EXIT_CODE).not.toBe(0)
    expect(later).toEqual([])
    expect(h.log.byEvent('host.boot.step').at(-1)).toEqual(
      expect.objectContaining({
        level: 'error',
        subsystem: 'host',
        outcome: 'failed',
        errCode: 'EIO',
        msg: 'step resume-reset-saga failed'
      })
    )
    expect(h.states.map((report) => report.state)).toEqual(['starting'])
    expect(h.log.byEvent('host.ready')).toEqual([])
  })

  it('[ADR-002] the boot starts no idle-exit timer: with a FakeClock advanced 24 h after ready nothing ends the process', async () => {
    const h = harness()

    expect(await runBoot(h.realSteps, h.deps)).toEqual({ kind: 'ready' })
    h.clock.advance(DAY_MS)

    expect(h.scheduler.nextDueAt()).toBeNull()
    expect(h.scheduler.taskErrors).toEqual([])
    expect(h.exits).toEqual([])
    expect(h.states.at(-1)).toEqual({ state: 'ready', jobStatus: 'none' })
  })
})
