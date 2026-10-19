// layer: L6
// L6 (17 §1.6): the Mines page's admin rows (14 §2.1 KEEP A-20, A-30, A-31, A-32, A-34; §1.6, §1.10; ADR-019 items 7,
// 8, 9) through the real router and seam A gate, the real HostClient against FakeHost, and the real native actions over
// the folder-picker and opener doubles (no real dialog is ever shown). Each row is routed `host` as the cut-1 switch
// (ISSUE-123) will route it; every answer is checked against the registry's response schema, today's shape.
//
// TC-091-01 (each row answers today's shape through its Host method; only main produces paths), TC-091-02 (A-31 adopts
// the path A-30 remembered), TC-091-03 (with the Host unreachable each row answers its legacy failure shape).
import type { BaseWindow, OpenDialogOptions, OpenDialogReturnValue } from 'electron'
import { afterEach, describe, expect, it } from 'vitest'
import { CHANNELS, type ChannelKey } from '@dwarfai/contracts'
import { createHostClient, type HostClientService } from '../../host-client/HostClient'
import { FAKE_HOST_CAPABILITIES, FakeHost } from '../../host-client/testing/FakeHost'
import { FakeHostClientTimers } from '../../host-client/testing/FakeHostClientTimers'
import { RecordingUiLog } from '../../hostLauncher/fakes/RecordingUiLog'
import { ElectronFolderPicker } from '../../window/adapters/ElectronFolderPicker'
import { createNativeActions } from '../../window/application/nativeActions'
import { FakeClipboard } from '../../window/ports/fakes/FakeClipboard'
import { FakeExternalOpener } from '../../window/ports/fakes/FakeExternalOpener'
import { FakeFilePicker } from '../../window/ports/fakes/FakeFilePicker'
import type { ChannelRoute } from '../channelRoute'
import { createRouter, type RouteTarget } from '../router'
import type { IpcSenderEvent, SenderPolicy } from '../senderCheck'
import {
  createMinesAdminRows,
  MINE_DECLARE,
  MINE_DECLARE_MAIN,
  MINE_OPEN_PATH,
  MINE_UNDECLARE,
  MINES_ADMIN_ROWS,
  PROJECTS_QUERY,
  type MinesAdminDeps
} from './minesAdmin'

const APP_ENTRY = 'file:///opt/DwarfAI/out/renderer/index.html'
const PANEL_ID = 7
const OTHER_WINDOW_ID = 8
const senders: SenderPolicy = {
  appEntry: APP_ENTRY,
  isModeWindow: (id) => id === PANEL_ID || id === OTHER_WINDOW_ID
}
const FROM_PANEL: IpcSenderEvent = { sender: { id: PANEL_ID }, senderFrame: { url: APP_ENTRY } }
const FROM_OTHER: IpcSenderEvent = {
  sender: { id: OTHER_WINDOW_ID },
  senderFrame: { url: APP_ENTRY }
}

const MINE = '01890a5d-ac96-774b-bcce-b302099a0001'
const MAIN_MINE = '01890a5d-ac96-774b-bcce-b302099a0002'
const DWARF = '01890a5d-ac96-774b-bcce-b302099ad001'
const R1 = '01890a5d-ac96-774b-bcce-b302099a8001'
const R2 = '01890a5d-ac96-774b-bcce-b302099a8002'
const PICKED = '/home/j/work/ore'
const WORKTREE = '/home/j/work/ore-feat'
const MAIN_TREE = '/home/j/work/ore-main'
const MINE_CAPABILITIES = [
  'mines.declare',
  'mines.adoptMainProject',
  'mines.remove',
  'mines.list',
  'mines.resolveFile'
]

/** Each row routed `host` with its KEEP target shape (today's), as the cut-1 switch will route it. */
const routeOf = (channel: ChannelKey): ChannelRoute => ({
  channel,
  owner: 'host',
  since: 'cut-1',
  parity: 'passed',
  shape: 'target'
})

/** Electron's `dialog`, recorded: no real dialog is shown. */
class RecordingDialog {
  readonly calls: OpenDialogOptions[] = []
  answer: OpenDialogReturnValue = { canceled: true, filePaths: [] }

  showOpenDialog(
    first: BaseWindow | OpenDialogOptions,
    second?: OpenDialogOptions
  ): Promise<OpenDialogReturnValue> {
    this.calls.push(second ?? (first as OpenDialogOptions))
    return Promise.resolve(this.answer)
  }
  /** The person picks `folder` in the next dialog, or cancels it when `null`. */
  picks(folder: string | null): void {
    this.answer =
      folder === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [folder] }
  }
}

const clients: HostClientService[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose()
})

async function settle(rounds = 20): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setImmediate(resolve))
}

/**
 * The rows over a HostClient attached to FakeHost (`attached`), or one that never reached a Host. `beforeRemoveMine`
 * is the A-32 hook the root binds to `LegacyEndFirstAdapter`; a pass-through here.
 */
async function world(
  options: {
    attached?: boolean
    beforeRemoveMine?: MinesAdminDeps['beforeRemoveMine']
  } = {}
) {
  const host = new FakeHost({ capabilities: [...FAKE_HOST_CAPABILITIES, ...MINE_CAPABILITIES] })
  const client = createHostClient({
    launcher: { ensureHostRunning: () => Promise.resolve('attached') },
    connect: host.connect,
    readToken: () => Promise.resolve(host.token),
    protocolVersion: 1,
    client: { appVersion: '0.0.0-test', buildId: 'test', pid: 4242 },
    timers: new FakeHostClientTimers(),
    log: new RecordingUiLog(),
    hungHost: { endHungHost: () => Promise.resolve({ outcome: 'identity-missing' }) }
  })
  clients.push(client)
  if (options.attached !== false) {
    await client.ensureHost()
    // A window is open: it holds the `ui` connection the rows' calls go on (ADR-003 item 12).
    client.subscribe(() => {})
    await settle()
  }
  const dialog = new RecordingDialog()
  const opener = new FakeExternalOpener()
  const native = createNativeActions({
    files: new FakeFilePicker(null),
    folders: new ElectronFolderPicker({ dialog: dialog as never, windowOf: () => null }),
    clipboard: new FakeClipboard(),
    opener,
    parentWindow: () => ({ windowId: PANEL_ID })
  })
  const requestIds = [R1, R2]
  const rows = createMinesAdminRows({
    client,
    native,
    newRequestId: () => requestIds.shift() ?? 'no-more-request-ids',
    beforeRemoveMine: options.beforeRemoveMine ?? ((id, requestId, remove) => remove(id, requestId))
  })
  const legacy: RouteTarget = { serve: () => Promise.reject(new Error('never legacy')) }
  const router = createRouter({
    routes: MINES_ADMIN_ROWS.map(routeOf),
    legacy,
    host: rows,
    senders
  })
  /** What the rows sent the Host, method and params, in order. */
  const sent = (): Array<[string, unknown]> =>
    host.received.filter((r) => r.method.startsWith('mines.')).map((r) => [r.method, r.params])
  /** Dispatches `channel` from `from` and checks the answer against the registry's response schema. */
  const call = async (
    channel: ChannelKey,
    payload?: unknown,
    from: IpcSenderEvent = FROM_PANEL
  ): Promise<unknown> => {
    const answer = await router.dispatch(channel, from, payload)
    expect(CHANNELS[channel].response.safeParse(answer).success, `${channel} shape`).toBe(true)
    return answer
  }
  return { host, client, dialog, opener, call, sent }
}

describe('Mines admin rows through UI main (14 §2.1 A-20, A-30, A-31, A-32, A-34)', () => {
  it("[ADR-019, NFR-PLAT-09] declareMine picks the folder in main through the FolderPicker, whose Electron adapter opens the OS folder dialog, sends it to mines.declare and answers today's MineDeclareResult", async () => {
    const { host, dialog, call, sent } = await world()
    host.handle('mines.declare', () => ({ ok: true, value: { mineId: MINE } }))
    dialog.picks(PICKED)

    // The renderer sends no path (14 §1.10): main's picker produces it, and main mints the requestId (14 §1.6).
    const answer = await call(MINE_DECLARE)

    expect(answer).toEqual({ outcome: 'added', mineId: MINE })
    expect(dialog.calls).toEqual([{ properties: ['openDirectory'] }])
    expect(sent()).toEqual([['mines.declare', { path: PICKED, requestId: R1 }]])
  })

  it("[ADR-019] a worktree answer is mapped to today's outcome and declareMainProject then adopts the remembered path", async () => {
    const { host, dialog, call, sent } = await world()
    // Amended: the Host names the main working tree's path (owner amendment G, 2026-10-07).
    host.handle('mines.declare', () => ({
      ok: true,
      value: { worktreeOf: MAIN_MINE, mainPath: PICKED }
    }))
    host.handle('mines.adoptMainProject', () => ({ ok: true, value: { mineId: MAIN_MINE } }))
    // The main project's mine is listed: its folder is the worktree's root the dialog names.
    host.handle('mines.list', () => ({
      mines: [
        {
          mineId: MAIN_MINE,
          name: 'ore',
          path: PICKED,
          tier: 'copper',
          lastUsedAt: 1_700_000_000_000,
          presentDwarfs: 1,
          removed: false
        }
      ],
      total: 1
    }))
    dialog.picks(WORKTREE)

    const asked = await call(MINE_DECLARE)
    expect(asked).toEqual({
      outcome: 'worktree-of',
      worktreeOf: { worktree: WORKTREE, root: PICKED }
    })

    // A-31 sends no path either: main adopts the path it remembered for this window.
    const adopted = await call(MINE_DECLARE_MAIN)
    expect(adopted).toEqual({ outcome: 'added', mineId: MAIN_MINE })
    expect(sent().filter(([method]) => method !== 'mines.list')).toEqual([
      ['mines.declare', { path: WORKTREE, requestId: R1 }],
      ['mines.adoptMainProject', { worktreePath: WORKTREE, requestId: R2 }]
    ])

    // The remembered path is spent: a second A-31 has no project waiting and sends nothing.
    const again = await call(MINE_DECLARE_MAIN)
    expect(again).toEqual({
      outcome: 'failed',
      reason: 'There is no project waiting to be opened. Add the folder again.'
    })
    expect(sent().filter(([method]) => method === 'mines.adoptMainProject')).toHaveLength(1)
  })

  it("[ADR-019] a cancelled picker sends nothing and answers today's cancelled outcome", async () => {
    const { dialog, call, sent } = await world()
    dialog.picks(null)

    expect(await call(MINE_DECLARE)).toEqual({ outcome: 'cancelled' })
    expect(dialog.calls).toHaveLength(1)
    expect(sent()).toEqual([])
  })

  it('[ADR-019] openMinePath resolves through mines.resolveFile and opens only the resolved path; escapes-mine answers opened false with its reason', async () => {
    const { host, opener, call, sent } = await world()
    const resolved = '/home/j/work/ore/src/index.ts'
    host.handle('mines.resolveFile', (params) =>
      (params as { target: string }).target === 'src/index.ts'
        ? { ok: true, value: { path: resolved } }
        : { ok: false, error: 'escapes-mine' }
    )

    expect(
      await call(MINE_OPEN_PATH, { mineId: MINE, target: 'src/index.ts', dwarfId: DWARF })
    ).toEqual({ opened: true })
    expect(opener.openedPaths).toEqual([resolved])

    expect(await call(MINE_OPEN_PATH, { mineId: MINE, target: '../../etc/passwd' })).toEqual({
      opened: false,
      reason: "That path is outside this mine's folder."
    })
    // The renderer's raw target is never opened: only the path the Host resolved.
    expect(opener.openedPaths).toEqual([resolved])
    expect(sent()).toEqual([
      ['mines.resolveFile', { mineId: MINE, target: 'src/index.ts', dwarfId: DWARF }],
      ['mines.resolveFile', { mineId: MINE, target: '../../etc/passwd' }]
    ])
  })

  it('[ADR-014] undeclareMine answers unchanged with the reason when mines.remove reports dwarf-could-not-be-ended', async () => {
    const { host, call, sent } = await world()
    host.handle('mines.remove', () => ({ ok: false, error: 'dwarf-could-not-be-ended' }))

    // The reason is today's copy: the outcome code never reaches the person (the ONE danger toast arrives as a frame).
    expect(await call(MINE_UNDECLARE, MINE)).toEqual({
      outcome: 'unchanged',
      reason: 'That mine could not be removed.'
    })
    expect(sent()).toEqual([['mines.remove', { mineId: MINE, requestId: R1 }]])
  })

  it("[ADR-003] queryProjects relays mines.list and answers today's ProjectQueryResult", async () => {
    const { host, call, sent } = await world()
    host.handle('mines.list', () => ({
      mines: [
        {
          mineId: MINE,
          name: 'ore',
          path: PICKED,
          tier: 'silver',
          lastUsedAt: 1_700_000_000_000,
          presentDwarfs: 2,
          removed: false
        },
        {
          mineId: MAIN_MINE,
          name: 'slag',
          path: '/home/j/work/slag',
          tier: null,
          lastUsedAt: 0,
          presentDwarfs: 0,
          removed: false
        }
      ],
      total: 2
    }))

    const answer = await call(PROJECTS_QUERY, {
      sortBy: 'lastOpenedAt',
      direction: 'desc',
      tier: 'silver',
      nameContains: 'or',
      limit: 500,
      offset: 0
    })

    expect(answer).toEqual({
      answered: true,
      projects: [
        {
          id: MINE,
          path: PICKED,
          name: 'ore',
          declared: false,
          knownTier: 'silver',
          addedAt: 0,
          lastOpenedAt: 1_700_000_000_000,
          live: true
        },
        {
          id: MAIN_MINE,
          path: '/home/j/work/slag',
          name: 'slag',
          declared: false,
          addedAt: 0,
          lastOpenedAt: 0,
          live: false
        }
      ]
    })
    expect(sent()).toEqual([
      [
        'mines.list',
        {
          sortBy: 'lastUsed',
          direction: 'desc',
          tier: 'silver',
          nameContains: 'or',
          limit: 500,
          offset: 0
        }
      ]
    ])
  })

  it('[ADR-002] with the Host unreachable each row answers its legacy failure shape and sends nothing', async () => {
    const { host, dialog, opener, call, sent } = await world({ attached: false })
    dialog.picks(PICKED)

    expect(await call(MINE_OPEN_PATH, { mineId: MINE, target: 'src/index.ts' })).toEqual({
      opened: false,
      reason: 'That file could not be opened.'
    })
    expect(await call(MINE_DECLARE)).toEqual({
      outcome: 'failed',
      reason: 'That folder could not be saved as a mine.'
    })
    expect(await call(MINE_DECLARE_MAIN)).toEqual({
      outcome: 'failed',
      reason: 'There is no project waiting to be opened. Add the folder again.'
    })
    expect(await call(MINE_UNDECLARE, MINE)).toEqual({
      outcome: 'failed',
      reason: 'That mine could not be removed.'
    })
    expect(await call(PROJECTS_QUERY, { sortBy: 'lastOpenedAt', direction: 'desc' })).toEqual({
      answered: false,
      projects: [],
      reason: 'The projects could not be read.'
    })

    // Nothing reached the Host, no picker opened and nothing was opened.
    expect(sent()).toEqual([])
    expect(host.received).toEqual([])
    expect(dialog.calls).toEqual([])
    expect(opener.openedPaths).toEqual([])
  })
})

describe('Mines admin rows: the cases around the issue list (14 §2.1)', () => {
  it('[ADR-019] a worktree whose main project has no mine yet answers the main path the Host named as its root, and the remembered path stays per window', async () => {
    // Amended (owner amendment G, 2026-10-07; was the pinned package gap of an empty root): the Host answers
    // `{worktreeOf, mainPath}` with a fresh id when the main tree has no mine (declare.ts), and `mainPath` names that
    // tree's folder, so today's `MineWorktreeOf.root` holds it and no mine list is read for it.
    const { host, dialog, call, sent } = await world()
    host.handle('mines.declare', () => ({
      ok: true,
      value: { worktreeOf: MAIN_MINE, mainPath: MAIN_TREE }
    }))
    host.handle('mines.list', () => ({ mines: [], total: 0 }))
    host.handle('mines.adoptMainProject', () => ({ ok: true, value: { mineId: MAIN_MINE } }))
    dialog.picks(WORKTREE)

    expect(await call(MINE_DECLARE)).toEqual({
      outcome: 'worktree-of',
      worktreeOf: { worktree: WORKTREE, root: MAIN_TREE }
    })
    expect(sent().filter(([method]) => method === 'mines.list')).toEqual([])

    // Another window asked nothing: it has no project waiting, and nothing is sent for it.
    expect(await call(MINE_DECLARE_MAIN, undefined, FROM_OTHER)).toEqual({
      outcome: 'failed',
      reason: 'There is no project waiting to be opened. Add the folder again.'
    })
    expect(await call(MINE_DECLARE_MAIN)).toEqual({ outcome: 'added', mineId: MAIN_MINE })
    expect(sent().filter(([method]) => method === 'mines.adoptMainProject')).toEqual([
      ['mines.adoptMainProject', { worktreePath: WORKTREE, requestId: R2 }]
    ])
  })

  it("[ADR-019] a refused folder and a main project that cannot be adopted answer today's failed outcome", async () => {
    const { host, dialog, call } = await world()
    host.handle('mines.declare', () => ({ ok: false, error: 'not-a-folder' }))
    dialog.picks(PICKED)

    expect(await call(MINE_DECLARE)).toEqual({
      outcome: 'failed',
      reason: 'That folder could not be saved as a mine.'
    })

    host.handle('mines.declare', () => ({
      ok: true,
      value: { worktreeOf: MAIN_MINE, mainPath: MAIN_TREE }
    }))
    host.handle('mines.list', () => ({ mines: [], total: 0 }))
    host.handle('mines.adoptMainProject', () => ({ ok: false, error: 'no-main-project' }))
    await call(MINE_DECLARE)
    expect(await call(MINE_DECLARE_MAIN)).toEqual({
      outcome: 'failed',
      reason: 'That folder could not be saved as a mine.'
    })
  })

  it('[ADR-014] undeclareMine relays mines.remove through the A-32 hook and answers removed; a hook that could not end a legacy session sends nothing', async () => {
    const hooked: Array<[string, string]> = []
    let endsLegacy = true
    const { host, call, sent } = await world({
      beforeRemoveMine: (mineId, requestId, remove) => {
        hooked.push([mineId, requestId])
        // LegacyEndFirstAdapter's own refusal (ISSUE-090, rowShapes/mineNotRemoved.ts): the frozen code as reason.
        return endsLegacy
          ? remove(mineId, requestId)
          : Promise.resolve({ outcome: 'unchanged', reason: 'dwarf-could-not-be-ended' })
      }
    })
    host.handle('mines.remove', () => ({ ok: true, value: {} }))

    expect(await call(MINE_UNDECLARE, MINE)).toEqual({ outcome: 'removed' })
    endsLegacy = false
    expect(await call(MINE_UNDECLARE, MINE)).toEqual({
      outcome: 'unchanged',
      reason: 'That mine could not be removed.'
    })

    expect(hooked).toEqual([
      [MINE, R1],
      [MINE, R2]
    ])
    expect(sent()).toEqual([['mines.remove', { mineId: MINE, requestId: R1 }]])
  })

  it('[ADR-003] a query by the date a mine was added is refused, since mines.list cannot order by it, and sends nothing', async () => {
    const { call, sent } = await world()

    expect(await call(PROJECTS_QUERY, { sortBy: 'addedAt', direction: 'asc' })).toEqual({
      answered: false,
      projects: [],
      reason: 'That is not a search this panel can run.'
    })
    expect(sent()).toEqual([])
  })
})
