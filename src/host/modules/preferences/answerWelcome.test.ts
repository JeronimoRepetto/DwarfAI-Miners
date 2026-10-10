// layer: L2
// L2 (17 §1.2): the first-run consent step's one answer, 16 §4.12 `answerWelcome` (AMENDMENT-7,
// OQ-68; 07 S41.04, S41.05, S41.06 and S14.12…S14.16; ADR-016 items 5–7; 18 C-21, T-46; 13
// FM-149, FM-150), through the module's factories over a copy of the template database, the real
// config writer engine with the `claude-hooks` target over FakeFs and the hand-written
// `settings.json` fixtures of ISSUE-220, the scripted installed detection and a recording bus that
// refuses a publish inside a transaction (16 §2.3). Each `boot` builds the step and its answer
// again over the same database and files, as a Host start does. It sits at the module root, beside
// createResetSaga.test.ts, because an application test may not reach the adapters (05 §5.1 R3).
import { describe, expect, it } from 'vitest'
import type { IntegrationId } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeFs } from '../../kernel/fakes/FakeFs'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { FileSystemSubject } from '../../kernel/testing/fileSystem.contract'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'
import { isLegacyHookCommand } from './adapters/external-config/claudeHooks/hookCommand'
import {
  claudeHooksWorld,
  fixture
} from './adapters/external-config/claudeHooks/testing/claudeHooksWorld'
import { SimulatedCrash } from './testing/ScriptedToolFs'
import { drawToken, hashOf } from './testing/inMemoryChannelTokens'
import { SqliteWelcomeAnswerStore } from './adapters/SqliteWelcomeAnswerStore'
import type { PreferencesEvent } from './domain/events'
import { FakeFeatureFlagReader } from './ports/fakes/FakeFeatureFlagReader'
import { FakeInstalledToolsReader } from './ports/fakes/FakeInstalledToolsReader'
import { createPreferences, createWelcomeAnswer, createWelcomeStep } from './index'

const T0 = 1_760_000_000_000
const EPOCH = 'epoch-0223'
const BOTH: IntegrationId[] = ['claude-hooks', 'opencode-permissions']

function memory(): FileSystemSubject {
  const fs = new FakeFs()
  return {
    fs,
    pathOf: (...segments) => ['/home/j', ...segments].join('/'),
    seed: async (path, content) => fs.addFile(path, content)
  }
}

interface Handler {
  command?: unknown
}
type Settings = { hooks?: Record<string, Array<{ hooks: Handler[] }>> }

/** Every hook command of the file, in file order. */
function commandsOf(text: string | null): unknown[] {
  const settings = JSON.parse(text ?? '{}') as Settings
  return Object.values(settings.hooks ?? {}).flatMap((groups) =>
    groups.flatMap((group) => group.hooks.map((handler) => handler.command))
  )
}

/** One OS user's machine: Claude Code's settings, the Host database and the installed tools. */
async function machine(installed: readonly IntegrationId[] = ['claude-hooks']) {
  const { db } = openTemplateCopy()
  const files = await claudeHooksWorld(memory(), db)
  const tools = new FakeInstalledToolsReader()
  tools.script(installed)
  const transactions = new SqliteTransactionRunner(db)
  const bus = new RecordingEventBus<PreferencesEvent>({ transactionScope: transactions })
  const clock = new FakeClock(T0)
  const ids = new SequenceIdGenerator()

  /** One Host start: the module, the step evaluated at boot, and its answer. */
  async function boot() {
    const common = { db, transactions, bus, clock, ids, hostEpoch: EPOCH }
    const preferences = createPreferences({
      ...common,
      featureFlags: new FakeFeatureFlagReader(),
      externalConfig: files.writer,
      mintCredential: () => {
        const value = drawToken()
        return { value, sha256: hashOf(value) }
      }
    })
    const step = createWelcomeStep({
      db,
      bus,
      clock,
      ids,
      hostEpoch: EPOCH,
      installedTools: tools,
      externalConfig: files.writer
    })
    await step.evaluateWelcomeAtBoot()
    const answer = createWelcomeAnswer({
      ...common,
      step,
      preferences,
      externalConfig: files.writer
    })
    return { preferences, step, answer }
  }

  return {
    files,
    bus,
    clock,
    boot,
    answeredAt: () => new SqliteWelcomeAnswerStore({ db }).answeredAt(),
    /** Every whole-file write that reached `settings.json` (backups are other paths). */
    settingsWrites: () => files.fs.writes.filter((path) => path === files.path),
    events: (type: PreferencesEvent['type']) =>
      bus.published.filter((event) => event.type === type).map((event) => event.payload)
  }
}

const SETTLED = { due: false, legacyFound: [], offered: ['claude-hooks'] }

describe('answering the first-run consent step (07 machine 41; 16 §4.12 answerWelcome)', () => {
  it('[US-SET-012.AC03, S41.04] Activate with one option unticked turns on only the ticked one with origin first-run and writes nothing for the other', async () => {
    const m = await machine(BOTH)
    const original = fixture('foreign-only.settings')
    await m.files.seed(original)
    const { answer, step } = await m.boot()

    const result = await answer.answerWelcome({ claudeHooks: true, openCodePermissions: false })

    expect(result).toStrictEqual({
      'claude-hooks': { state: 'on-verified' },
      'opencode-permissions': { state: 'off' }
    })
    expect(m.files.setting()).toMatchObject({ state: 'on-verified', consentOrigin: 'first-run' })
    // Only Claude Code's settings were written; no other tool's file was touched.
    expect(m.files.fs.writes.length).toBeGreaterThan(0)
    expect(m.files.fs.writes.every((path) => path.startsWith('/home/j/.claude/'))).toBe(true)
    expect(m.events('IntegrationChanged')).toStrictEqual([
      { id: 'claude-hooks', state: 'on-verified' }
    ])
    expect(step.welcome()).toStrictEqual(SETTLED)
    expect(m.events('WelcomeStepChanged').at(-1)).toStrictEqual({ state: SETTLED })
    expect(m.answeredAt()).toBe(T0)
  })

  describe('T-46 old-app entries (18 §4.5)', () => {
    it("[US-SET-012.AC04, S14.16] an old-app entry of a ticked option is replaced by DwarfAI's own after one backup", async () => {
      const m = await machine()
      const original = fixture('foreign-and-old-app.settings')
      await m.files.seed(original)
      const { answer, step } = await m.boot()
      expect(step.welcome()).toMatchObject({ due: true, reason: 'legacy-entries' })

      const result = await answer.answerWelcome({ claudeHooks: true, openCodePermissions: true })

      expect(result['claude-hooks']).toStrictEqual({ state: 'on-verified' })
      const written = await m.files.read()
      expect(commandsOf(written).some(isLegacyHookCommand)).toBe(false)
      expect(commandsOf(written)).toEqual(
        expect.arrayContaining(commandsOf(original).filter((c) => !isLegacyHookCommand(c)))
      )
      expect((await m.files.backups()).map((backup) => backup.text)).toStrictEqual([original])
      expect(m.files.setting()).toMatchObject({ state: 'on-verified', consentOrigin: 'first-run' })
      expect(await m.files.writer.findLegacy('claude-hooks')).toBe(false)
      expect(step.welcome()).toStrictEqual(SETTLED)
    })

    it('[US-SET-012.AC04, S14.12] an old-app entry of an unticked option is removed with foreign bytes identical', async () => {
      const m = await machine()
      const original = fixture('foreign-and-old-app.settings')
      await m.files.seed(original)
      const { answer, step } = await m.boot()

      const result = await answer.answerWelcome({ claudeHooks: false, openCodePermissions: false })

      expect(result).toStrictEqual({
        'claude-hooks': { state: 'off' },
        'opencode-permissions': { state: 'off' }
      })
      expect(await m.files.read()).toBe(fixture('foreign-and-old-app.reverted.settings'))
      expect((await m.files.backups()).map((backup) => backup.text)).toStrictEqual([original])
      expect(await m.files.writer.findLegacy('claude-hooks')).toBe(false)
      expect(m.files.setting().state).toBe('off')
      expect(m.events('IntegrationChanged')).toStrictEqual([{ id: 'claude-hooks', state: 'off' }])
      expect(step.welcome()).toStrictEqual(SETTLED)
      expect(m.answeredAt()).toBe(T0)
    })

    it('[S41.05, FM-149] a locked old-app entry leaves it in place, reports config-revert-failed and still settles the step', async () => {
      const m = await machine()
      const original = fixture('foreign-and-old-app.settings')
      await m.files.seed(original)
      const { answer, step } = await m.boot()
      m.files.fs.lock(m.files.path)

      const result = await answer.answerWelcome({ claudeHooks: false, openCodePermissions: false })

      expect(result).toStrictEqual({
        'claude-hooks': { state: 'off', failure: 'config-revert-failed' },
        'opencode-permissions': { state: 'off' }
      })
      expect(await m.files.read()).toBe(original)
      expect(m.events('IntegrationChanged')).toStrictEqual([{ id: 'claude-hooks', state: 'off' }])
      expect(step.welcome()).toStrictEqual(SETTLED)
      expect(m.events('WelcomeStepChanged').at(-1)).toStrictEqual({ state: SETTLED })
      expect(m.answeredAt()).toBe(T0)

      // The entry is still there, so the next boot shows the step again (07 S41.02, S14.13).
      m.files.fs.lock(m.files.path, false)
      const next = await m.boot()
      expect(next.step.welcome()).toMatchObject({ due: true, reason: 'legacy-entries' })
    })
  })

  it('[US-SET-012.AC06, S14.14] Activate with both unticked writes nothing, turns nothing on and ends the step', async () => {
    const m = await machine(BOTH)
    const original = fixture('foreign-only.settings')
    await m.files.seed(original)
    const { answer, step } = await m.boot()
    const before = m.bus.published.length

    const result = await answer.answerWelcome({ claudeHooks: false, openCodePermissions: false })

    expect(result).toStrictEqual({
      'claude-hooks': { state: 'off' },
      'opencode-permissions': { state: 'off' }
    })
    expect(await m.files.read()).toBe(original)
    expect(m.files.fs.writes).toStrictEqual([])
    expect(await m.files.backups()).toStrictEqual([])
    expect(m.bus.published.slice(before).map((event) => event.type)).toStrictEqual([
      'WelcomeStepChanged'
    ])
    expect(step.welcome()).toStrictEqual(SETTLED)
    expect(m.answeredAt()).toBe(T0)
  })

  it('[S14.15] an integration already on stays on whatever its tick', async () => {
    for (const claudeHooks of [false, true]) {
      const m = await machine()
      await m.files.seed(fixture('foreign-only.settings'))
      const { preferences, answer } = await m.boot()
      expect(await preferences.commands.setClaudeHooks(true, 'settings')).toMatchObject({
        ok: true
      })
      const written = await m.files.read()
      const writes = m.settingsWrites().length

      const result = await answer.answerWelcome({ claudeHooks, openCodePermissions: false })

      expect(result['claude-hooks']).toStrictEqual({ state: 'on-verified' })
      expect(m.files.setting()).toMatchObject({ state: 'on-verified', consentOrigin: 'settings' })
      expect(await m.files.read()).toBe(written)
      expect(m.settingsWrites()).toHaveLength(writes)
      expect(m.answeredAt()).toBe(T0)
    }
  })

  it('[S41.06, FM-150, CH-01] a Host killed while answering shows the step again and nothing is written twice', async () => {
    const m = await machine()
    const original = fixture('foreign-and-old-app.settings')
    await m.files.seed(original)
    const first = await m.boot()
    m.files.fs.crashAt(m.files.path, 'after-write')

    await expect(
      first.answer.answerWelcome({ claudeHooks: true, openCodePermissions: false })
    ).rejects.toThrow(SimulatedCrash)
    expect(m.answeredAt()).toBeNull()
    const landed = await m.files.read()

    // The next Host start settles the half-done write first (07 S14.11), then evaluates the step.
    await m.files.writer.settleUnverified()
    const next = await m.boot()
    expect(next.step.welcome()).toStrictEqual({
      due: true,
      reason: 'first-run',
      legacyFound: [],
      offered: ['claude-hooks']
    })
    expect(m.files.setting()).toMatchObject({ state: 'on-verified', consentOrigin: 'first-run' })
    const writes = m.settingsWrites().length

    const result = await next.answer.answerWelcome({
      claudeHooks: true,
      openCodePermissions: false
    })

    expect(result['claude-hooks']).toStrictEqual({ state: 'on-verified' })
    expect(m.settingsWrites()).toHaveLength(writes)
    expect(await m.files.read()).toBe(landed)
    expect((await m.files.backups()).map((backup) => backup.text)).toStrictEqual([original])
    expect(next.step.welcome()).toStrictEqual(SETTLED)
    expect(m.answeredAt()).toBe(T0)
  })

  it('[ADR-016] a true for an option not in offered is treated as false', async () => {
    // Cuts 2 to 3e offer Claude Code only (domain/offeredFilter.ts): OpenCode is installed, hidden.
    const m = await machine(BOTH)
    await m.files.seed(fixture('foreign-only.settings'))
    const { answer, step } = await m.boot()
    expect(step.welcome().offered).toStrictEqual(['claude-hooks'])

    const result = await answer.answerWelcome({ claudeHooks: false, openCodePermissions: true })

    expect(result).toStrictEqual({
      'claude-hooks': { state: 'off' },
      'opencode-permissions': { state: 'off' }
    })
    expect(m.files.fs.writes).toStrictEqual([])
    expect(m.events('IntegrationChanged')).toStrictEqual([])
    expect(step.welcome()).toStrictEqual(SETTLED)
  })

  it('[S41.04, S41.05] answers run one at a time, and an answer after the step settled is a no-op returning the current states', async () => {
    const m = await machine()
    await m.files.seed(fixture('foreign-only.settings'))
    const { answer, step } = await m.boot()

    const [first, second] = await Promise.all([
      answer.answerWelcome({ claudeHooks: true, openCodePermissions: false }),
      answer.answerWelcome({ claudeHooks: false, openCodePermissions: false })
    ])

    expect(first['claude-hooks']).toStrictEqual({ state: 'on-verified' })
    expect(second).toStrictEqual(first)
    expect(m.files.setting().state).toBe('on-verified')
    expect(m.events('IntegrationChanged')).toHaveLength(1)
    expect(m.events('WelcomeStepChanged')).toHaveLength(2)

    const writes = m.settingsWrites().length
    m.clock.advance(1_000)
    const later = await answer.answerWelcome({ claudeHooks: false, openCodePermissions: false })
    expect(later).toStrictEqual(first)
    expect(m.settingsWrites()).toHaveLength(writes)
    expect(m.answeredAt()).toBe(T0)
    expect(step.welcome()).toStrictEqual(SETTLED)
  })
})
