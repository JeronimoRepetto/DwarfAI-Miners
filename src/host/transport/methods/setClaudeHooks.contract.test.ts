// layer: L6
// L6 (17 §1.6): B-M39 `preferences.setClaudeHooks` and B-F25 `integration.changed` over the real
// seam-B transport — frame codec, hello-first authentication, roles, the Host dispatcher main
// composes with its requestId de-duplication, the connection registry and its frame delivery —
// behind in-process duplexes (14 §2.3 B-M39, §2.4 B-F25, §1.6, §1.7, §3.4, §3.5; ADR-016 items 1,
// 5–7; 16 §7.4; AMENDMENT-7). The module side is a scripted toggle publishing on the production
// event bus, the way `PreferencesCommands.setClaudeHooks` does (its own behaviour is the L2 suite,
// modules/preferences/application/setClaudeHooks.test.ts). Every frame is validated against its
// contract schema (14 §1.4).
//
// TC-221-04. The seam-A half (A-N31 `setClaudeHooksEnabled`) waits for its registry row.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  evtFrameSchema,
  HOST_FRAME_SCHEMAS,
  HOST_METHOD_SCHEMAS,
  PROTOCOL_VERSION,
  resFrameSchema
} from '@dwarfai/contracts'
import type { EventId, IntegrationId, IntegrationState, Result } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingStopAll } from '../../kernel/fakes/RecordingStopAll'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { InProcessEventBus, type HandlerFailure } from '../../kernel/InProcessEventBus'
import type { ConsentOrigin, IntegrationSetting, PreferencesEvent } from '../../modules/preferences'
import { emptyDrainGate } from '../../wiring/emptyDrainGate'
import { createHostDispatcher } from '../../wiring/hostDispatcher'
import { HelloThrottle } from '../auth/throttle'
import { UI_TOKEN_FILE, UiToken } from '../auth/uiToken'
import { collectCapabilities } from '../capabilities'
import { acceptConnection } from '../connection'
import { ConnectionRegistry } from '../connectionRegistry'
import { createUpgradeDrain } from '../lifecycle/drain'
import { HostStateHolder } from '../lifecycle/hostState'
import { SectionRegistry } from '../snapshot/sectionRegistry'
import { FrameClient } from '../testing/frameClient'
import { inProcessDuplex } from '../testing/inProcessDuplex'
import { createUpgradeTargetRule } from './hostUpgradeRequest'
import {
  integrationChangedFrame,
  publishIntegrationChanged,
  registerSetClaudeHooks,
  SET_CLAUDE_HOOKS_FRAMES
} from './setClaudeHooks'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const EPOCH = 'epoch-0221'
const RID_1 = '01890a5d-ac96-774b-bcce-b302099a8061'
const RID_2 = '01890a5d-ac96-774b-bcce-b302099a8062'
const RID_3 = '01890a5d-ac96-774b-bcce-b302099a8063'
const T0 = 1_000

type ToggleFailure = 'config-write-failed' | 'config-revert-failed'

/**
 * The module side: `setClaudeHooks` keeps a stored setting, publishes `IntegrationChanged` with the
 * stored state after every outcome (a failed one with the unchanged state) and answers it, as
 * `PreferencesService` does. `script` makes the next call fail with that outcome.
 */
class ScriptedToggle {
  readonly calls: Array<{ on: boolean; origin: ConsentOrigin }> = []
  private setting: IntegrationSetting = { id: 'claude-hooks', state: 'off', changedAt: T0 }
  private next: ToggleFailure | null = null
  private events = 0

  constructor(private readonly bus: InProcessEventBus<PreferencesEvent>) {}

  script(failure: ToggleFailure): void {
    this.next = failure
  }

  integrationSettings(): IntegrationSetting[] {
    return [{ ...this.setting }, { id: 'opencode-permissions', state: 'off', changedAt: T0 }]
  }

  setClaudeHooks(
    on: boolean,
    origin: ConsentOrigin
  ): Promise<Result<{ state: IntegrationState }, ToggleFailure>> {
    this.calls.push({ on, origin })
    const failure = this.next
    this.next = null
    if (failure === null) {
      this.setting = on
        ? { id: 'claude-hooks', state: 'on-verified', consentOrigin: origin, changedAt: T0 }
        : { id: 'claude-hooks', state: 'off', changedAt: T0 }
    }
    const state = this.setting.state
    this.events += 1
    this.bus.publish({
      type: 'IntegrationChanged',
      v: 1,
      id: `event-${this.events}` as EventId,
      at: T0,
      hostEpoch: EPOCH,
      payload: { id: 'claude-hooks' satisfies IntegrationId, state }
    })
    return Promise.resolve(
      failure === null ? { ok: true, value: { state } } : { ok: false, error: failure }
    )
  }
}

function validateFrame(name: string, data: unknown): void {
  const schemas: Readonly<Record<string, z.ZodTypeAny | undefined>> = HOST_FRAME_SCHEMAS
  const schema = schemas[name]
  if (schema === undefined) throw new Error(`no contract schema for ${name}`)
  schema.parse(data)
}

/** One Host transport serving B-M39 and B-F25: real connections, dispatcher and event bus. */
async function host() {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-221-claude-hooks-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const token = new UiToken()
  await token.issue(join(root, 'run'))
  const secret = readFileSync(join(root, 'run', UI_TOKEN_FILE), 'utf8')
  const clock = new FakeClock(T0)
  const scheduler = new FakeScheduler(clock)
  const log = new RecordingDiagnosticsLog()
  const connections = new ConnectionRegistry({ validateFrame })
  const state = new HostStateHolder(connections)
  state.report({ state: 'ready', jobStatus: 'none' })
  const sections = new SectionRegistry()
  const ids = new SequenceIdGenerator()
  const lifecycle = { closeCleanly: () => Promise.resolve() }
  const dispatcher = createHostDispatcher({
    log,
    clock,
    scheduler,
    state: () => state.current().state,
    stopAll: new RecordingStopAll(),
    lifecycle,
    connections,
    epoch: EPOCH,
    ids,
    sections,
    snapshotMeta: {
      hostVersion: () => '0.21.0',
      state: () => state.current().state,
      resetEpoch: () => 0,
      snapshotTail: () => 20,
      minesEverKnown: () => false
    },
    drain: createUpgradeDrain({ gate: emptyDrainGate, state, scheduler, lifecycle, log }),
    upgradeTarget: createUpgradeTargetRule({
      platform: 'linux',
      root: null,
      realpath: () => {
        throw new Error('no copy root in this case')
      }
    })
  })

  const handlerErrors: HandlerFailure[] = []
  const bus = new InProcessEventBus<PreferencesEvent>({
    transactionScope: { isInTransaction: () => false },
    onHandlerError: (failure) => handlerErrors.push(failure)
  })
  const toggle = new ScriptedToggle(bus)
  registerSetClaudeHooks(dispatcher, { commands: toggle })
  publishIntegrationChanged(bus, connections, toggle)

  const throttle = new HelloThrottle(clock)
  /** Connects with `role` and returns the client once hello.ok arrived. */
  const attach = async (role: 'ui' | 'notifier'): Promise<FrameClient> => {
    const pair = inProcessDuplex()
    acceptConnection(pair.host, {
      token,
      ids,
      identity: { hostVersion: '0.21.0', buildId: 'abc1234', protocolVersion: PROTOCOL_VERSION },
      epoch: EPOCH,
      state: () => state.current(),
      capabilities: () =>
        collectCapabilities({
          methods: dispatcher.methods(),
          frames: SET_CLAUDE_HOOKS_FRAMES,
          sections: sections.names()
        }),
      scheduler,
      clock,
      log,
      dispatcher,
      connections,
      throttle
    })
    const client = new FrameClient(pair.client)
    cleanups.push(() => void pair.client.destroy())
    client.send({
      type: 'hello',
      endpointGeneration: 1,
      protocolVersion: PROTOCOL_VERSION,
      role,
      token: secret,
      client: { appVersion: '0.21.0', buildId: 'abc1234', pid: 4242 }
    })
    await client.settle()
    expect(client.frames[0]).toMatchObject({ type: 'hello.ok' })
    return client
  }

  return { attach, toggle, handlerErrors }
}

let nextId = 0

type Res = z.infer<typeof resFrameSchema>

/** Sends one request and returns its `res` frame. */
async function call(client: FrameClient, method: string, params: unknown): Promise<Res> {
  nextId += 1
  const id = `req-${nextId}`
  client.send({ type: 'req', id, method, params })
  await client.until(() => client.frames.some((frame) => isRes(frame, id)))
  return resFrameSchema.parse(client.frames.find((frame) => isRes(frame, id)))
}

function isRes(frame: unknown, id: string): boolean {
  return (
    (frame as { type?: string; id?: string }).type === 'res' && (frame as { id?: string }).id === id
  )
}

/** The `integration.changed` frames a client received, in order. */
function changedFrames(client: FrameClient): unknown[] {
  return client.frames
    .filter((frame) => (frame as { type?: string }).type === 'evt')
    .map((frame) => evtFrameSchema.parse(frame))
    .filter((evt) => evt.name === 'integration.changed')
    .map((evt) => evt.data)
}

function resultOf(res: Res): unknown {
  if (!res.ok) throw new Error(`refused: ${res.error.code}`)
  return res.result
}

function codeOf(res: Res): string | undefined {
  return res.ok ? undefined : res.error.code
}

/** Index of the first frame of `client` matching `pick`. */
function indexOf(client: FrameClient, pick: (frame: { type?: string; name?: string }) => boolean) {
  return client.frames.findIndex((frame) => pick(frame as { type?: string; name?: string }))
}

describe('preferences.setClaudeHooks and integration.changed over seam B (B-M39, B-F25)', () => {
  it('[ADR-016] preferences.setClaudeHooks reaches the module with origin settings and every ui connection gets integration.changed before the result', async () => {
    const { attach, toggle, handlerErrors } = await host()
    const caller = await attach('ui')
    const other = await attach('ui')
    const notifier = await attach('notifier')

    const on = await call(caller, 'preferences.setClaudeHooks', { on: true, requestId: RID_1 })
    await other.settle()

    expect(resultOf(on)).toStrictEqual({ ok: true, value: { state: 'on-verified' } })
    expect(
      HOST_METHOD_SCHEMAS['preferences.setClaudeHooks'].result.safeParse(resultOf(on)).success
    ).toBe(true)
    // The origin is the Host's: the Settings toggle is the only seam-B entry (AMENDMENT-7).
    expect(toggle.calls).toStrictEqual([{ on: true, origin: 'settings' }])
    // Effects before response (14 §1.7): the frame precedes the caller's own `res`.
    const changedAt = indexOf(caller, (frame) => frame.name === 'integration.changed')
    const resAt = indexOf(caller, (frame) => frame.type === 'res')
    expect(changedAt).toBeGreaterThan(0)
    expect(changedAt).toBeLessThan(resAt)
    const onFrame = { id: 'claude-hooks', state: 'on-verified', consentOrigin: 'settings' }
    expect(changedFrames(caller)).toStrictEqual([onFrame])
    expect(changedFrames(other)).toStrictEqual([onFrame])
    expect(changedFrames(notifier)).toStrictEqual([])

    // A repeated requestId gets the first answer with no second effect (14 §1.6).
    const again = await call(caller, 'preferences.setClaudeHooks', { on: true, requestId: RID_1 })
    expect(resultOf(again)).toStrictEqual(resultOf(on))
    expect(toggle.calls).toHaveLength(1)

    const off = await call(caller, 'preferences.setClaudeHooks', { on: false, requestId: RID_2 })
    await other.settle()
    expect(resultOf(off)).toStrictEqual({ ok: true, value: { state: 'off' } })
    expect(toggle.calls).toStrictEqual([
      { on: true, origin: 'settings' },
      { on: false, origin: 'settings' }
    ])
    expect(changedFrames(other)).toStrictEqual([onFrame, { id: 'claude-hooks', state: 'off' }])
    expect(handlerErrors).toStrictEqual([])
  })

  it('[ADR-016] preferences.setClaudeHooks answers the stored state, with config-write-failed and config-revert-failed as outcomes, never as call errors', async () => {
    const { attach, toggle } = await host()
    const caller = await attach('ui')
    const other = await attach('ui')

    toggle.script('config-write-failed')
    const failedWrite = await call(caller, 'preferences.setClaudeHooks', {
      on: true,
      requestId: RID_1
    })
    expect(failedWrite.ok).toBe(true)
    expect(resultOf(failedWrite)).toStrictEqual({ ok: false, error: 'config-write-failed' })

    await call(caller, 'preferences.setClaudeHooks', { on: true, requestId: RID_2 })
    toggle.script('config-revert-failed')
    const lockedOff = await call(caller, 'preferences.setClaudeHooks', {
      on: false,
      requestId: RID_3
    })
    await other.settle()
    expect(lockedOff.ok).toBe(true)
    expect(resultOf(lockedOff)).toStrictEqual({ ok: false, error: 'config-revert-failed' })
    expect(
      HOST_METHOD_SCHEMAS['preferences.setClaudeHooks'].result.safeParse(resultOf(lockedOff))
        .success
    ).toBe(true)
    // Every window shows the real state: off after the failed write, still on after the locked
    // turn-off (16 §7.4).
    const on = { id: 'claude-hooks', state: 'on-verified', consentOrigin: 'settings' }
    expect(changedFrames(other)).toStrictEqual([{ id: 'claude-hooks', state: 'off' }, on, on])
  })

  it('[ADR-003, ADR-016] a notifier gets FORBIDDEN; an origin, a missing requestId or another key gets INVALID_PARAMS before the module runs', async () => {
    const { attach, toggle } = await host()
    const ui = await attach('ui')
    const notifier = await attach('notifier')

    expect(
      codeOf(await call(notifier, 'preferences.setClaudeHooks', { on: true, requestId: RID_1 }))
    ).toBe('FORBIDDEN')
    for (const origin of ['settings', 'first-run', 'add-panel']) {
      expect(
        codeOf(
          await call(ui, 'preferences.setClaudeHooks', { on: true, origin, requestId: RID_2 })
        ),
        origin
      ).toBe('INVALID_PARAMS')
    }
    expect(codeOf(await call(ui, 'preferences.setClaudeHooks', { on: true }))).toBe(
      'INVALID_PARAMS'
    )
    expect(
      codeOf(await call(ui, 'preferences.setClaudeHooks', { on: 'yes', requestId: RID_3 }))
    ).toBe('INVALID_PARAMS')
    expect(toggle.calls).toStrictEqual([])
  })
})

// AMENDED for ISSUE-221 (appended, review F6): the frame names a consent origin only while the integration is on,
// whatever the stored row still carries.
describe('integrationChangedFrame (14 §3.5 B-F25)', () => {
  const event = (state: IntegrationState) =>
    ({
      type: 'IntegrationChanged',
      v: 1,
      id: 'event-1' as EventId,
      at: T0,
      hostEpoch: EPOCH,
      payload: { id: 'claude-hooks', state }
    }) as const
  const stored = (setting: IntegrationSetting) => ({ integrationSettings: () => [setting] })

  it('[ADR-016] an off frame carries no consent origin, even when the stored row still has one', () => {
    const frame = integrationChangedFrame(
      event('off'),
      stored({ id: 'claude-hooks', state: 'off', consentOrigin: 'settings', changedAt: T0 })
    )

    expect(frame).toStrictEqual({ id: 'claude-hooks', state: 'off' })
    validateFrame('integration.changed', frame)
    expect(
      integrationChangedFrame(
        event('on-verified'),
        stored({
          id: 'claude-hooks',
          state: 'on-verified',
          consentOrigin: 'first-run',
          changedAt: T0
        })
      )
    ).toStrictEqual({ id: 'claude-hooks', state: 'on-verified', consentOrigin: 'first-run' })
  })
})
