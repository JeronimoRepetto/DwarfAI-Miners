// layer: L6
import { describe, expect, it } from 'vitest'
import { CHANNELS, type ChannelKey } from '@dwarfai/contracts'
import { createUiPreferences, type ModeWindowSender } from '../../window/application/uiPreferences'
import { defaultsOf } from '../../window/domain/uiPreferenceValues'
import {
  createInMemoryUiPreferenceStorage,
  InMemoryUiPreferenceStore
} from '../../window/ports/fakes/InMemoryUiPreferenceStore'
import type { ChannelRoute } from '../channelRoute'
import { createRouter, type RouteTarget } from '../router'
import { ROUTES } from '../routes'
import type { IpcSenderEvent, SenderPolicy } from '../senderCheck'
import { createUiPreferenceRows, UI_PREFERENCE_ROWS } from './uiPreferenceRows'

/**
 * The UI preference rows behind the router and its seam A gate (ADR-019 items 7, 8; ISSUE-044), routed `ui-local` as
 * ISSUE-056 routes them at cut 0 (14 §5): today's shapes, kept (14 §2.1 KEEP), and setters that answer the stored
 * value (ADR-024 item 9).
 */
describe('UI preference rows (14 §2.1 A-06, A-07, A-45, A-46, A-56, A-57, A-P6)', () => {
  const APP_ENTRY = 'file:///opt/DwarfAI/out/renderer/index.html'
  const senders: SenderPolicy = { appEntry: APP_ENTRY, isModeWindow: (id) => id === 1 }
  const panel: IpcSenderEvent = { sender: { id: 1 }, senderFrame: { url: APP_ENTRY } }
  const UI_LOCAL = new Set<ChannelKey>([...UI_PREFERENCE_ROWS, 'typography:preferences:changed'])

  /** The pre-cut-0 table with these rows switched to `ui-local`, as ISSUE-056 switches them. */
  const routes: ChannelRoute[] = ROUTES.map((route) =>
    UI_LOCAL.has(route.channel) ? { ...route, owner: 'ui-local', since: 'cut-0' } : route
  )
  const legacy: RouteTarget = {
    serve: (channel) => Promise.reject(new Error(`legacy must not serve ${channel}`))
  }

  class RecordingModeWindow implements ModeWindowSender {
    readonly pushes: Array<[string, unknown]> = []
    send(push: string, payload: unknown): void {
      this.pushes.push([push, payload])
    }
  }

  function subject() {
    const storage = createInMemoryUiPreferenceStorage()
    const window = new RecordingModeWindow()
    const preferences = createUiPreferences({
      store: new InMemoryUiPreferenceStore(storage),
      modeWindows: () => [window]
    })
    const router = createRouter({
      routes,
      legacy,
      uiLocal: createUiPreferenceRows(preferences),
      senders
    })
    const call = (channel: ChannelKey, payload?: unknown) =>
      router.dispatch(channel, panel, payload)
    return { call, window, storage }
  }

  /** The answer parses with the row's response schema, which for a KEEP row is today's shape. */
  function inShape(channel: ChannelKey, answer: unknown): unknown {
    expect(
      CHANNELS[channel].response.safeParse(answer).success,
      `${channel} answers in today's shape`
    ).toBe(true)
    return answer
  }

  it('[ADR-024] A-06, A-07, A-45, A-46, A-56, A-57 keep today’s shapes and every setter answers the stored value', async () => {
    const { call, window } = subject()

    // A-06 / A-07: the stored audio, a volume past the end stored (and answered) clamped.
    expect(inShape('audio:preferences:get', await call('audio:preferences:get'))).toEqual(
      defaultsOf('audio')
    )
    const audio = { ...defaultsOf('audio'), musicVolume: 1.5, musicAtStartup: false }
    const storedAudio = { ...audio, musicVolume: 1 }
    expect(inShape('audio:preferences:set', await call('audio:preferences:set', audio))).toEqual(
      storedAudio
    )
    expect(await call('audio:preferences:get')).toEqual(storedAudio)

    // A-45 / A-46 / A-P6: a preset is stored in its own faces; every mode window gets the stored value.
    expect(inShape('typography:preferences:get', await call('typography:preferences:get'))).toEqual(
      defaultsOf('typography')
    )
    const readable = {
      style: 'readable',
      faces: { display: 'roboto', label: 'roboto', meta: 'roboto', talk: 'roboto' }
    }
    const asked = { style: 'readable', faces: { ...readable.faces, talk: 'arial' } }
    expect(
      inShape('typography:preferences:set', await call('typography:preferences:set', asked))
    ).toEqual(readable)
    expect(await call('typography:preferences:get')).toEqual(readable)
    expect(window.pushes).toEqual([['typography:preferences:changed', readable]])
    inShape('typography:preferences:changed', window.pushes[0]?.[1])

    // A-56 / A-57: the launch view is answered as stored; the one-way setter answers nothing.
    expect(inShape('launch-view:get', await call('launch-view:get'))).toEqual({
      area: 'map',
      mineId: null
    })
    expect(await call('launch-view:set', { area: 'mines', mineId: 'mine-9' })).toBeUndefined()
    expect(await call('launch-view:get')).toEqual({ area: 'mines', mineId: 'mine-9' })
  })

  it('[ADR-001] a ui-local row these handlers do not serve is refused with a typed error, never guessed', async () => {
    const preferences = createUiPreferences({
      store: new InMemoryUiPreferenceStore(),
      modeWindows: () => []
    })
    const answer = await createUiPreferenceRows(preferences).serve('panel:hide', undefined)
    expect(answer).toEqual({
      ok: false,
      error: { code: 'METHOD_NOT_FOUND', message: expect.any(String), retryable: false }
    })
  })

  it('[ADR-019] a setter payload outside today’s shape is refused by the gate and never reaches a store', async () => {
    const { call, storage } = subject()
    await call('audio:preferences:set', { ...defaultsOf('audio'), loud: true })
    await call('launch-view:set', { area: 'basement', mineId: null })
    await call('launch-view:set', { area: 'lab', mineId: null })
    // Only the payload in today's shape was stored.
    expect(storage.stored).toEqual({ launchView: { area: 'lab', mineId: null } })
  })
})
