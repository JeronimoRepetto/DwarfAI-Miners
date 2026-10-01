// layer: L6
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { CHANNELS, PRELOAD_HELPERS, todayShapeOf, type ChannelKey } from '@dwarfai/contracts'
import { createModeWindowRegistry } from '../window/application/modeWindowRegistry'
import type { ChannelRoute } from './channelRoute'
import { createRouter, type IpcMainRegistrar, type RouteTarget } from './router'
import { ROUTES } from './routes'
import type { IpcSenderEvent, SenderPolicy } from './senderCheck'
import { LEGACY_REFUSALS } from './validate'

/**
 * The seam A gate of Electron main (ADR-019 items 7, 8; 14 §1.4, §1.5, §6.5 "Schemas"; 18 C-06, C-07; NFR-SEC-08),
 * table-driven over every `invoke` and `send` row of the registry: an invalid payload or an unknown sender never
 * reaches a handler and never throws; the renderer gets the row's typed refusal.
 */

// ---- one valid payload per row and shape (the samples of `src/contracts/ipc/channels.contract.test.ts`)

const U1 = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b'
const U2 = '0190a1b2-c3d4-7e5f-9a6b-7c8d9e0f1a2c'
const LEGACY_DWARF = 'claude:3f1c9a2e-session'
const CONFIRMATION = '6f1d2c3b-4a59-4e6d-8c7b-9a0b1c2d3e4f'
const LEGACY_MINE = 'mine:/home/person/project'
const TYPOGRAPHY = {
  style: 'dwarfai',
  faces: { display: 'jacquard-12', label: 'tiny5', meta: 'tiny5', talk: 'roboto' }
}

/** A valid target request for every renderer → main row (for a KEEP or RETIRE row, also its today request). */
const VALID_REQUESTS: Partial<Record<ChannelKey, unknown>> = {
  'panel:hide': undefined,
  'panel:raise': undefined,
  'panel:getAlwaysOnTop': undefined,
  'panel:setAlwaysOnTop': true,
  'panel:visible:get': undefined,
  'audio:preferences:get': undefined,
  'audio:preferences:set': {
    musicAtStartup: true,
    musicVolume: 0.5,
    ambienceVolume: 0.25,
    voiceVolume: 1,
    notificationSounds: false
  },
  'panel:layout:get': undefined,
  'panel:layout:set': { mineOpen: false, dockOpen: true, edge: 'left' },
  'shortcut:get': undefined,
  'shortcut:set': 'Control+Shift+D',
  'mines:get': undefined,
  'dwarf:activate': { dwarfId: U1, purpose: 'open-console' },
  'dwarf:feed': LEGACY_DWARF,
  'dwarf:feed:page': { dwarfId: U1, page: { before: U2, limit: 20 } },
  'panel:watchDwarfFeed': LEGACY_DWARF,
  'dwarf:refreshTelemetry': LEGACY_DWARF,
  'dwarf:setTuning': { dwarfId: LEGACY_DWARF, change: { kind: 'model', model: 'opus' } },
  'mine:history': U1,
  'mine:openPath': { mineId: LEGACY_MINE, target: 'src/index.ts', dwarfId: LEGACY_DWARF },
  'shell:openExternalLink': 'https://example.com/docs',
  'shell:copyText': 'copied words',
  'dwarf:sendText': { dwarfId: U1, text: 'hello', attachments: ['/tmp/a.png'], requestId: U2 },
  'dwarf:attachments:choose': undefined,
  'dwarf:attachments:describe': ['/tmp/a.png', '/tmp/b.txt'],
  'dwarf:kick': { dwarfId: LEGACY_DWARF },
  'dwarf:retire': LEGACY_DWARF,
  'app:build': undefined,
  'app:features': undefined,
  'mine:declare': undefined,
  'mine:declare-main': undefined,
  'mine:undeclare': LEGACY_MINE,
  'metrics:reset': { confirmed: 'yes', requestId: U1 },
  'projects:query': {
    sortBy: 'addedAt',
    direction: 'desc',
    nameContains: 'dw',
    limit: 10,
    offset: 0
  },
  'agent:launch': {
    mineId: U1,
    way: { kind: 'supplier', providerId: 'claude' },
    model: 'opus',
    prompt: 'start here',
    jevOn: false,
    jevAutoAccept: false,
    requestId: U2
  },
  'agent:providers': { refresh: true },
  'agent:models': undefined,
  'agent:launchHeld': { mineId: LEGACY_MINE, provider: 'claude', prompt: 'start here' },
  'agent:launchHosted': { mineId: U1, command: 'my-cli --flag', prompt: 'go', requestId: U2 },
  'agent:answerQuestion': { askId: U1, answers: [{ step: 0, option: 'Yes' }], requestId: U2 },
  'agent:answerPermission': { askId: U1, decision: 'allow', requestId: U2 },
  'notifications:enabled:get': undefined,
  'notifications:enabled:set': true,
  'presence:visibleMines': { mineIds: [U1, U2] },
  'typography:preferences:get': undefined,
  'typography:preferences:set': TYPOGRAPHY,
  'jev:settings:get': undefined,
  'jev:apiKey:set': 'sk-test-key',
  'jev:apiKey:clear': undefined,
  'jev:route': { prompt: 'which model', mineId: U1 },
  'jev:preferences:set': {
    profile: 'balanced',
    default: { provider: 'claude' },
    delegation: false
  },
  'opencode:settings:get': undefined,
  'opencode:plugin:set': { on: true, origin: 'settings', requestId: U1 },
  'opencode:password:set': 'server-password',
  'opencode:password:clear': undefined,
  'launch-view:get': undefined,
  'launch-view:set': { area: 'mines', mineId: null },
  'dwarf:setName': { dwarfId: LEGACY_DWARF, name: 'Gimli' },
  'dwarf:resetName': LEGACY_DWARF,
  'diag:renderer:report': { event: 'renderer.error', errCode: 'TypeError', count: 3 },
  'tray:stopEverything:confirm': { confirmationId: CONFIRMATION, requestId: U2 },
  'tray:stopEverything:cancel': { confirmationId: CONFIRMATION }
}

/** A valid today request for every CHANGE row, whose today shape differs from its target. */
const VALID_TODAY_REQUESTS: Partial<Record<ChannelKey, unknown>> = {
  'dwarf:activate': LEGACY_DWARF,
  'dwarf:feed:page': {
    dwarfId: LEGACY_DWARF,
    before: { timestamp: '2026-09-30T10:00:00.000Z', text: 'older words' }
  },
  'mine:history': LEGACY_MINE,
  'dwarf:sendText': {
    dwarfId: LEGACY_DWARF,
    text: 'hello',
    pressEnter: true,
    attachments: [{ path: '/tmp/a.png', name: 'a.png', kind: 'image', bytes: 10 }]
  },
  'metrics:reset': undefined,
  'agent:launch': {
    mineId: LEGACY_MINE,
    provider: 'codex',
    prompt: 'go',
    permissionMode: 'default'
  },
  'agent:providers': undefined,
  'agent:launchHosted': { mineId: LEGACY_MINE, command: 'my-cli', prompt: 'go' },
  'agent:answerQuestion': {
    dwarfId: LEGACY_DWARF,
    toolUseId: 'toolu_01',
    answers: { 'Which one?': 'The first' }
  },
  'agent:answerPermission': { dwarfId: LEGACY_DWARF, toolUseId: 'toolu_02', decision: 'deny' },
  'presence:visibleMines': LEGACY_MINE,
  'jev:route': { prompt: 'which model' },
  'opencode:settings:get': undefined,
  'opencode:plugin:set': true,
  'opencode:password:set': 'server-password',
  'opencode:password:clear': undefined
}

const validToday = (key: ChannelKey): unknown =>
  key in VALID_TODAY_REQUESTS ? VALID_TODAY_REQUESTS[key] : VALID_REQUESTS[key]

// ---- the 14 §6.5 fuzz classes: one mutation per node of a valid payload

const OVERSIZED = 'x'.repeat(1_048_577)

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

type Mutation = { label: string; value: unknown }

/** Replace the node at `path` inside `root`, copying every container on the way. */
function replaceAt(root: unknown, path: (string | number)[], value: unknown): unknown {
  if (path.length === 0) return value
  const [head, ...rest] = path as [string | number, ...(string | number)[]]
  if (Array.isArray(root)) {
    const copy = [...root]
    copy[head as number] = replaceAt(copy[head as number], rest, value)
    return copy
  }
  const record = root as Record<string, unknown>
  return { ...record, [head]: replaceAt(record[head], rest, value) }
}

/** Every node of a payload with its path. */
function nodes(value: unknown, path: (string | number)[] = []): [(string | number)[], unknown][] {
  const children = Array.isArray(value)
    ? value.flatMap((item, i) => nodes(item, [...path, i]))
    : isPlainObject(value)
      ? Object.entries(value).flatMap(([key, item]) => nodes(item, [...path, key]))
      : []
  return [[path, value], ...children]
}

function wrongTypeOf(value: unknown): unknown {
  if (typeof value === 'string') return 42
  if (typeof value === 'number') return '42'
  if (typeof value === 'boolean') return 'true'
  if (value === undefined) return 'unexpected'
  return 42
}

const where = (path: (string | number)[]): string =>
  path.length === 0 ? 'the payload' : path.join('.')

/** An extra key, a wrong type or an oversized string, at every place of `valid` where one fits. */
function mutationsOf(valid: unknown): Mutation[] {
  const all = nodes(valid)
  return [
    ...all
      .filter(([, value]) => isPlainObject(value))
      .map(([path, value]) => ({
        label: `extra key at ${where(path)}`,
        value: replaceAt(valid, path, { ...(value as object), unexpectedKey: true })
      })),
    ...all
      .filter(([path]) => path.length <= 1)
      .map(([path, value]) => ({
        label: `wrong type at ${where(path)}`,
        value: replaceAt(valid, path, wrongTypeOf(value))
      })),
    ...all
      .filter(([, value]) => typeof value === 'string')
      .map(([path]) => ({
        label: `oversized string at ${where(path)}`,
        value: replaceAt(valid, path, OVERSIZED)
      }))
  ]
}

// ---- the router under test, with recording owners and a fake Electron event

/** Records every listener the router registers, by wire name. */
class RecordingIpcMain implements IpcMainRegistrar {
  readonly handled = new Map<
    string,
    (event: IpcSenderEvent, payload: unknown) => Promise<unknown>
  >()
  readonly listened = new Map<string, (event: IpcSenderEvent, payload: unknown) => void>()
  handle(
    channel: string,
    listener: (event: IpcSenderEvent, payload: unknown) => Promise<unknown>
  ): void {
    this.handled.set(channel, listener)
  }
  on(channel: string, listener: (event: IpcSenderEvent, payload: unknown) => void): void {
    this.listened.set(channel, listener)
  }
}

/** An owner that records what it served and answers `{ servedBy: <wire> }`. */
function recordingOwner() {
  const served: [string, unknown][] = []
  const target: RouteTarget = {
    async serve(channel, payload) {
      served.push([channel, payload])
      return { servedBy: channel }
    }
  }
  return { target, served }
}

const APP_ENTRY = 'file:///opt/DwarfAI/resources/app.asar/out/renderer/index.html'
const PANEL = 7
/** A fake `IpcMainInvokeEvent` / `IpcMainEvent` (17 §1.6). */
const eventFrom = (id: number, url: string): IpcSenderEvent => ({
  sender: { id },
  senderFrame: { url }
})
const FROM_PANEL = eventFrom(PANEL, APP_ENTRY)

function sendersWith(...modeWindows: number[]): SenderPolicy {
  const registry = createModeWindowRegistry()
  for (const id of modeWindows) registry.register(id)
  return { appEntry: APP_ENTRY, isModeWindow: (id) => registry.has(id) }
}

const helpers: readonly string[] = PRELOAD_HELPERS
const ROWS = (Object.keys(CHANNELS) as ChannelKey[]).filter(
  (key) => CHANNELS[key].kind !== 'push' && !helpers.includes(key)
)
/** The rows today's table routes; a NEW row listed in `unrouted.ts` has no route there and reaches no handler. */
const TODAY_ROUTED = ROWS.filter((key) => ROUTES.some((route) => route.channel === key))
const TODAY_WIRE: Partial<Record<ChannelKey, string>> = {
  'presence:visibleMines': 'panel:openMine'
}

/** Today's table: every row `legacy` with today's shape, served under its today wire name. */
function todayRouter() {
  const legacy = recordingOwner()
  const router = createRouter({
    routes: ROUTES,
    legacy: legacy.target,
    senders: sendersWith(PANEL)
  })
  const ipc = new RecordingIpcMain()
  router.register(ipc)
  const wire = (key: ChannelKey): string => TODAY_WIRE[key] ?? key
  return { router, ipc, served: legacy.served, wire }
}

/** A table where every CHANGE and NEW row is `host` with its target shape, served under its registry key. */
function targetRouter() {
  const legacy = recordingOwner()
  const host = recordingOwner()
  const targeted = ROWS.filter((key) => ['changed', 'new'].includes(CHANNELS[key].status))
  const routes: ChannelRoute[] = [
    ...ROUTES.filter((route) => !targeted.includes(route.channel)),
    ...targeted.map((channel): ChannelRoute => ({
      channel,
      owner: 'host',
      since: 'cut-1',
      parity: 'passed',
      shape: 'target'
    }))
  ]
  const router = createRouter({
    routes,
    legacy: legacy.target,
    host: host.target,
    senders: sendersWith(PANEL)
  })
  const ipc = new RecordingIpcMain()
  router.register(ipc)
  return { router, ipc, targeted, host, legacy }
}

/** Calls a row through the listener the router registered for it, as Electron would. */
async function call(
  ipc: RecordingIpcMain,
  wire: string,
  event: IpcSenderEvent,
  payload: unknown
): Promise<unknown> {
  const invoke = ipc.handled.get(wire)
  if (invoke) return invoke(event, payload)
  const send = ipc.listened.get(wire)
  if (!send) throw new Error(`no listener for ${wire}`)
  send(event, payload)
  await new Promise((resolve) => setTimeout(resolve, 0))
  return undefined
}

const todayResponseOf = (key: ChannelKey): z.ZodTypeAny =>
  (todayShapeOf(key) ?? CHANNELS[key]).response as z.ZodTypeAny

describe('registry fuzz', () => {
  it('[NFR-SEC-08, ADR-019] an extra key, a wrong type or an oversized string is refused with INVALID_PARAMS on a CHANGE or NEW row and never throws', async () => {
    const { router, ipc, targeted, host, legacy } = targetRouter()
    expect(targeted.length).toBeGreaterThan(0)
    let refused = 0
    for (const key of targeted) {
      const mutations = mutationsOf(VALID_REQUESTS[key])
      expect(mutations.length, key).toBeGreaterThan(0)
      for (const { label, value } of mutations) {
        const answer = call(ipc, key, FROM_PANEL, value)
        await expect(answer, `${key}: ${label}`).resolves.toEqual(
          CHANNELS[key].kind === 'invoke'
            ? {
                ok: false,
                error: { code: 'INVALID_PARAMS', message: expect.any(String), retryable: false }
              }
            : undefined
        )
        refused += 1
      }
      expect(router.refusalCount(key, 'INVALID_PARAMS'), `${key}: every refusal is counted`).toBe(
        mutations.length
      )
    }
    // TC-044-01: no handler ran for any of them.
    expect(host.served).toEqual([])
    expect(legacy.served).toEqual([])
    expect(refused).toBeGreaterThan(targeted.length)
  })

  it('[NFR-SEC-08, ADR-019] a KEEP row answers its legacy failure shape for an invalid payload', async () => {
    // TC-044-03: every KEEP invoke row has a legacy failure shape; today's own value parses as its today response.
    const keep = ROWS.filter((key) => CHANNELS[key].status === 'kept')
    for (const key of keep.filter((k) => CHANNELS[k].kind === 'invoke')) {
      const refusal = LEGACY_REFUSALS[key]
      expect(refusal, `${key} has a legacy failure shape`).toBeDefined()
      if (refusal && 'answer' in refusal) {
        expect(todayResponseOf(key).safeParse(refusal.answer).success, key).toBe(true)
      }
    }
    for (const key of keep) {
      const { ipc, served, wire } = todayRouter()
      for (const { label, value } of mutationsOf(validToday(key))) {
        served.length = 0
        const refusal = LEGACY_REFUSALS[key]
        const answer = await call(ipc, wire(key), FROM_PANEL, value)
        if (CHANNELS[key].kind === 'send' || refusal === undefined) {
          expect(answer, `${key}: ${label}`).toBeUndefined()
          expect(served, `${key}: ${label}`).toEqual([])
        } else if ('answer' in refusal) {
          expect(answer, `${key}: ${label}`).toEqual(refusal.answer)
          expect(served, `${key}: ${label}`).toEqual([])
        } else {
          // The unchanged state, read by a read-only row with no payload: the invalid payload reaches nothing.
          expect(answer, `${key}: ${label}`).toEqual({ servedBy: wire(refusal.unchanged) })
          expect(served, `${key}: ${label}`).toEqual([[wire(refusal.unchanged), undefined]])
        }
      }
    }
    // The shapes 14 names: `{opened:false, reason}`, `ShortcutState` unchanged, `JevSettings` unchanged.
    const { ipc, served } = todayRouter()
    expect(await call(ipc, 'mine:openPath', FROM_PANEL, { mineId: 42 })).toEqual({
      opened: false,
      reason: "That path is outside this mine's folder."
    })
    expect(await call(ipc, 'shortcut:set', FROM_PANEL, OVERSIZED)).toEqual({
      servedBy: 'shortcut:get'
    })
    expect(await call(ipc, 'jev:apiKey:set', FROM_PANEL, { key: 'sk-test' })).toEqual({
      servedBy: 'jev:settings:get'
    })
    expect(served).toEqual([
      ['shortcut:get', undefined],
      ['jev:settings:get', undefined]
    ])
  })

  it("[ADR-001, ADR-019] a row served with today's shape answers today's failure shape for an invalid payload", async () => {
    // A NEW invoke row has no today shape and is never served with one (21 §1 item 2a): unrouted, it is refused as a
    // call with no route (router.test.ts), and a NEW send row is still dropped here like any one-way call.
    const reshaped = ROWS.filter(
      (key) =>
        CHANNELS[key].status !== 'kept' &&
        !(CHANNELS[key].status === 'new' && CHANNELS[key].kind === 'invoke')
    )
    for (const key of reshaped.filter((k) => CHANNELS[k].kind === 'invoke')) {
      const refusal = LEGACY_REFUSALS[key]
      expect(refusal, `${key} has today's failure shape`).toBeDefined()
      if (refusal && 'answer' in refusal) {
        expect(todayResponseOf(key).safeParse(refusal.answer).success, key).toBe(true)
      }
      if (refusal && 'unchanged' in refusal) {
        // The reader is a row with no payload whose today answer is the row's own today answer.
        const readerToday = todayShapeOf(refusal.unchanged) ?? CHANNELS[refusal.unchanged]
        expect(readerToday.request.safeParse(undefined).success, key).toBe(true)
        expect(todayResponseOf(refusal.unchanged), key).toBe(todayResponseOf(key))
      }
    }
    const { ipc, served, wire } = todayRouter()
    for (const key of reshaped) {
      for (const { label, value } of mutationsOf(validToday(key))) {
        served.length = 0
        const refusal = LEGACY_REFUSALS[key]
        const answer = await call(ipc, wire(key), FROM_PANEL, value)
        if (refusal === undefined || CHANNELS[key].kind === 'send') {
          expect(answer, `${key}: ${label}`).toBeUndefined()
          expect(served, `${key}: ${label}`).toEqual([])
        } else if ('answer' in refusal) {
          expect(answer, `${key}: ${label}`).toEqual(refusal.answer)
          expect(served, `${key}: ${label}`).toEqual([])
        } else {
          expect(served, `${key}: ${label}`).toEqual([[wire(refusal.unchanged), undefined]])
        }
      }
    }
  })

  it('[ADR-019] an invalid one-way payload is dropped and counted, and no handler runs', async () => {
    const sends = TODAY_ROUTED.filter((key) => CHANNELS[key].kind === 'send')
    expect(sends.length).toBeGreaterThan(0)
    const { router, ipc, served, wire } = todayRouter()
    for (const key of sends) {
      const mutations = mutationsOf(validToday(key))
      expect(mutations.length, key).toBeGreaterThan(0)
      for (const { value } of mutations) {
        expect(() => ipc.listened.get(wire(key))?.(FROM_PANEL, value), key).not.toThrow()
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(router.refusalCount(key, 'INVALID_PARAMS'), key).toBe(mutations.length)
    }
    expect(served).toEqual([])
  })

  it('[ADR-019] a valid payload reaches the routed handler unchanged', async () => {
    const today = todayRouter()
    for (const key of TODAY_ROUTED) {
      today.served.length = 0
      const payload = validToday(key)
      const answer = await call(today.ipc, today.wire(key), FROM_PANEL, payload)
      expect(today.served, key).toHaveLength(1)
      expect(today.served[0]?.[0], key).toBe(today.wire(key))
      expect(today.served[0]?.[1], `${key}: the very value the renderer sent`).toBe(payload)
      if (CHANNELS[key].kind === 'invoke') {
        expect(answer, key).toEqual({ servedBy: today.wire(key) })
      }
      expect(today.router.refusalCount(key, 'INVALID_PARAMS'), key).toBe(0)
    }
    const target = targetRouter()
    for (const key of target.targeted) {
      target.host.served.length = 0
      const payload = VALID_REQUESTS[key]
      await call(target.ipc, key, FROM_PANEL, payload)
      expect(target.host.served, key).toEqual([[key, payload]])
      expect(target.host.served[0]?.[1], key).toBe(payload)
    }
  })

  it('[ADR-019] a call from an unknown sender is ignored on every invoke and send row and no handler runs', async () => {
    // TC-044-02: a window that is not a mode window, and a mode window showing a foreign page.
    const strangers = [
      eventFrom(PANEL + 1, APP_ENTRY),
      eventFrom(PANEL, 'https://attacker.example/index.html')
    ]
    const today = todayRouter()
    const target = targetRouter()
    const tables = [
      { router: today.router, ipc: today.ipc, wire: today.wire, served: () => today.served },
      {
        router: target.router,
        ipc: target.ipc,
        wire: (key: ChannelKey) => (target.targeted.includes(key) ? key : today.wire(key)),
        served: () => [...target.host.served, ...target.legacy.served]
      }
    ]
    for (const { router, ipc, wire, served } of tables) {
      for (const key of ROWS) {
        for (const stranger of strangers) {
          const answer = await call(ipc, wire(key), stranger, validToday(key))
          expect(answer, key).toEqual(
            CHANNELS[key].kind === 'invoke'
              ? {
                  ok: false,
                  error: { code: 'SENDER_REJECTED', message: expect.any(String), retryable: false }
                }
              : undefined
          )
        }
        expect(router.refusalCount(key, 'SENDER_REJECTED'), key).toBe(strangers.length)
      }
      expect(served()).toEqual([])
    }
  })
})
