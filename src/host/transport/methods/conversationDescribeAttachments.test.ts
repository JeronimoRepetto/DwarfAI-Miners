// layer: L6
// L6 (17 §1.6): B-M28 `conversation.describeAttachments` (14 §2.3, §3.4; ADR-019 item 9; 16 §4.6)
// over the real seam-B transport — frame codec, hello-first authentication, roles, the Host
// dispatcher main composes — behind in-process duplexes, with the conversation module's command
// faked (the module's own rules are proven by its reader contract and its wiring flow,
// wiring/routes/conversation.test.ts). Every answer is validated against its contract schema (14 §1.4).
// A viewer cannot authenticate before its per-view token issuer exists (hello.ts, later:
// ISSUE-170), so its refusal is checked at the dispatcher, as conversation.mineHistory checks its own.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { HOST_METHOD_SCHEMAS, PROTOCOL_VERSION, resFrameSchema } from '@dwarfai/contracts'
import type { DwarfId } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingStopAll } from '../../kernel/fakes/RecordingStopAll'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { AttachmentPick, ConversationAttachmentCommand } from '../../modules/conversation'
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
import { registerConversationDescribeAttachments } from './conversationDescribeAttachments'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const EPOCH = 'epoch-0169'
const T0 = 1_790_000_000_000
/** A folder name that must never reach a log line: a path is sensitive (14 §3.5). */
const CANARY = 'canary-0169-private-folder'
const DWARF = '00000000-0000-7000-8000-0000000016a9' as DwarfId

const NOTES = `/home/p/${CANARY}/notes.txt`
const HUGE = `/home/p/${CANARY}/huge.mov`
const FOLDER = `/home/p/${CANARY}/a-folder`
const GONE = `/home/p/${CANARY}/gone.txt`

/** The module's command, answering a fixed pick per path and recording what it was asked. */
class FakeAttachmentCommand implements ConversationAttachmentCommand {
  readonly described: string[] = []
  private readonly picks = new Map<string, AttachmentPick>([
    [
      NOTES,
      { path: NOTES, attachment: { path: NOTES, name: 'notes.txt', kind: 'file', bytes: 12 } }
    ],
    [HUGE, { path: HUGE, refusal: 'file-too-large' }],
    [FOLDER, { path: FOLDER, refusal: 'directory' }]
  ])

  async describeAttachments(paths: string[]): Promise<AttachmentPick[]> {
    this.described.push(...paths)
    return paths.map((path) => this.picks.get(path) ?? { path, refusal: 'unreadable' })
  }
}

/** One Host transport serving B-M28 over a faked module command. */
async function host() {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-169-describe-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const token = new UiToken()
  await token.issue(join(root, 'run'))
  const secret = readFileSync(join(root, 'run', UI_TOKEN_FILE), 'utf8')
  const clock = new FakeClock(T0)
  const scheduler = new FakeScheduler(clock)
  const log = new RecordingDiagnosticsLog()
  const connections = new ConnectionRegistry()
  const state = new HostStateHolder(connections)
  state.report({ state: 'ready', jobStatus: 'none' })
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
    sections: new SectionRegistry(),
    snapshotMeta: {
      hostVersion: () => '0.21.0',
      state: () => state.current().state,
      resetEpoch: () => 0,
      snapshotTail: () => 20,
      minesEverKnown: () => true
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
  const conversation = new FakeAttachmentCommand()
  registerConversationDescribeAttachments(dispatcher, { conversation })

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
        collectCapabilities({ methods: dispatcher.methods(), frames: [], sections: [] }),
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
  const asViewer = (params: unknown) =>
    dispatcher.dispatch(
      { id: 'v-1', method: 'conversation.describeAttachments', params },
      { role: 'viewer', clientId: 'viewer-1', dwarfId: DWARF }
    )

  return { attach, asViewer, conversation, log }
}

let nextId = 0

type Res = z.infer<typeof resFrameSchema>

/** Sends one request and returns its `res` frame. */
async function call(client: FrameClient, method: string, params: unknown): Promise<Res> {
  nextId += 1
  const requestId = `req-${nextId}`
  client.send({ type: 'req', id: requestId, method, params })
  await client.until(() => client.frames.some((frame) => isRes(frame, requestId)))
  return resFrameSchema.parse(client.frames.find((frame) => isRes(frame, requestId)))
}

function isRes(frame: unknown, requestId: string): boolean {
  return (frame as { type?: string }).type === 'res' && (frame as { id?: string }).id === requestId
}

type Picks = z.infer<(typeof HOST_METHOD_SCHEMAS)['conversation.describeAttachments']['result']>

function picksOf(res: Res): Picks {
  if (!res.ok) throw new Error(`refused: ${res.error.code}`)
  return HOST_METHOD_SCHEMAS['conversation.describeAttachments'].result.parse(res.result)
}

function codeOf(res: Res): string | undefined {
  return res.ok ? undefined : res.error.code
}

describe('conversation.describeAttachments over seam B (B-M28)', () => {
  it('[ADR-019] conversation.describeAttachments params are strict and it answers one AttachmentPick per path', async () => {
    const { attach, asViewer, conversation } = await host()
    const ui = await attach('ui')

    // One pick per path, in the order asked: the accepted file with its name and size, each
    // refusal in A-25's names, the others kept.
    expect(
      picksOf(
        await call(ui, 'conversation.describeAttachments', {
          paths: [NOTES, HUGE, FOLDER, GONE]
        })
      )
    ).toStrictEqual([
      { path: NOTES, attachment: { path: NOTES, name: 'notes.txt', kind: 'file', bytes: 12 } },
      { path: HUGE, refusal: 'file-too-large' },
      { path: FOLDER, refusal: 'directory' },
      { path: GONE, refusal: 'unreadable' }
    ])
    expect(picksOf(await call(ui, 'conversation.describeAttachments', { paths: [] }))).toEqual([])
    expect(conversation.described).toEqual([NOTES, HUGE, FOLDER, GONE])

    // A notifier and a viewer are refused before any path is described.
    const notifier = await attach('notifier')
    expect(
      codeOf(await call(notifier, 'conversation.describeAttachments', { paths: [NOTES] }))
    ).toBe('FORBIDDEN')
    expect(codeOf(await asViewer({ paths: [NOTES] }))).toBe('FORBIDDEN')

    // The params are the strict() schema: anything else is INVALID_PARAMS before the handler runs.
    for (const params of [
      { paths: [NOTES], dwarfId: DWARF },
      { paths: NOTES },
      { paths: [42] },
      { paths: ['x'.repeat(32_768)] },
      {}
    ]) {
      expect(
        codeOf(await call(ui, 'conversation.describeAttachments', params)),
        JSON.stringify(params).slice(0, 80)
      ).toBe('INVALID_PARAMS')
    }
    expect(conversation.described).toEqual([NOTES, HUGE, FOLDER, GONE])
  })

  it('[NFR-SEC-12] a path in a describeAttachments call never reaches a log line', async () => {
    const { attach, log } = await host()
    const ui = await attach('ui')

    picksOf(await call(ui, 'conversation.describeAttachments', { paths: [NOTES, GONE] }))

    expect(
      log.byEvent('channel.req').some((e) => e.method === 'conversation.describeAttachments')
    ).toBe(true)
    expect(JSON.stringify([log.entries, log.refused])).not.toContain(CANARY)
  })
})
