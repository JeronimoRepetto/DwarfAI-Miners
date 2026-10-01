// layer: L6
import { describe, expect, it } from 'vitest'
import { CHANNELS, PRELOAD_HELPERS, ROW_IDS, type ChannelKey } from '@dwarfai/contracts'
import { WINDOW_API_MEMBERS } from '../../../contracts/ipc/testing/fakeWindowApi'
import { ElectronExternalOpener } from '../../window/adapters/ElectronExternalOpener'
import { createAppInfo } from '../../window/application/appInfo'
import { createNativeActions } from '../../window/application/nativeActions'
import { FakeClipboard } from '../../window/ports/fakes/FakeClipboard'
import { FakeFilePicker } from '../../window/ports/fakes/FakeFilePicker'
import type { ChannelRoute } from '../channelRoute'
import { createRouter, type IpcMainRegistrar, type RouteTarget } from '../router'
// AMENDED for ISSUE-056 (was: `ROUTES`, which was this table until the cut-0 switch): the suite is written against
// today's table, every row `legacy` with today's shape, kept as `PRE_CUT_0_ROUTES`.
import { PRE_CUT_0_ROUTES } from '../testing/preCutRoutes'
import type { IpcSenderEvent, SenderPolicy } from '../senderCheck'
import { LEGACY_REFUSALS } from '../validate'
import { createNativeRows, NATIVE_ROWS } from './nativeRows'

/**
 * The native rows behind the router and its seam A gate (ADR-019 items 7, 8; ISSUE-044), routed `ui-local` as the
 * cut-0 switch (ISSUE-056) routes them (14 §5): A-21 `openExternalLink`, A-22 `copyText`, A-24
 * `chooseDwarfAttachments`, A-28 `getAppBuild`, A-29 `getFeatureFlags`, all KEEP with today's shapes (ADR-033 item
 * 6), and A-X1 `pathForDroppedFile`, the preload helper with no handler.
 */
describe('native rows (14 §2.1 A-21, A-22, A-24, A-28, A-29, A-X1)', () => {
  const APP_ENTRY = 'file:///opt/DwarfAI/out/renderer/index.html'
  const senders: SenderPolicy = { appEntry: APP_ENTRY, isModeWindow: (id) => id === 1 }
  const panel: IpcSenderEvent = { sender: { id: 1 }, senderFrame: { url: APP_ENTRY } }
  const UI_LOCAL = new Set<ChannelKey>(NATIVE_ROWS)

  /** The pre-cut-0 table with these rows switched to `ui-local`, as ISSUE-056 switches them. */
  const routes: ChannelRoute[] = PRE_CUT_0_ROUTES.map((route) =>
    UI_LOCAL.has(route.channel) ? { ...route, owner: 'ui-local', since: 'cut-0' } : route
  )
  const legacy: RouteTarget = {
    serve: (channel) => Promise.reject(new Error(`legacy must not serve ${channel}`))
  }

  class RecordingShell {
    readonly opened: string[] = []
    openExternal(url: string): Promise<void> {
      this.opened.push(url)
      return Promise.resolve()
    }
    openPath(): Promise<string> {
      return Promise.resolve('')
    }
  }

  class RecordingIpcMain implements IpcMainRegistrar {
    readonly handled: string[] = []
    readonly listened: string[] = []
    handle(channel: string): void {
      this.handled.push(channel)
    }
    on(channel: string): void {
      this.listened.push(channel)
    }
  }

  function subject(picked: readonly string[] | null = ['/home/j/notes.md']) {
    const shell = new RecordingShell()
    const clipboard = new FakeClipboard()
    const actions = createNativeActions({
      files: new FakeFilePicker(picked),
      clipboard,
      opener: new ElectronExternalOpener(shell),
      parentWindow: () => ({ windowId: 1 })
    })
    const appInfo = createAppInfo({
      build: { version: '2.4.1', packaged: false },
      env: { GUILD_AREAS_ENABLED: 'true' },
      readConfigFile: () => null
    })
    const rows = createNativeRows({ actions, appInfo })
    const router = createRouter({ routes, legacy, uiLocal: rows, senders })
    const call = (channel: ChannelKey, payload?: unknown) =>
      router.dispatch(channel, panel, payload)
    return { call, router, rows, shell, clipboard }
  }

  /** The answer parses with the row's response schema, which for a KEEP row is today's shape. */
  function inShape(channel: ChannelKey, answer: unknown): unknown {
    expect(
      CHANNELS[channel].response.safeParse(answer).success,
      `${channel} answers in today's shape`
    ).toBe(true)
    return answer
  }

  it('[ADR-033] A-21, A-22, A-24, A-28 and A-29 keep today’s member names and result shapes', async () => {
    const { call, router, shell, clipboard } = subject()

    // Today's members of window.api, each an invoke row of the registry, registered under today's wire name.
    const members = {
      openExternalLink: 'shell:openExternalLink',
      copyText: 'shell:copyText',
      chooseDwarfAttachments: 'dwarf:attachments:choose',
      getAppBuild: 'app:build',
      getFeatureFlags: 'app:features'
    } as const
    const ipc = new RecordingIpcMain()
    router.register(ipc)
    for (const [member, wire] of Object.entries(members)) {
      expect(WINDOW_API_MEMBERS[member as keyof typeof WINDOW_API_MEMBERS], member).toBe('invoke')
      expect(CHANNELS[wire].kind, wire).toBe('invoke')
      expect(ipc.handled, wire).toContain(wire)
    }
    expect([...NATIVE_ROWS].map((row) => ROW_IDS[row])).toEqual([
      'A-21',
      'A-22',
      'A-24',
      'A-28',
      'A-29'
    ])

    const url = 'https://example.test/docs'
    expect(inShape('shell:openExternalLink', await call('shell:openExternalLink', url))).toEqual({
      opened: true
    })
    expect(shell.opened).toEqual([url])

    expect(inShape('shell:copyText', await call('shell:copyText', 'Also check'))).toEqual({
      copied: true
    })
    expect(clipboard.written).toEqual(['Also check'])

    expect(inShape('dwarf:attachments:choose', await call('dwarf:attachments:choose'))).toEqual([
      '/home/j/notes.md'
    ])
    expect(inShape('app:build', await call('app:build'))).toEqual({
      version: '2.4.1',
      packaged: false
    })
    expect(inShape('app:features', await call('app:features'))).toEqual({
      guildAreasEnabled: true
    })
  })

  it('[ADR-019] a cancelled FilePicker answers an empty list', async () => {
    const { call } = subject(null)
    expect(inShape('dwarf:attachments:choose', await call('dwarf:attachments:choose'))).toEqual([])
  })

  it('[ADR-019] A-X1 has a registry row with no ipcMain handler', () => {
    const { router } = subject()
    const ipc = new RecordingIpcMain()
    router.register(ipc)

    expect(ROW_IDS.pathForDroppedFile).toBe('A-X1')
    expect(CHANNELS.pathForDroppedFile.placement).toBe('ui-local')
    expect(PRELOAD_HELPERS).toEqual(['pathForDroppedFile'])
    expect([...ipc.handled, ...ipc.listened]).not.toContain('pathForDroppedFile')
    // A path reaches the Host only through A-25 and A-23, which the Host re-validates (14 §1.10; ADR-019 item 9).
    expect(CHANNELS['dwarf:attachments:describe'].placement).toBe('host')
    expect(CHANNELS['dwarf:sendText'].placement).toBe('host')
  })

  it('[ADR-019] a link that is not http/https, or longer than 2048 characters, opens nothing and answers the legacy failure shape', async () => {
    const { call, shell } = subject()
    const refused = LEGACY_REFUSALS['shell:openExternalLink']
    expect(refused).toBeDefined()
    const legacyFailure = refused && 'answer' in refused ? refused.answer : undefined

    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,hi',
      `https://example.test/${'a'.repeat(2048)}`
    ]) {
      expect(inShape('shell:openExternalLink', await call('shell:openExternalLink', url))).toEqual(
        legacyFailure
      )
    }
    expect(shell.opened).toEqual([])
  })

  it('[ADR-019] copyText of an empty text writes nothing and answers not copied', async () => {
    const { call, clipboard } = subject()
    expect(await call('shell:copyText', '')).toEqual({ copied: false })
    expect(clipboard.written).toEqual([])
  })

  it('[ADR-033] A-22 answers not copied when the clipboard write fails after the call', async () => {
    const { call, clipboard } = subject()
    clipboard.failLater = new Error('clipboard refused the write')
    expect(inShape('shell:copyText', await call('shell:copyText', 'Also check'))).toEqual({
      copied: false
    })
  })

  it('[ADR-001] a ui-local row these handlers do not serve is refused with a typed error, never guessed', async () => {
    const answer = await subject().rows.serve('panel:hide', undefined)
    expect(answer).toEqual({
      ok: false,
      error: { code: 'METHOD_NOT_FOUND', message: expect.any(String), retryable: false }
    })
  })
})
