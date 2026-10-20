// layer: L6
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { CHANNELS, ROW_IDS, UNROUTED, type ChannelKey } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import type { AppMode, ModeCoordinator } from '../window/application/ModeCoordinator'
import { createRouter } from './router'
import { ROUTES } from './routes'
import type { IpcSenderEvent, SenderPolicy } from './senderCheck'
import { createModeRows, MODE_MOVE, MODE_ROWS, MODE_TRANSITION_DONE } from './mode'

/**
 * A-N13 `moveToMode`, A-N14 `onModeTransition`, A-N15 `modeTransitionDone` (14 §2.2, §3.9, §6.5; ADR-019 items 7, 8;
 * ADR-025 item 3): the real router and seam A gate, with the routes this release's table gives the rows, in front of
 * a coordinator double that records what reached it.
 */
const APP_ENTRY = 'file:///opt/DwarfAI/out/renderer/index.html'
const PANEL_ID = 7
const STRANGER_ID = 99
const MODES: Readonly<Record<number, AppMode>> = { [PANEL_ID]: 'panel' }
const senders: SenderPolicy = { appEntry: APP_ENTRY, isModeWindow: (id) => id in MODES }
const from = (id: number, url = APP_ENTRY): IpcSenderEvent => ({
  sender: { id },
  senderFrame: { url }
})
const DWARF = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a01'
const MINE = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a02'
const RUN = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1b01'
const KEYS = ['mode:move', 'mode:transition', 'mode:transition:done'] as const

function world() {
  const moves: unknown[] = []
  const dones: { sender: AppMode; transitionId: string }[] = []
  const coordinator: Pick<ModeCoordinator, 'moveToMode' | 'transitionDone'> = {
    moveToMode(p) {
      moves.push(p)
      return Promise.resolve({ ok: true, value: undefined })
    },
    transitionDone(sender, p) {
      dones.push({ sender, transitionId: p.transitionId })
    }
  }
  const router = createRouter({
    routes: ROUTES.filter((route) => (MODE_ROWS as readonly string[]).includes(route.channel)),
    uiLocal: createModeRows(coordinator, (id) => MODES[id]),
    senders
  })
  return { router, moves, dones }
}

describe('the mode rows over seam A (14 §2.2 A-N13…A-N15)', () => {
  it('[ADR-019] moveToMode, onModeTransition and modeTransitionDone are declared once with strict schemas', () => {
    const ids = Object.entries(ROW_IDS).filter(([, id]) => ['A-N13', 'A-N14', 'A-N15'].includes(id))
    expect(ids).toEqual([
      ['mode:move', 'A-N13'],
      ['mode:transition', 'A-N14'],
      ['mode:transition:done', 'A-N15']
    ])
    expect(KEYS.map((key) => [CHANNELS[key].kind, CHANNELS[key].placement])).toEqual([
      ['invoke', 'ui-local'],
      ['push', 'ui-local'],
      ['send', 'ui-local']
    ])
    const transition = {
      transitionId: RUN,
      from: 'panel',
      to: 'hidden',
      t0: 1016,
      role: 'source'
    }
    expect(CHANNELS['mode:transition'].response.safeParse(transition).success).toBe(true)
    expect(
      CHANNELS['mode:transition'].response.safeParse({
        ...transition,
        chat: { dwarfId: DWARF, mineId: MINE }
      }).success
    ).toBe(true)
    // Strict: a field 14 §3.9 does not list is refused, in each of the three shapes.
    expect(
      CHANNELS['mode:transition'].response.safeParse({ ...transition, origin: 'panel' }).success
    ).toBe(false)
    expect(
      CHANNELS['mode:transition:done'].request.safeParse({ transitionId: RUN, role: 'source' })
        .success
    ).toBe(false)
    expect(CHANNELS['mode:move'].request.safeParse({ mode: 'veta', reason: 'lever' }).success).toBe(
      false
    )
  })

  it('[ADR-019] an extra key or an unknown mode in moveToMode is INVALID_PARAMS', async () => {
    const { router, moves } = world()
    expect(
      await router.dispatch(MODE_MOVE, from(PANEL_ID), {
        mode: 'veta',
        mineId: MINE,
        dwarfId: DWARF
      })
    ).toEqual({
      ok: true,
      value: undefined
    })
    for (const payload of [
      { mode: 'veta', reason: 'lever' },
      { mode: 'tray' },
      { mode: 'panel', slot: 'map' }
    ]) {
      expect(await router.dispatch(MODE_MOVE, from(PANEL_ID), payload)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_PARAMS' }
      })
    }
    expect(moves).toEqual([{ mode: 'veta', mineId: MINE, dwarfId: DWARF }])
    // A-N15 with an extra key is dropped and counted; a valid one reaches the coordinator with the sender's mode.
    expect(
      await router.dispatch(MODE_TRANSITION_DONE, from(PANEL_ID), { transitionId: RUN, x: 1 })
    ).toBeUndefined()
    expect(router.refusalCount(MODE_TRANSITION_DONE, 'INVALID_PARAMS')).toBe(1)
    expect(
      await router.dispatch(MODE_TRANSITION_DONE, from(PANEL_ID), { transitionId: RUN })
    ).toBeUndefined()
  })

  it('[ADR-019] moveToMode from a frame that is not a mode window is SENDER_REJECTED', async () => {
    const { router, moves, dones } = world()
    expect(await router.dispatch(MODE_MOVE, from(STRANGER_ID), { mode: 'hidden' })).toMatchObject({
      ok: false,
      error: { code: 'SENDER_REJECTED' }
    })
    expect(
      await router.dispatch(MODE_MOVE, from(PANEL_ID, 'https://example.com/'), { mode: 'hidden' })
    ).toMatchObject({ ok: false, error: { code: 'SENDER_REJECTED' } })
    await router.dispatch(MODE_TRANSITION_DONE, from(STRANGER_ID), { transitionId: RUN })
    expect(moves).toEqual([])
    expect(dones).toEqual([])
    await router.dispatch(MODE_TRANSITION_DONE, from(PANEL_ID), { transitionId: RUN })
    expect(dones).toEqual([{ sender: 'panel', transitionId: RUN }])
  })

  it('[ADR-001] the three rows route ui-local', () => {
    for (const key of KEYS) {
      expect(UNROUTED[key as ChannelKey], key).toBeUndefined()
      expect(
        ROUTES.filter((route) => route.channel === key).map((route) => [route.owner, route.shape]),
        key
      ).toEqual([['ui-local', 'target']])
    }
  })

  it('[ADR-025, TC-284-05] lastMode has no writer other than the ModeCoordinator', () => {
    const root = join(process.cwd(), 'src')
    const writers: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.(ts|vue)$/.test(name) && !/\.test\.ts$|\.contract\.ts$/.test(name)) {
          const text = readFileSync(path, 'utf8')
          if (/\.(set|save)\(\s*'lastMode'/.test(text))
            writers.push(relative(root, path).replaceAll('\\', '/'))
        }
      }
    }
    walk(root)
    expect(writers).toEqual(['ui-main/window/application/ModeCoordinator.ts'])
  })
})
