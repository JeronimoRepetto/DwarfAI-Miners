// layer: L2
// L2 (17 §1.2): the first-run consent step's boot evaluation (07 machine 41; 16 §4.12
// `PreferencesQueries.welcome`, `WelcomeStepChanged`; ADR-016 item 5; 18 C-21, T-46) over the
// in-memory answer store (whose Reset clear the WelcomeAnswerStore contract proves equal to the
// SQLite adapter's over the template database), the scripted installed detection, the
// scripted config writer (whose `findLegacy` calls are recorded here) and a recording bus.
import { describe, expect, it } from 'vitest'
import type { IntegrationId } from '../../../kernel/domain/values'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { PreferencesEvent } from '../domain/events'
import { OFFERED_FILTER } from '../domain/offeredFilter'
import type { ConfigTarget } from '../ports/externalConfigWriter'
import { FakeExternalConfigWriter } from '../ports/fakes/FakeExternalConfigWriter'
import { FakeInstalledToolsReader } from '../ports/fakes/FakeInstalledToolsReader'
import { InMemoryWelcomeAnswerStore } from '../ports/fakes/InMemoryWelcomeAnswerStore'
import type { WelcomeAnswerStore } from '../ports/welcomeAnswerStore'
import { WelcomeStepService } from './preferencesService'

const T0 = 1_750_000_000_000
const EPOCH = 'epoch-0222'
const BOTH: IntegrationId[] = ['claude-hooks', 'opencode-permissions']

/** The scripted writer, recording which targets the legacy check asked about. */
class RecordingLegacyWriter extends FakeExternalConfigWriter {
  readonly legacyChecks: ConfigTarget[] = []

  override findLegacy(target: ConfigTarget): Promise<boolean> {
    this.legacyChecks.push(target)
    return super.findLegacy(target)
  }
}

interface World {
  answers: WelcomeAnswerStore
  installed: FakeInstalledToolsReader
  writer: RecordingLegacyWriter
  bus: RecordingEventBus<PreferencesEvent>
}

function world(answers: WelcomeAnswerStore = new InMemoryWelcomeAnswerStore()): World {
  return {
    answers,
    installed: new FakeInstalledToolsReader(),
    writer: new RecordingLegacyWriter(),
    bus: new RecordingEventBus<PreferencesEvent>()
  }
}

/** One Host boot over `w`: a new service, as each Host start builds the module. */
function boot(w: World): WelcomeStepService {
  return new WelcomeStepService({
    answers: w.answers,
    installed: w.installed,
    legacy: w.writer,
    cutFilter: OFFERED_FILTER.offered,
    bus: w.bus,
    clock: new FakeClock(T0),
    ids: new SequenceIdGenerator(),
    hostEpoch: EPOCH
  })
}

const changes = (w: World) =>
  w.bus.published.flatMap((event) =>
    event.type === 'WelcomeStepChanged' ? [event.payload.state] : []
  )

/** Nothing was written or reverted in any tool, and nothing was answered. */
function expectNothingTouched(w: World): void {
  expect(w.writer.installs).toStrictEqual([])
  expect(w.writer.reverts).toStrictEqual([])
  expect(w.writer.installed('claude-hooks')).toBe(false)
  expect(w.writer.installed('opencode-plugin')).toBe(false)
}

describe('first-run consent step at boot (07 machine 41)', () => {
  it('[US-SET-012.AC05, S41.07] after Reset metrics the next boot makes the step due with reason first-run and every offered option', async () => {
    const answers = new InMemoryWelcomeAnswerStore()
    answers.setAnsweredAt(T0)
    const w = world(answers)
    w.installed.script(BOTH)

    expect(await boot(w).evaluateWelcomeAtBoot()).toStrictEqual({
      due: false,
      legacyFound: [],
      offered: ['claude-hooks']
    })

    // The Reset saga's `db` step (SqliteResetJournal, 07 S13.01) clears the answer with the epoch bump.
    answers.restore(null)
    const next = boot(w)
    const due = { due: true, reason: 'first-run', legacyFound: [], offered: ['claude-hooks'] }
    expect(await next.evaluateWelcomeAtBoot()).toStrictEqual(due)
    expect(next.welcome()).toStrictEqual(due)
    expect(changes(w).at(-1)).toStrictEqual(due)
    expectNothingTouched(w)
  })

  it('[US-SET-012.AC07] with only one tool installed offered lists only that tool and nothing is written', async () => {
    const w = world()
    w.installed.script(['claude-hooks'])

    const service = boot(w)
    const state = await service.evaluateWelcomeAtBoot()

    expect(state).toStrictEqual({
      due: true,
      reason: 'first-run',
      legacyFound: [],
      offered: ['claude-hooks']
    })
    expect(service.welcome()).toStrictEqual(state)
    expect(w.answers.answeredAt()).toBeNull()
    expectNothingTouched(w)
  })

  it('[US-SET-012.AC08, S41.09] with neither tool installed the step is not due, offered is empty and it is not answered, so a later boot with one installed makes it due', async () => {
    const w = world()

    const skipped = boot(w)
    expect(await skipped.evaluateWelcomeAtBoot()).toStrictEqual({
      due: false,
      legacyFound: [],
      offered: []
    })
    expect(skipped.welcome()).toStrictEqual({ due: false, legacyFound: [], offered: [] })
    expect(w.answers.answeredAt()).toBeNull()
    expect(w.writer.legacyChecks).toStrictEqual([])
    expect(changes(w)).toStrictEqual([])
    expectNothingTouched(w)

    w.installed.script(['claude-hooks'])
    expect(await boot(w).evaluateWelcomeAtBoot()).toStrictEqual({
      due: true,
      reason: 'first-run',
      legacyFound: [],
      offered: ['claude-hooks']
    })
  })

  it('[S41.03] an answered step with no old-app entry is not offered again at the next boot', async () => {
    const w = world()
    w.answers.setAnsweredAt(T0)
    w.installed.script(['claude-hooks'])

    expect(await boot(w).evaluateWelcomeAtBoot()).toStrictEqual({
      due: false,
      legacyFound: [],
      offered: ['claude-hooks']
    })
  })

  it('[S41.01, S41.02] WelcomeStepChanged is published when the evaluated state changes, and never again for the same state', async () => {
    const w = world()
    w.installed.script(['claude-hooks'])
    const service = boot(w)

    await service.evaluateWelcomeAtBoot()
    await service.evaluateWelcomeAtBoot()

    const due = { due: true, reason: 'first-run', legacyFound: [], offered: ['claude-hooks'] }
    expect(changes(w)).toStrictEqual([due])
    expect(w.bus.published).toHaveLength(1)
    expect(w.bus.published[0]).toMatchObject({
      type: 'WelcomeStepChanged',
      v: 1,
      at: T0,
      hostEpoch: EPOCH
    })
  })

  describe('T-46 old-app entries (18 §4.5)', () => {
    it('[S41.02, ADR-016] an old-app Claude hook entry makes the step due with reason legacy-entries and lists it', async () => {
      const w = world()
      w.answers.setAnsweredAt(T0)
      w.installed.script(['claude-hooks'])
      w.writer.plantLegacy('claude-hooks')

      expect(await boot(w).evaluateWelcomeAtBoot()).toStrictEqual({
        due: true,
        reason: 'legacy-entries',
        legacyFound: ['claude-hooks'],
        offered: ['claude-hooks']
      })
      // Never adopted silently: the old entry is still the old app's, DwarfAI owns nothing.
      expect(await w.writer.findLegacy('claude-hooks')).toBe(true)
      expect(w.answers.answeredAt()).toBe(T0)
      expectNothingTouched(w)
    })

    it('[ADR-016] in cuts 2 to 3e OpenCode is never offered and an old-app OpenCode plugin file alone does not make the step due', async () => {
      const w = world()
      w.answers.setAnsweredAt(T0)
      w.installed.script(BOTH)
      w.writer.plantLegacy('opencode-plugin')

      expect(await boot(w).evaluateWelcomeAtBoot()).toStrictEqual({
        due: false,
        legacyFound: [],
        offered: ['claude-hooks']
      })
      expect(w.writer.legacyChecks).toStrictEqual(['claude-hooks'])

      // Only OpenCode installed, never answered: nothing is offered, so nothing is checked either.
      const onlyOpenCode = world()
      onlyOpenCode.installed.script(['opencode-permissions'])
      onlyOpenCode.writer.plantLegacy('opencode-plugin')
      expect(await boot(onlyOpenCode).evaluateWelcomeAtBoot()).toStrictEqual({
        due: false,
        legacyFound: [],
        offered: []
      })
      expect(onlyOpenCode.writer.legacyChecks).toStrictEqual([])
      expect(onlyOpenCode.answers.answeredAt()).toBeNull()
    })

    it('[ADR-016] evaluating the step writes and reverts nothing in any tool', async () => {
      const w = world()
      w.installed.script(BOTH)
      w.writer.plantLegacy('claude-hooks')
      w.writer.plantLegacy('opencode-plugin')

      const state = await boot(w).evaluateWelcomeAtBoot()

      expect(state.due).toBe(true)
      expectNothingTouched(w)
      expect(await w.writer.findLegacy('claude-hooks')).toBe(true)
      expect(await w.writer.findLegacy('opencode-plugin')).toBe(true)
      expect(w.answers.answeredAt()).toBeNull()
    })
  })
})
