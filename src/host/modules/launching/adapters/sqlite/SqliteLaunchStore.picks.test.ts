import { describe, expect, it } from 'vitest'
import type { HostEpoch, LaunchId, ProviderId } from '../../../../kernel/domain/values'
import { FakeClock } from '../../../../kernel/fakes/FakeClock'
import { SqliteTransactionRunner } from '../../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../../platform/sqlite/testing/templateDb'
import type { Launch } from '../../domain/launch'
import { MINE, MINE_FOLDER, T0, seedMine } from '../../testing/sqliteLaunchingDb'
import { SqliteLaunchStore } from './SqliteLaunchStore'

// L3 (17 §1.3): what a "Let Jev choose" launch keeps of Jev's answer in `launches` (10 §`launches`:
// `provider_id` is the chosen or Jev-picked provider, `model` and `effort` the ones picked), over a
// copy of the run's template database. The pick (S5.12) and the handed-back picks (S5.13) read back
// as the aggregate held them, so a launch read after a Host restart still names the way it ran.
// ISSUE-182 forward note from #1401 (ISSUE-164): the pick lived in Host memory only.
const EPOCH = 'epoch-182' as HostEpoch
const PICKED = '00000000-0000-7000-8000-0000000182b1' as LaunchId
const HANDED = '00000000-0000-7000-8000-0000000182b2' as LaunchId
const SUPPLIER = '00000000-0000-7000-8000-0000000182b3' as LaunchId
const CLAUDE = 'claude' as ProviderId
const CODEX = 'codex' as ProviderId

function storeOverTemplate() {
  const { db } = openTemplateCopy()
  const runner = new SqliteTransactionRunner(db)
  seedMine(db, runner)
  const store = new SqliteLaunchStore({
    db,
    scope: runner,
    clock: new FakeClock(T0),
    folderOf: (mineId) => (mineId === MINE ? MINE_FOLDER : null)
  })
  const put = (launch: Launch): void => runner.inTransaction(() => store.put(launch))
  return { db, store, put }
}

function jevLaunch(id: LaunchId): Launch {
  return {
    id,
    request: {
      mineId: MINE,
      way: { kind: 'jev' },
      model: 'pickers-model',
      prompt: 'Survey the seam',
      jevOn: true,
      jevAutoAccept: false
    },
    state: 'routing',
    hostEpoch: EPOCH,
    launchedWithLetJevChoose: true
  }
}

describe('SqliteLaunchStore keeps Jev answers', () => {
  it('[S5.12, ADR-028] a Jev pick is stored as the launch provider, model and effort and reads back as the pick', () => {
    const { store, put } = storeOverTemplate()
    const routing = jevLaunch(PICKED)
    put(routing)
    put({
      ...routing,
      state: 'resolving',
      pick: { providerId: CLAUDE, model: 'opus', effort: 'high' }
    })

    const read = store.byId(PICKED)
    expect(read?.pick).toEqual({ providerId: CLAUDE, model: 'opus', effort: 'high' })
    expect(read?.picks).toBeUndefined()
    expect(read?.request.way).toEqual({ kind: 'jev' })
  })

  it('[S5.13, ADR-028] a handed-back launch reads back with the picks it put into the pickers', () => {
    const { store, put } = storeOverTemplate()
    const routing = jevLaunch(HANDED)
    put(routing)
    put({
      ...routing,
      state: 'handed-back',
      picks: { providerId: CODEX, effort: 'medium' }
    })

    const read = store.byId(HANDED)
    expect(read?.state).toBe('handed-back')
    expect(read?.picks).toEqual({ providerId: CODEX, effort: 'medium' })
    expect(read?.pick).toBeUndefined()
  })

  it('[S5.12] a Jev launch that went out on the pickers values keeps no pick', () => {
    const { store, put } = storeOverTemplate()
    const routing = jevLaunch(PICKED)
    put(routing)
    put({ ...routing, state: 'resolving' })

    const read = store.byId(PICKED)
    expect(read?.pick).toBeUndefined()
    expect(read?.request.model).toBe('pickers-model')
  })

  it('[S5.10] a supplier launch never reads back a Jev pick', () => {
    const { store, put } = storeOverTemplate()
    put({
      id: SUPPLIER,
      request: {
        mineId: MINE,
        way: { kind: 'supplier', providerId: CLAUDE },
        model: 'sonnet',
        prompt: 'Survey the seam',
        jevOn: false,
        jevAutoAccept: false
      },
      state: 'routing',
      hostEpoch: EPOCH,
      launchedWithLetJevChoose: false
    })

    const read = store.byId(SUPPLIER)
    expect(read?.pick).toBeUndefined()
    expect(read?.picks).toBeUndefined()
    expect(read?.request.way).toEqual({ kind: 'supplier', providerId: CLAUDE })
  })
})
