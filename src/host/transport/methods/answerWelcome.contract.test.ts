// layer: L6
// L6 (17 §1.6): B-M40 `preferences.answerWelcome` over the real seam-B transport — frame codec,
// hello-first authentication, roles, the Host dispatcher main composes with its requestId
// de-duplication, the connection registry and its frame delivery — behind in-process duplexes
// (14 §2.3 B-M40, B-M14, §2.4 B-F24, B-F25, §1.6, §1.7, §3.4; ADR-016 item 5; 07 S41.04, S41.05;
// AMENDMENT-7). The module side is a scripted step publishing on the production event bus the way
// `PreferencesCommands.answerWelcome` does (its own behaviour is the L2 suite,
// modules/preferences/answerWelcome.test.ts); `IntegrationChanged` and `WelcomeStepChanged` reach
// the connections through the routes host/wiring composes (setClaudeHooks.ts, preferences.ts).
// Every frame is validated against its contract schema (14 §1.4).
//
// TC-223-01. The seam-A half (A-N32 `answerWelcome`) is its handler's test under src/ui-main/ipc.
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
  resFrameSchema,
  setOpenCodePermissionsParamsSchema
} from '@dwarfai/contracts'
import type { EventId, IntegrationId, IntegrationState } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingStopAll } from '../../kernel/fakes/RecordingStopAll'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { InProcessEventBus, type HandlerFailure } from '../../kernel/InProcessEventBus'
import type {
  HostPreferences,
  IntegrationSetting,
  PreferencesEvent,
  WelcomeChoice,
  WelcomeResult,
  WelcomeStepState
} from '../../modules/preferences'
import { emptyDrainGate } from '../../wiring/emptyDrainGate'
import { createHostDispatcher } from '../../wiring/hostDispatcher'
import { HelloThrottle } from '../auth/throttle'
import { UI_TOKEN_FILE, UiToken } from '../auth/uiToken'
import { collectCapabilities } from '../capabilities'
import { acceptConnection } from '../connection'
import { ConnectionRegistry } from '../connectionRegistry'
import { createUpgradeDrain } from '../lifecycle/drain'
import { HostStateHolder } from '../lifecycle/hostState'
import { METHOD_ROLES } from '../roles'
import { SectionRegistry } from '../snapshot/sectionRegistry'
import { FrameClient } from '../testing/frameClient'
import { inProcessDuplex } from '../testing/inProcessDuplex'
import { registerAnswerWelcome } from './answerWelcome'
import { createUpgradeTargetRule } from './hostUpgradeRequest'
import { PREFERENCES_FRAMES, publishPreferencesChanged } from './preferences'
import { publishIntegrationChanged, SET_CLAUDE_HOOKS_FRAMES } from './setClaudeHooks'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const EPOCH = 'epoch-0223'
const RID_1 = '01890a5d-ac96-774b-bcce-b302099a8061'
const RID_2 = '01890a5d-ac96-774b-bcce-b302099a8062'
const RID_3 = '01890a5d-ac96-774b-bcce-b302099a8063'
const T0 = 1_000

const PREFERENCES: HostPreferences = {
  subagentDelegationOn: false,
  routingProfile: 'balanced',
  systemNotificationsOn: true,
  openCodePermissionsOn: false
}

/**
 * The module side: a due step offering Claude Code. `answerWelcome` turns a ticked Claude Code on
 * with origin `first-run` and publishes `IntegrationChanged`, then settles the step and publishes
 * `WelcomeStepChanged`, as `WelcomeAnswerService` does; an answer while not due changes nothing.
 * `failWith` makes the next enable fail with that outcome and leaves Claude Code off.
 */
class ScriptedWelcome {
  readonly answers: WelcomeChoice[] = []
  private claude: IntegrationSetting = { id: 'claude-hooks', state: 'off', changedAt: T0 }
  private step: WelcomeStepState = {
    due: true,
    reason: 'first-run',
    legacyFound: [],
    offered: ['claude-hooks']
  }
  private failure: 'config-write-failed' | null = null
  private events = 0

  constructor(private readonly bus: InProcessEventBus<PreferencesEvent>) {}

  failWith(failure: 'config-write-failed'): void {
    this.failure = failure
  }

  get(): HostPreferences {
    return PREFERENCES
  }

  welcome(): WelcomeStepState {
    return {
      ...this.step,
      legacyFound: [...this.step.legacyFound],
      offered: [...this.step.offered]
    }
  }

  integrationSettings(): IntegrationSetting[] {
    return [{ ...this.claude }, { id: 'opencode-permissions', state: 'off', changedAt: T0 }]
  }

  answerWelcome(choice: WelcomeChoice): Promise<WelcomeResult> {
    this.answers.push(choice)
    const failure = this.failure
    this.failure = null
    let failed = false
    if (this.step.due) {
      if (choice.claudeHooks) {
        if (failure === null) {
          this.claude = {
            id: 'claude-hooks',
            state: 'on-verified',
            consentOrigin: 'first-run',
            changedAt: T0
          }
        } else {
          failed = true
        }
        this.integrationChanged('claude-hooks', this.claude.state)
      }
      this.step = { due: false, legacyFound: [], offered: ['claude-hooks'] }
      this.publish({ type: 'WelcomeStepChanged', payload: { state: this.welcome() } })
    }
    const claude =
      failure !== null && failed
        ? { state: this.claude.state, failure }
        : { state: this.claude.state }
    return Promise.resolve({ 'claude-hooks': claude, 'opencode-permissions': { state: 'off' } })
  }

  private integrationChanged(id: IntegrationId, state: IntegrationState): void {
    this.publish({ type: 'IntegrationChanged', payload: { id, state } })
  }

  private publish(
    event:
      | { type: 'IntegrationChanged'; payload: { id: IntegrationId; state: IntegrationState } }
      | { type: 'WelcomeStepChanged'; payload: { state: WelcomeStepState } }
  ): void {
    this.events += 1
    this.bus.publish({
      ...event,
      v: 1,
      id: `event-${this.events}` as EventId,
      at: T0,
      hostEpoch: EPOCH
    } as PreferencesEvent)
  }
}

function validateFrame(name: string, data: unknown): void {
  const schemas: Readonly<Record<string, z.ZodTypeAny | undefined>> = HOST_FRAME_SCHEMAS
  const schema = schemas[name]
  if (schema === undefined) throw new Error(`no contract schema for ${name}`)
  schema.parse(data)
}

/** One Host transport serving B-M40, B-F24 and B-F25: real connections, dispatcher and event bus. */
async function host() {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-223-answer-welcome-'))
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
  const welcome = new ScriptedWelcome(bus)
  registerAnswerWelcome(dispatcher, { commands: welcome, queries: welcome })
  publishIntegrationChanged(bus, connections, welcome)
  publishPreferencesChanged(bus, connections, welcome)
  // B-M14 as its toggle issue will serve it (later: ISSUE-228), with the contract's own params schema.
  const openCodeToggles: unknown[] = []
  dispatcher.registerMutating(
    'preferences.setOpenCodePermissions',
    setOpenCodePermissionsParamsSchema,
    METHOD_ROLES['preferences.setOpenCodePermissions'] ?? [],
    (params) => {
      openCodeToggles.push(params)
      return { ok: true, value: { state: 'off' } }
    }
  )

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
          frames: [...PREFERENCES_FRAMES, ...SET_CLAUDE_HOOKS_FRAMES],
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

  return { attach, welcome, openCodeToggles, handlerErrors }
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

function resultOf(res: Res): unknown {
  if (!res.ok) throw new Error(`refused: ${res.error.code}`)
  return res.result
}

function codeOf(res: Res): string | undefined {
  return res.ok ? undefined : res.error.code
}

/** The `evt` frame names and the `res` frames a client received, in order. */
function sequence(client: FrameClient): string[] {
  return client.frames.flatMap((frame) => {
    const { type, name } = frame as { type?: string; name?: string }
    if (type === 'res') return ['res']
    return type === 'evt' && name !== undefined ? [name] : []
  })
}

/** The data of the `name` frames a client received, in order. */
function framesNamed(client: FrameClient, name: string): unknown[] {
  return client.frames
    .filter((frame) => (frame as { type?: string }).type === 'evt')
    .map((frame) => evtFrameSchema.parse(frame))
    .filter((evt) => evt.name === name)
    .map((evt) => evt.data)
}

const SETTLED = { due: false, legacyFound: [], offered: ['claude-hooks'] }

describe('preferences.answerWelcome over seam B (B-M40)', () => {
  it('[ADR-016] preferences.answerWelcome sends integration.changed per integration touched, then preferences.changed with welcome due false, then the result', async () => {
    const { attach, welcome, handlerErrors } = await host()
    const caller = await attach('ui')
    const other = await attach('ui')
    const notifier = await attach('notifier')

    const res = await call(caller, 'preferences.answerWelcome', {
      claudeHooks: true,
      openCodePermissions: false,
      requestId: RID_1
    })
    await other.settle()

    const answered = {
      integrations: {
        'claude-hooks': { state: 'on-verified' },
        'opencode-permissions': { state: 'off' }
      },
      welcome: SETTLED
    }
    expect(resultOf(res)).toStrictEqual(answered)
    expect(
      HOST_METHOD_SCHEMAS['preferences.answerWelcome'].result.safeParse(resultOf(res)).success
    ).toBe(true)
    expect(welcome.answers).toStrictEqual([{ claudeHooks: true, openCodePermissions: false }])
    // Effects before response (14 §1.7): both frames precede the caller's own `res`.
    expect(sequence(caller).slice(-3)).toStrictEqual([
      'integration.changed',
      'preferences.changed',
      'res'
    ])
    const on = { id: 'claude-hooks', state: 'on-verified', consentOrigin: 'first-run' }
    expect(framesNamed(caller, 'integration.changed')).toStrictEqual([on])
    expect(framesNamed(other, 'integration.changed')).toStrictEqual([on])
    expect(framesNamed(other, 'preferences.changed')).toMatchObject([{ welcome: SETTLED }])
    expect(framesNamed(notifier, 'integration.changed')).toStrictEqual([])
    expect(framesNamed(notifier, 'preferences.changed')).toStrictEqual([])

    // A repeated requestId gets the first answer with no second effect (14 §1.6).
    const again = await call(caller, 'preferences.answerWelcome', {
      claudeHooks: false,
      openCodePermissions: false,
      requestId: RID_1
    })
    expect(resultOf(again)).toStrictEqual(answered)
    expect(welcome.answers).toHaveLength(1)
    expect(handlerErrors).toStrictEqual([])
  })

  it('[ADR-016] a failed write is in the result with the step settled, never a call error', async () => {
    const { attach, welcome } = await host()
    const caller = await attach('ui')
    welcome.failWith('config-write-failed')

    const res = await call(caller, 'preferences.answerWelcome', {
      claudeHooks: true,
      openCodePermissions: true,
      requestId: RID_2
    })

    expect(res.ok).toBe(true)
    expect(resultOf(res)).toStrictEqual({
      integrations: {
        'claude-hooks': { state: 'off', failure: 'config-write-failed' },
        'opencode-permissions': { state: 'off' }
      },
      welcome: SETTLED
    })
    expect(framesNamed(caller, 'integration.changed')).toStrictEqual([
      { id: 'claude-hooks', state: 'off' }
    ])
  })

  it('[ADR-003, ADR-016] a notifier gets FORBIDDEN; an origin, a missing tick or requestId gets INVALID_PARAMS before the module runs', async () => {
    const { attach, welcome } = await host()
    const ui = await attach('ui')
    const notifier = await attach('notifier')
    const ticks = { claudeHooks: true, openCodePermissions: false }

    expect(
      codeOf(await call(notifier, 'preferences.answerWelcome', { ...ticks, requestId: RID_1 }))
    ).toBe('FORBIDDEN')
    expect(
      codeOf(
        await call(ui, 'preferences.answerWelcome', {
          ...ticks,
          origin: 'first-run',
          requestId: RID_2
        })
      )
    ).toBe('INVALID_PARAMS')
    expect(codeOf(await call(ui, 'preferences.answerWelcome', ticks))).toBe('INVALID_PARAMS')
    expect(
      codeOf(await call(ui, 'preferences.answerWelcome', { claudeHooks: true, requestId: RID_3 }))
    ).toBe('INVALID_PARAMS')
    expect(welcome.answers).toStrictEqual([])
  })

  it('[ADR-016] preferences.setOpenCodePermissions with origin first-run gets INVALID_PARAMS', async () => {
    const { attach, openCodeToggles } = await host()
    const ui = await attach('ui')

    expect(
      codeOf(
        await call(ui, 'preferences.setOpenCodePermissions', {
          on: true,
          origin: 'first-run',
          requestId: RID_1
        })
      )
    ).toBe('INVALID_PARAMS')
    expect(openCodeToggles).toStrictEqual([])
    // Its own entry points still reach the toggle: only the first-run step carries `first-run`.
    const settings = await call(ui, 'preferences.setOpenCodePermissions', {
      on: true,
      origin: 'settings',
      requestId: RID_2
    })
    expect(resultOf(settings)).toStrictEqual({ ok: true, value: { state: 'off' } })
    expect(openCodeToggles).toHaveLength(1)
  })
})
