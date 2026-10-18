// layer: L2
// L2 (17 §1.2): the first-run consent step's one answer, 16 §4.12 `answerWelcome` (AMENDMENT-7,
// OQ-68; 07 S41.04, S41.05, S41.06 and S14.12…S14.16; ADR-016 items 5–7; 18 C-21, T-46; 13
// FM-149, FM-150), through the module's factories over a copy of the template database, the real
// config writer engine with both targets from step 4a (`claude-hooks` and `opencode-plugin`, 21 §2
// 4a) over FakeFs, the hand-written `settings.json` fixtures of ISSUE-220 and the plugin-folder
// world of ISSUE-227, the scripted installed detection and a recording bus that refuses a publish
// inside a transaction (16 §2.3). Each `boot` builds the step and its answer
// again over the same database and files, as a Host start does. It sits at the module root, beside
// createResetSaga.test.ts, because an application test may not reach the adapters (05 §5.1 R3).
import { describe, expect, it } from 'vitest'
import type { IntegrationId } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeFs } from '../../kernel/fakes/FakeFs'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { Scheduler } from '../../kernel/ports/scheduler'
import type { FileSystemSubject } from '../../kernel/testing/fileSystem.contract'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'
import { ClaudeHooksConfigWriter } from './adapters/external-config/claudeHooks/ClaudeHooksConfigWriter'
import { isLegacyHookCommand } from './adapters/external-config/claudeHooks/hookCommand'
import {
  claudeHooksWorld,
  fixture,
  INGRESS_PORT
} from './adapters/external-config/claudeHooks/testing/claudeHooksWorld'
import { ConfigWriterEngine } from './adapters/external-config/configWriterEngine'
import {
  OPENCODE_PLUGIN_FILE_NAME,
  OpenCodePluginConfigWriter
} from './adapters/external-config/openCodePlugin/OpenCodePluginConfigWriter'
import {
  INSTALL_ID,
  openCodePluginWorld
} from './adapters/external-config/openCodePlugin/testing/openCodePluginWorld'
import { SqliteChannelTokenStore } from './adapters/sqlite/SqliteChannelTokenStore'
import { SqliteConfigWriteLedger } from './adapters/sqlite/SqliteConfigWriteLedger'
import { SqliteIntegrationSettingStore } from './adapters/sqlite/SqliteIntegrationSettingStore'
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

/** Scheduled retries run at once: no real timer in an L2 test (17 §2.2). */
const immediateScheduler: Scheduler = {
  after(_ms, task) {
    queueMicrotask(task)
    return { cancel: () => undefined }
  }
}

/**
 * One OS user's machine: Claude Code's settings, OpenCode's plugin folder, the Host database and
 * the installed tools.
 */
async function machine(installed: readonly IntegrationId[] = ['claude-hooks']) {
  const { db } = openTemplateCopy()
  const storage = memory()
  const files = await claudeHooksWorld(storage, db)
  const plugin = await openCodePluginWorld(storage, db)
  const tools = new FakeInstalledToolsReader()
  tools.script(installed)
  const transactions = new SqliteTransactionRunner(db)
  const bus = new RecordingEventBus<PreferencesEvent>({ transactionScope: transactions })
  const clock = new FakeClock(T0)
  const ids = new SequenceIdGenerator()
  // The Host's one config writer with both targets, as the Host composes it from step 4a (16 §7.1),
  // over the scripted file system of Claude Code's world, so its locks, crashes and recorded
  // writes cover both tools' files.
  const writer = new ConfigWriterEngine({
    fs: files.fs,
    transactions,
    ledger: new SqliteConfigWriteLedger({ db }),
    settings: new SqliteIntegrationSettingStore({ db }),
    tokens: new SqliteChannelTokenStore({ db, ids }),
    clock,
    ids,
    scheduler: immediateScheduler,
    log: new RecordingDiagnosticsLog(),
    targets: [
      new ClaudeHooksConfigWriter({
        path: files.path,
        platform: 'linux',
        ingressPort: () => INGRESS_PORT
      }),
      new OpenCodePluginConfigWriter({
        path: plugin.path,
        installId: INSTALL_ID,
        ingressPort: () => INGRESS_PORT
      })
    ]
  })

  /** One Host start: the module, the step evaluated at boot, and its answer. */
  async function boot() {
    const common = { db, transactions, bus, clock, ids, hostEpoch: EPOCH }
    const preferences = createPreferences({
      ...common,
      featureFlags: new FakeFeatureFlagReader(),
      externalConfig: writer,
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
      externalConfig: writer
    })
    await step.evaluateWelcomeAtBoot()
    const answer = createWelcomeAnswer({
      ...common,
      step,
      preferences,
      externalConfig: writer
    })
    return { preferences, step, answer }
  }

  return {
    files,
    plugin,
    writer,
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
const SETTLED_BOTH = { due: false, legacyFound: [], offered: BOTH }

describe('answering the first-run consent step (07 machine 41; 16 §4.12 answerWelcome)', () => {
  it('[US-SET-012.AC02, S41.04] Activate with both ticked writes the Claude hook entry and the plugin file, both with origin first-run, and both integrations read on', async () => {
    const m = await machine(BOTH)
    await m.files.seed(fixture('foreign-only.settings'))
    const { answer, step, preferences } = await m.boot()
    expect(step.welcome()).toStrictEqual({
      due: true,
      reason: 'first-run',
      legacyFound: [],
      offered: BOTH
    })

    const result = await answer.answerWelcome({ claudeHooks: true, openCodePermissions: true })

    expect(result).toStrictEqual({
      'claude-hooks': { state: 'on-verified' },
      'opencode-permissions': { state: 'on-verified' }
    })
    expect(m.files.setting()).toMatchObject({ state: 'on-verified', consentOrigin: 'first-run' })
    expect(m.plugin.setting()).toMatchObject({ state: 'on-verified', consentOrigin: 'first-run' })
    expect(
      m.plugin
        .rows()
        .map((row) => `${String(row['kind'])} ${String(row['consent_origin'])}`)
        .sort()
    ).toStrictEqual(['claude-hooks first-run', 'opencode-plugin first-run'])
    expect(await m.writer.verify('claude-hooks')).toBe('verified')
    expect(await m.writer.verify('opencode-plugin')).toBe('verified')
    expect(Object.keys(await m.plugin.folder())).toStrictEqual([OPENCODE_PLUGIN_FILE_NAME])
    // Settings › Integrations reads both toggles on (14 §3.6 `PreferencesView.integrations`).
    expect(
      preferences.queries.integrationSettings().map((setting) => [setting.id, setting.state])
    ).toStrictEqual([
      ['claude-hooks', 'on-verified'],
      ['opencode-permissions', 'on-verified']
    ])
    // In the step order: `claude-hooks`, then `opencode-permissions` (16 §4.12 `answerWelcome`).
    expect(m.events('IntegrationChanged')).toStrictEqual([
      { id: 'claude-hooks', state: 'on-verified' },
      { id: 'opencode-permissions', state: 'on-verified' }
    ])
    expect(step.welcome()).toStrictEqual(SETTLED_BOTH)
    expect(m.answeredAt()).toBe(T0)
  })

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
    expect(await m.plugin.folder()).toStrictEqual({})
    expect(m.events('IntegrationChanged')).toStrictEqual([
      { id: 'claude-hooks', state: 'on-verified' }
    ])
    expect(step.welcome()).toStrictEqual(SETTLED_BOTH)
    expect(m.events('WelcomeStepChanged').at(-1)).toStrictEqual({ state: SETTLED_BOTH })
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
      expect(await m.writer.findLegacy('claude-hooks')).toBe(false)
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
      expect(await m.writer.findLegacy('claude-hooks')).toBe(false)
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
    expect(step.welcome()).toStrictEqual(SETTLED_BOTH)
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
    await m.writer.settleUnverified()
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
    // OpenCode is not installed, so the step does not offer it (ADR-016 item 5: installed tools only).
    const m = await machine(['claude-hooks'])
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
