// layer: L2
// L2 (17 §1.2): `PreferencesCommands.setOpenCodePermissions` (16 §4.12; 16 §7.3, §7.4; 07 machine 14
// S14.02, S14.04, S14.06; ADR-011 item 7; ADR-016 items 1, 5–7; UC-028; 13 FM-124, FM-125) over the
// real config writer engine with the `opencode-plugin` target (ISSUE-227) on FakeFs, its plugin-folder
// fixtures, the Host database's integration settings and channel token stores, and a recording bus
// that refuses a publish inside a transaction (16 §2.3).
//
// TC-228-01 (on writes and verifies the file with its origin, `IntegrationChanged` before the answer;
// off removes it at once), TC-228-02 (a fresh install is off with no file), TC-228-04 (a password
// change leaves the toggle as it is).
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeFs } from '../../kernel/fakes/FakeFs'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { FileSystemSubject } from '../../kernel/testing/fileSystem.contract'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'
import { OPENCODE_PLUGIN_FILE_NAME } from './adapters/external-config/openCodePlugin/OpenCodePluginConfigWriter'
import {
  fixture,
  FOREIGN_PLUGIN_NAME,
  openCodePluginWorld
} from './adapters/external-config/openCodePlugin/testing/openCodePluginWorld'
import { SqliteChannelTokenStore } from './adapters/sqlite/SqliteChannelTokenStore'
import { SqliteIntegrationSettingStore } from './adapters/sqlite/SqliteIntegrationSettingStore'
import type { PreferencesEvent } from './domain/events'
import { FakeFeatureFlagReader } from './ports/fakes/FakeFeatureFlagReader'
import { FakeSecretStore } from './ports/fakes/FakeSecretStore'
import { InMemoryPreferencesStore } from './ports/fakes/InMemoryPreferencesStore'
import { drawToken, hashOf } from './testing/inMemoryChannelTokens'
import { PreferencesService, type MintedCredential } from './application/preferencesService'

const T0 = 1_760_000_000_000
const EPOCH = 'epoch-0228'
const OPENCODE = 'opencode-permissions'

function memory(): FileSystemSubject {
  const fs = new FakeFs()
  return {
    fs,
    pathOf: (...segments) => ['/home/j', ...segments].join('/'),
    seed: async (path, content) => fs.addFile(path, content)
  }
}

async function world() {
  const { db } = openTemplateCopy()
  const plugin = await openCodePluginWorld(memory(), db)
  const transactions = new SqliteTransactionRunner(db)
  const settings = new SqliteIntegrationSettingStore({ db })
  const tokens = new SqliteChannelTokenStore({ db, ids: new SequenceIdGenerator() })
  const bus = new RecordingEventBus<PreferencesEvent>({ transactionScope: transactions })
  const minted: MintedCredential[] = []
  const preferences = new PreferencesService({
    store: new InMemoryPreferencesStore(),
    transactions,
    bus,
    clock: new FakeClock(T0),
    ids: new SequenceIdGenerator(),
    hostEpoch: EPOCH,
    featureFlags: new FakeFeatureFlagReader(),
    integrations: settings,
    tokens,
    externalConfig: plugin.writer,
    mintCredential: () => {
      const value = drawToken()
      const credential = { value, sha256: hashOf(value) }
      minted.push(credential)
      return credential
    }
  })
  const changes = () => bus.ofType('IntegrationChanged').map((event) => ({ ...event.payload }))
  return { plugin, preferences, settings, tokens, bus, minted, changes }
}

describe('PreferencesCommands.setOpenCodePermissions (16 §4.12; ADR-011 item 7)', () => {
  it('[US-SET-009.AC07, INV-106, NFR-SEC-10] a fresh install reads off and no plugin file exists', async () => {
    const w = await world()

    expect(w.preferences.integrationState(OPENCODE)).toBe('off')
    expect(
      w.preferences.integrationSettings().find((setting) => setting.id === OPENCODE)
    ).toMatchObject({ state: 'off' })
    expect(w.preferences.integrationSettings().find((s) => s.id === OPENCODE)?.consentOrigin).toBe(
      undefined
    )
    expect(await w.plugin.read()).toBeNull()
    expect(await w.plugin.folder()).toStrictEqual({})
    expect(w.tokens.active('opencode-plugin')).toBeNull()
  })

  it('[US-LAUNCH-001.AC13, S14.02] the add-panel enable writes the plugin file, records origin add-panel and publishes IntegrationChanged on-verified before it returns', async () => {
    const w = await world()
    let publishedBeforeAnswer: unknown[] = []

    const result = await w.preferences.setOpenCodePermissions(true, 'add-panel').then((answer) => {
      publishedBeforeAnswer = w.changes()
      return answer
    })

    expect(result).toStrictEqual({ ok: true, value: { state: 'on-verified' } })
    expect(publishedBeforeAnswer).toStrictEqual([{ id: OPENCODE, state: 'on-verified' }])
    expect(w.settings.get(OPENCODE)).toMatchObject({
      state: 'on-verified',
      consentOrigin: 'add-panel'
    })
    expect(w.plugin.rows()).toMatchObject([
      { kind: 'opencode-plugin', consent_origin: 'add-panel' }
    ])
    // The plaintext token is in the written file only; the store holds its hash (ADR-016 item 1).
    const [credential] = w.minted
    expect(await w.plugin.read()).toContain(credential?.value)
    expect(w.tokens.active('opencode-plugin')).toStrictEqual({ hash: credential?.sha256 })
    expect(Object.keys(await w.plugin.folder())).toStrictEqual([OPENCODE_PLUGIN_FILE_NAME])
  })

  it('[US-SET-009.AC02, US-SET-009.AC08, S14.06] turning it off removes the plugin file at once with no confirmation step', async () => {
    const w = await world()
    await w.plugin.seed(fixture('foreign-plugin.plugin'), FOREIGN_PLUGIN_NAME)
    await w.preferences.setOpenCodePermissions(true, 'settings')

    const result = await w.preferences.setOpenCodePermissions(false, 'settings')

    expect(result).toStrictEqual({ ok: true, value: { state: 'off' } })
    expect(await w.plugin.read()).toBeNull()
    // Nothing of the app is left in the folder; the person's own plugin is untouched.
    expect(await w.plugin.folder()).toStrictEqual({
      [FOREIGN_PLUGIN_NAME]: fixture('foreign-plugin.plugin')
    })
    expect(w.settings.get(OPENCODE).state).toBe('off')
    expect(w.tokens.active('opencode-plugin')).toBeNull()
    expect(w.changes()).toStrictEqual([
      { id: OPENCODE, state: 'on-verified' },
      { id: OPENCODE, state: 'off' }
    ])
  })

  it("[US-SET-009.AC06] saving, replacing or clearing the server password leaves the toggle's state unchanged", async () => {
    const w = await world()
    const secrets = new FakeSecretStore()
    await w.preferences.setOpenCodePermissions(true, 'settings')
    const file = await w.plugin.read()

    await secrets.set('opencode-password', 'first-password')
    expect(w.preferences.integrationState(OPENCODE)).toBe('on-verified')
    await secrets.set('opencode-password', 'second-password')
    expect(w.preferences.integrationState(OPENCODE)).toBe('on-verified')
    await secrets.delete('opencode-password')
    expect(w.preferences.integrationState(OPENCODE)).toBe('on-verified')
    expect(await w.plugin.read()).toBe(file)

    // The other way round: the toggle never touches the password.
    await secrets.set('opencode-password', 'kept-password')
    await w.preferences.setOpenCodePermissions(false, 'settings')
    expect(await secrets.get('opencode-password')).toBe('kept-password')
    expect(secrets.deleted).toStrictEqual(['opencode-password'])
  })

  it('[FM-124, S14.04] a failed write leaves it off and answers config-write-failed', async () => {
    const w = await world()
    const notOurs = fixture('foreign-same-name.plugin')
    await w.plugin.seed(notOurs)

    const result = await w.preferences.setOpenCodePermissions(true, 'add-panel')

    expect(result).toStrictEqual({ ok: false, error: 'config-write-failed' })
    expect(w.settings.get(OPENCODE).state).toBe('off')
    expect(await w.plugin.read()).toBe(notOurs)
    expect(w.tokens.active('opencode-plugin')).toBeNull()
    expect(w.changes()).toStrictEqual([{ id: OPENCODE, state: 'off' }])
  })

  it('[FM-125] a locked turn-off keeps it on and answers config-revert-failed', async () => {
    const w = await world()
    await w.preferences.setOpenCodePermissions(true, 'settings')
    const file = await w.plugin.read()
    const token = w.tokens.active('opencode-plugin')
    w.plugin.fs.lock(w.plugin.path, true)

    const result = await w.preferences.setOpenCodePermissions(false, 'settings')

    expect(result).toStrictEqual({ ok: false, error: 'config-revert-failed' })
    expect(w.settings.get(OPENCODE).state).toBe('on-verified')
    expect(await w.plugin.read()).toBe(file)
    expect(w.tokens.active('opencode-plugin')).toStrictEqual(token)
    expect(w.changes()).toStrictEqual([
      { id: OPENCODE, state: 'on-verified' },
      { id: OPENCODE, state: 'on-verified' }
    ])
  })
})
