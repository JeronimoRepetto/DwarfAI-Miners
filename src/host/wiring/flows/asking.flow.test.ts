// layer: L2
// L2 flow (17 §1.2; 05 §4; 08 §2.7, §7.2; 16 §8.2, §8.3; ADR-010 items 1, 6, 11; ADR-018 items 2–3;
// ADR-016): the asking module wired into the Host (host/wiring/routes/askingRoutes.ts, ISSUE-140)
// over the composition host/main.ts builds: the members served before the bind, preferences at
// boot step 3 with the real config writer engine and its Claude Code hooks target over a FakeFs,
// then at step 4 suppliers, the ledger, conversation, the `ObservedBatchSink` bridge, observation
// over the real provider adapters, crew, mines, attention, asking and the cut-1 routes; step 7
// starts observation.
//
// The real boot step list, the Host dispatcher and connection registry behind in-process duplexes,
// one `ui` and one `notifier` client (frames validated against their contract schemas; no OS
// notification is ever drawn), one copy of the template database, a FakeClock, FakeScheduler and
// FakeProcessControl. The observed Claude session is the recorded fixture
// `fixtures/claude/hook-keystroke/2.1.x/pending-permission.jsonl` (synthetic, scrubbed), laid out in
// a per-test temp home folder in its real spelling, its working folder rewritten to a temp folder
// declared as a mine (17 §5.3). The Host is testing/askingHost.ts, shared with the L8 flow. Claude
// Code's hook requests reach the `/hooks/claude/*` route the wiring builds, in process: this L2
// Host does not run boot step 6's real listener (hookIngress.os.test.ts does, 17 §1.8), so where a
// case needs Claude Code instant updates on it persists the port as that listener would.
// The keystroke relay is the FakeKeystrokeRelay (the real one is later: ISSUE-167). No test reads
// the person's home folder or a provider credential (AGENTS §6).
//
// TC-140-01 … TC-140-04.
//
// ISSUE-229 (TC-229-02, TC-229-04): OpenCode plugin reports reach the `/opencode/*` route the
// wiring builds, in process, from an observed OpenCode session (a legacy-launched one is observed:
// still `legacy` until 4b); "OpenCode · permission requests" is set in its stored row with an
// active plugin token (the plugin file's writer is ISSUE-227/228's), and the `http` channel posts
// to a fake OpenCode server. A launched OpenCode session's auto-deny runs over the wiring's OpenCode
// part on a template copy (the last describe), since no launch reaches this Host before 4b.
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { frameCapability, methodCapability, redactSecrets } from '@dwarfai/contracts'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { FakeSecretReader } from '../../kernel/fakes/FakeSecretReader'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type {
  AskId,
  DwarfId,
  HostEpoch,
  IntegrationState,
  MessageId,
  ProviderId
} from '../../kernel/domain/values'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import {
  createAsking,
  createAskOpening,
  type AskCapabilities,
  type AskingEvent,
  type AskSession
} from '../../modules/asking'
import type { OpenCodeHttpPost } from '../../modules/asking/adapters/openCodePlugin/OpenCodePluginAskChannel'
import { FakeAnswerRecords } from '../../modules/asking/testing/FakeAnswerRecords'
import { FakeConversationLines } from '../../modules/asking/testing/FakeConversationLines'
import { seededAskDb } from '../../modules/asking/testing/sqliteAskDb'
import type { AnswerRecordEvent } from '../../modules/conversation'
import { OPENCODE_OBSERVED_CAPABILITIES, type ObservedSession } from '../../modules/observation'
import { inMemoryChannelTokens } from '../../modules/preferences/testing/inMemoryChannelTokens'
import { wireOpenCodePluginAsking } from '../routes/askingRoutes'
import { FsSourceWeightScanner } from '../../modules/mines/adapters/FsSourceWeightScanner'
import { INGRESS_TOKEN_HEADER } from '../../transport/ingress/httpIngress'
import { appMetaIngressPort } from '../bridges/ingressPort'
import {
  askOf,
  bootHost as bootAskingHost,
  CALL,
  cleanUp,
  evts,
  observedClaude as observedAskingClaude,
  permissionRequest,
  SESSION,
  world,
  type BootOptions
} from './testing/askingHost'

const OPENCODE_ID = 'opencode' as ProviderId

afterEach(cleanUp)

/** The Host as host/main.ts composes it, with the mines' real source-weight scanner. */
function bootHost(w: ReturnType<typeof world>, options: Partial<BootOptions> = {}) {
  return bootAskingHost(w, { scanner: new FsSourceWeightScanner(), ...options })
}

/** `observedClaude` over that Host. */
function observedClaude(options: Partial<BootOptions> = {}) {
  return observedAskingClaude({ scanner: new FsSourceWeightScanner(), ...options })
}

describe('the asking module wired into the Host (ISSUE-140)', () => {
  it('[ADR-010] an observed Claude permission opens one ask, the dwarf becomes asking, the ui receives ask.opened and the notifier receives one notification when its mine is not on screen', async () => {
    const { w, h, mineId, ui, notifier, token, dwarfId } = await observedClaude()
    expect(h.crew.crew.queries.get(dwarfId)?.status).toBe('working')

    expect(await h.hook(token, permissionRequest(w))).toBe(204)
    await h.settle(ui, notifier)

    const ask = askOf(h, dwarfId)
    expect(ask).toMatchObject({
      dwarfId,
      kind: 'permission',
      channel: 'hook-keystroke',
      providerRequestId: CALL,
      state: 'open',
      reannounce: true
    })
    expect(h.crew.crew.queries.get(dwarfId)?.status).toBe('asking')
    expect(evts<{ ask: { id: string } }>(ui, 'ask.opened').map((f) => f.ask.id)).toEqual([ask?.id])
    expect(evts<{ key: string; kind: string }>(notifier, 'attention.notify')).toEqual([
      expect.objectContaining({ key: `${dwarfId}:permission:${ask?.id}`, kind: 'permission' })
    ])
    // The ask joins the snapshot's `asks` section and the needs-you queue.
    expect(h.asking.queries.snapshot()).toMatchObject({
      asks: [expect.objectContaining({ id: ask?.id })],
      needsYou: [expect.objectContaining({ dwarfId, mineId })]
    })
  })

  it('[ADR-010] answering it in the app presses the key, closes the ask answered-in-app, withdraws the notification and the dwarf leaves asking', async () => {
    const { w, h, ui, notifier, token, dwarfId } = await observedClaude()
    await h.hook(token, permissionRequest(w))
    await h.settle(ui, notifier)
    const ask = askOf(h, dwarfId)
    if (ask === null) throw new Error('no ask opened')

    const answered = await h.call(ui, 'asking.answerPermission', {
      askId: ask.id,
      decision: 'allow',
      requestId: h.rid()
    })
    await h.settle(ui, notifier)

    expect(answered).toMatchObject({ ok: true, result: { kind: 'accepted' } })
    expect(h.relay.pressed.map((p) => p.key)).toEqual([{ kind: 'text', text: '1' }])
    expect(h.events<{ askId: string; reason: string }>('AskClosed')).toEqual([
      expect.objectContaining({ askId: ask.id, reason: 'answered-in-app' })
    ])
    expect(evts(ui, 'ask.closed')).toEqual([{ askId: ask.id, dwarfId, reason: 'answered-in-app' }])
    expect(evts<{ keys: string[] }>(notifier, 'attention.withdraw')).toEqual([
      expect.objectContaining({ keys: [`${dwarfId}:permission:${ask.id}`] })
    ])
    // S1.13: its turn is still active, so the dwarf is working again.
    expect(h.crew.crew.queries.get(dwarfId)?.status).toBe('working')
  })

  it('[S6.11] answering it in the terminal closes the ask answered-elsewhere with no notice and withdraws the notification', async () => {
    const { w, h, ui, notifier, token, dwarfId } = await observedClaude()
    await h.hook(token, permissionRequest(w))
    await h.settle(ui, notifier)
    const ask = askOf(h, dwarfId)
    if (ask === null) throw new Error('no ask opened')
    const framesBefore = ui.frames.length

    w.resolveInTerminal()
    await h.hook(token, { hook_event_name: 'PostToolUse', session_id: SESSION, tool_name: 'Bash' })
    await h.settle(ui, notifier)

    expect(h.asking.queries.openAskOf(dwarfId)).toBeNull()
    expect(evts(ui, 'ask.closed')).toEqual([
      { askId: ask.id, dwarfId, reason: 'answered-elsewhere' }
    ])
    // No notice: no toast and nothing pressed.
    expect(evts(ui, 'toast')).toEqual([])
    expect(h.relay.pressed).toEqual([])
    expect(evts<{ keys: string[] }>(notifier, 'attention.withdraw')).toEqual([
      expect.objectContaining({ keys: [`${dwarfId}:permission:${ask.id}`] })
    ])
    expect(ui.frames.length).toBeGreaterThan(framesBefore)
    expect(h.crew.crew.queries.get(dwarfId)?.status).toBe('working')
  })

  it('[ADR-002, S12.14, S12.15] an open ask holds the upgrade drain, and the Host closes for the upgrade as soon as it is answered elsewhere', async () => {
    const { w, h, ui, notifier, token, dwarfId } = await observedClaude()
    await h.hook(token, permissionRequest(w))
    await h.settle(ui, notifier)
    expect(askOf(h, dwarfId)?.state).toBe('open')

    h.drain.enter('upgrade-1290')
    h.drain.start()
    await h.settle(ui, notifier)

    expect(h.closes).toEqual([])

    // The ask closing asks the drain again at once: no drain tick passes (the clock stands still).
    w.resolveInTerminal()
    await h.hook(token, { hook_event_name: 'PostToolUse', session_id: SESSION, tool_name: 'Bash' })
    await h.settle(ui, notifier)

    expect(h.asking.queries.openAskOf(dwarfId)).toBeNull()
    expect(h.closes).toEqual(['upgrade'])
  })

  it('[S6.14, INV-77] the dwarf departing closes its open asks closed-by-death', async () => {
    const { w, h, ui, notifier, token, dwarfId } = await observedClaude()
    await h.hook(token, permissionRequest(w))
    await h.settle(ui, notifier)
    const ask = askOf(h, dwarfId)
    if (ask === null) throw new Error('no ask opened')
    const asking = h.conversation.conversation.queries.outcomeOf(dwarfId)

    h.crew.crew.commands.sessionClosed(dwarfId, 'closed-elsewhere')
    await h.settle(ui, notifier)

    expect(h.asking.queries.openAskOf(dwarfId)).toBeNull()
    expect(h.events<{ askId: string; reason: string }>('AskClosed')).toEqual([
      expect.objectContaining({ askId: ask.id, reason: 'closed-by-death' })
    ])
    expect(evts(ui, 'ask.closed')).toEqual([{ askId: ask.id, dwarfId, reason: 'closed-by-death' }])
    expect(
      evts<{ keys: string[] }>(notifier, 'attention.withdraw').flatMap((f) => f.keys)
    ).toContain(`${dwarfId}:permission:${ask.id}`)
    // The outcome line no longer says the dwarf waits on the person (noteAsk closed).
    expect(asking?.kind).toBe('waiting-on-you')
    expect(h.conversation.conversation.queries.outcomeOf(dwarfId)?.kind).not.toBe('waiting-on-you')
  })

  it('[INV-103] a re-raised ask with reannounce false opens with no notification', async () => {
    const { h, ui, notifier, dwarfId } = await observedClaude()
    // A re-raise after a silent resume (07 S6.19) reaches the Host with EPIC-10's driver resume; its
    // record is the broker's, stored and then announced with `reannounce: false`.
    const askId = '00000000-0000-7000-8000-000000140aa1' as AskId
    const reraised = {
      id: askId,
      dwarfId,
      kind: 'permission' as const,
      channel: 'driver' as const,
      providerRequestId: 'request-reraised',
      payload: { toolName: 'Bash', requestText: 'pnpm test' },
      currentStep: 0,
      state: 'open' as const,
      reannounce: false,
      openedAt: h.clock.now()
    }
    h.db.run(
      `INSERT INTO asks (id, dwarf_id, kind, channel, provider_request_id, payload_json, state,
         reannounce, opened_at)
       VALUES (?, ?, 'permission', 'driver', ?, ?, 'open', 0, ?)`,
      [askId, dwarfId, reraised.providerRequestId, JSON.stringify(reraised.payload), h.clock.now()]
    )

    h.publishAsking({ type: 'AskOpened', payload: { ask: reraised } } as never)
    await h.settle(ui, notifier)

    expect(evts<{ ask: { id: string } }>(ui, 'ask.opened').map((f) => f.ask.id)).toEqual([askId])
    expect(h.crew.crew.queries.get(dwarfId)?.status).toBe('asking')
    expect(evts(notifier, 'attention.notify')).toEqual([])
  })

  it('[ADR-003] hello.ok advertises the asking methods, section:asks and the ask frames', async () => {
    const h = await bootHost(world())

    const ui = await h.attach('ui')

    const capabilities = (ui.frames[0] as { capabilities: readonly string[] }).capabilities
    expect(capabilities).toEqual(
      expect.arrayContaining([
        methodCapability('asking.answerQuestion'),
        methodCapability('asking.answerPermission'),
        methodCapability('asking.setStep'),
        'section:asks',
        frameCapability('ask.opened'),
        frameCapability('ask.closed'),
        frameCapability('ask.step')
      ])
    )
  })

  it('[ADR-010] the same observed ask evidence twice opens one ask', async () => {
    const { w, h, ui, notifier, token, dwarfId } = await observedClaude()

    await h.hook(token, permissionRequest(w))
    await h.hook(token, permissionRequest(w))
    await h.hook(token, {
      hook_event_name: 'Notification',
      session_id: SESSION,
      notification_type: 'permission_prompt'
    })
    await h.settle(ui, notifier)

    expect(h.events('AskOpened')).toHaveLength(1)
    expect(evts(ui, 'ask.opened')).toHaveLength(1)
    expect(evts(notifier, 'attention.notify')).toHaveLength(1)
    expect(h.asking.queries.openAsks().filter((a) => a.dwarfId === dwarfId)).toHaveLength(1)
  })

  it('[ADR-016] turning Claude Code instant updates on makes the hook ingress accept a request with the new token', async () => {
    const w = world()
    const h = await bootHost(w)
    const ui = await h.attach('ui')
    const body = { hook_event_name: 'Stop', session_id: SESSION }
    // Off: the ingress refuses every request (ADR-012 item 6).
    expect(await h.hook('a'.repeat(64), body)).toBe(401)

    const token = await h.instantUpdatesOn(ui)

    expect(await h.hook(token, body)).toBe(204)
    expect(INGRESS_TOKEN_HEADER).toBe('x-dwarfai-token')
    // NFR-SEC-12: neither the token nor its hash reaches a log record.
    expect(JSON.stringify(h.log.entries)).not.toContain(token)
  })

  it('[ADR-016] a request at the hook ingress with the previous token is refused once the token rotated', async () => {
    const w = world()
    const h = await bootHost(w)
    const ui = await h.attach('ui')
    const body = { hook_event_name: 'Stop', session_id: SESSION }
    const previous = await h.instantUpdatesOn(ui)
    const off = await h.call(ui, 'preferences.setClaudeHooks', { on: false, requestId: h.rid() })
    expect(off).toMatchObject({ ok: true, result: { ok: true } })

    const next = await h.instantUpdatesOn(ui)

    expect(next).not.toBe(previous)
    expect(await h.hook(previous, body)).toBe(401)
    expect(await h.hook(next, body)).toBe(204)
  })

  it('[S1.16] an auto-denied ask leaves the dwarf status and its outcome line unchanged', async () => {
    const { w, h, ui, notifier, token, dwarfId } = await observedClaude()
    await h.hook(token, permissionRequest(w))
    await h.settle(ui, notifier)
    const outcome = h.conversation.conversation.queries.outcomeOf(dwarfId)
    const statusChanges = h.events('DwarfStatusChanged').length

    h.publishAsking({
      type: 'AskClosed',
      payload: {
        askId: '00000000-0000-7000-8000-000000140ad1' as AskId,
        dwarfId,
        reason: 'auto-denied'
      }
    } as never)
    await h.settle(ui, notifier)

    expect(h.crew.crew.queries.get(dwarfId)?.status).toBe('asking')
    expect(h.events('DwarfStatusChanged')).toHaveLength(statusChanges)
    expect(h.conversation.conversation.queries.outcomeOf(dwarfId)).toEqual(outcome)
    expect(evts(notifier, 'attention.withdraw')).toEqual([])
  })

  it('[S1.18] after a Host restart the dwarf with an open ask is asking again', async () => {
    const { w, h, ui, notifier, token, dwarfId } = await observedClaude()
    await h.hook(token, permissionRequest(w))
    await h.settle(ui, notifier)
    h.asking.stop()

    const next = await bootHost(w)

    expect(next.crew.crew.queries.get(dwarfId)?.status).toBe('asking')
    expect(next.asking.queries.openAskOf(dwarfId)?.providerRequestId).toBe(CALL)
  })

  it('[ADR-002] once the routes stopped, a departure closes no ask and no ask frame is sent', async () => {
    const { w, h, ui, notifier, token, dwarfId } = await observedClaude()
    await h.hook(token, permissionRequest(w))
    await h.settle(ui, notifier)
    const frames = evts(ui, 'ask.closed').length

    h.asking.stop()
    h.crew.crew.commands.sessionClosed(dwarfId, 'closed-elsewhere')
    await h.settle(ui, notifier)

    expect(h.asking.queries.openAskOf(dwarfId)?.state).toBe('open')
    expect(evts(ui, 'ask.closed')).toHaveLength(frames)
  })

  it('[S41.09, ADR-016] wiring the hook ingress route persists no ingress port: the listener is boot step 6', async () => {
    const w = world()

    await bootHost(w)

    expect(appMetaIngressPort(w.db as SqliteDatabase).read()).toBeNull()
  })
})

/** A `permission.asked` report of an OpenCode session as the written plugin posts it (S-011-1). */
function openCodeAsked(sessionId: string, requestId: string): Record<string, unknown> {
  return {
    event: {
      type: 'permission.asked',
      properties: {
        id: requestId,
        sessionID: sessionId,
        permission: 'bash',
        patterns: ['git status']
      }
    },
    serverUrl: 'http://127.0.0.1:4096/'
  }
}

describe('OpenCode plugin asks in the Host (ISSUE-229)', () => {
  it('[C-27, ADR-011] with opencode-permissions on-verified a plugin permission report opens one card in the Host broker', async () => {
    const w = world()
    const h = await bootHost(w)
    const mineId = await h.mine()
    const { ui, notifier } = await h.clients()
    const dwarfId = h.openCodeDwarf(mineId, 'ses-oc')

    // on-unverified: the token works, but the observed session's request is no ask (ADR-011 item 4).
    const unverified = h.openCodePermissions('on-unverified')
    expect(await h.openCodeReport(unverified, openCodeAsked('ses-oc', 'per-1'))).toBe(204)
    await h.settle(ui, notifier)
    expect(askOf(h, dwarfId)).toBeNull()

    // off: the plugin token is revoked with the integration, so nothing arrives at all.
    h.openCodePermissions('off')
    expect(await h.openCodeReport(unverified, openCodeAsked('ses-oc', 'per-2'))).toBe(401)

    const verified = h.openCodePermissions('on-verified')
    // A reply report is evidence of a reply only: it opens nothing.
    expect(
      await h.openCodeReport(verified, {
        event: {
          type: 'permission.replied',
          properties: { sessionID: 'ses-oc', requestID: 'per-3' }
        },
        serverUrl: null
      })
    ).toBe(204)
    expect(askOf(h, dwarfId)).toBeNull()
    // OpenCode reports an ask once, but a repeated report never opens a second card (INV-71).
    expect(await h.openCodeReport(verified, openCodeAsked('ses-oc', 'per-3'))).toBe(204)
    expect(await h.openCodeReport(verified, openCodeAsked('ses-oc', 'per-3'))).toBe(204)
    await h.settle(ui, notifier)

    expect(askOf(h, dwarfId)).toMatchObject({
      kind: 'permission',
      channel: 'http',
      providerRequestId: 'per-3',
      state: 'open',
      payload: { toolName: 'bash', requestText: 'bash: git status' }
    })
    expect(evts(ui, 'ask.opened')).toHaveLength(1)
    expect(h.crew.crew.queries.get(dwarfId)?.status).toBe('asking')
    expect(h.openCodeRequests).toEqual([])
  })

  it('[ADR-011] a plugin ask of a legacy-launched OpenCode session reaches the Host broker and is answered by the Host', async () => {
    const w = world()
    const h = await bootHost(w)
    const mineId = await h.mine()
    const { ui, notifier } = await h.clients()
    const dwarfId = h.openCodeDwarf(mineId, 'ses-oc')
    const token = h.openCodePermissions('on-verified')

    const answers: string[] = []
    for (const [requestId, decision] of [
      ['per-allow', 'allow'],
      ['per-deny', 'deny']
    ] as const) {
      await h.openCodeReport(token, openCodeAsked('ses-oc', requestId))
      await h.settle(ui, notifier)
      const ask = askOf(h, dwarfId)
      if (ask === null) throw new Error('no ask opened')
      const answered = await h.call(ui, 'asking.answerPermission', {
        askId: ask.id,
        decision,
        requestId: h.rid()
      })
      await h.settle(ui, notifier)
      expect(answered).toMatchObject({ ok: true, result: { kind: 'accepted' } })
      answers.push(ask.id)
    }

    expect(h.events<{ askId: string; reason: string }>('AskClosed')).toEqual(
      answers.map((askId) => expect.objectContaining({ askId, reason: 'answered-in-app' }))
    )
    // Allow is once, Deny is reject, to the server that asked, in the session's folder, with the
    // password only in the Authorization header.
    const authorization = `Basic ${Buffer.from(`opencode:${h.openCodePassword}`).toString('base64')}`
    const directory = encodeURIComponent(h.openCodeFolderOf('ses-oc'))
    expect(h.openCodeRequests).toEqual([
      {
        url: `http://127.0.0.1:4096/permission/per-allow/reply?directory=${directory}`,
        headers: { 'content-type': 'application/json', authorization },
        body: { reply: 'once' }
      },
      {
        url: `http://127.0.0.1:4096/permission/per-deny/reply?directory=${directory}`,
        headers: { 'content-type': 'application/json', authorization },
        body: { reply: 'reject' }
      }
    ])
  })
})

const EPOCH = 'epoch-0229' as HostEpoch
const SERVER_URL = 'http://127.0.0.1:4096/'

/** The OpenCode observation adapter's declaration as the asking wiring reads it (omitted → none). */
const OPENCODE_DECLARED: AskCapabilities = {
  permission: OPENCODE_OBSERVED_CAPABILITIES.permission ?? 'none',
  question: OPENCODE_OBSERVED_CAPABILITIES.question ?? 'none',
  observedPermission: OPENCODE_OBSERVED_CAPABILITIES.observedPermission ?? 'none',
  observedQuestion: OPENCODE_OBSERVED_CAPABILITIES.observedQuestion ?? 'none'
}

/** The text of the one chat line an auto-denied request leaves (ADR-011 item 3, owner-approved). */
const AUTO_DENIED_LINE = 'Declined automatically: this request cannot be answered from the panel.'

/** A `permission.asked` report as the written plugin posts it (S-011-1 event shape). */
function pluginReport(sessionId: string, requestId: string): string {
  return JSON.stringify({
    event: {
      id: `evt-${requestId}`,
      type: 'permission.asked',
      properties: {
        id: requestId,
        sessionID: sessionId,
        permission: 'edit',
        patterns: ['deny-probe.txt'],
        metadata: { filepath: '/work/mine-one/deny-probe.txt', diff: '+probe' },
        always: ['*'],
        tool: { messageID: 'msg-1', callID: 'call-1' }
      }
    },
    serverUrl: SERVER_URL
  })
}

/**
 * conversation's answers-records as the double keeps them, each also written as the `messages` row
 * `ask_answers.message_id` references (09 §4.5), inside the answer's transaction.
 */
class StoredAnswerRecords extends FakeAnswerRecords {
  constructor(
    private readonly db: SqliteDatabase,
    deps: ConstructorParameters<typeof FakeAnswerRecords>[0]
  ) {
    super(deps)
  }

  override write(dwarfId: DwarfId, askId: AskId, text: string, existing?: MessageId): MessageId {
    const id = super.write(dwarfId, askId, text, existing)
    if (existing === undefined) {
      this.db.run(
        `INSERT INTO messages (id, dwarf_id, role, text, origin, created_at, ask_id)
         VALUES (?, ?, 'answers-record', ?, 'dwarfai', 0, ?)`,
        [id, dwarfId, text, askId]
      )
    }
    return id
  }
}

/**
 * The asking wiring's OpenCode part (`wireOpenCodePluginAsking`) composed over the broker on a
 * migrated template copy, with a launched OpenCode dwarf: the full Host above has no launch path
 * before EPIC-10 and 4b, so suppliers' launched capabilities are the catalogue's gate as data.
 * `observed` and `launched` are its dwarfs.
 */
function composedOpenCodeHost() {
  const seeded = seededAskDb()
  const { runner, clock } = seeded
  const [observed, launched] = seeded.dwarfs
  const scheduler = new FakeScheduler(clock)
  const ids = new SequenceIdGenerator()
  const log = new RecordingDiagnosticsLog()
  const bus = new RecordingEventBus<AskingEvent | AnswerRecordEvent>({ transactionScope: runner })
  const lines = new FakeConversationLines(runner)
  const tokens = inMemoryChannelTokens()
  const password = randomBytes(12).toString('hex')
  const secrets = new FakeSecretReader({ scheduler, values: { 'opencode-password': password } })
  const received: Array<{ url: string; headers: Record<string, string>; body: unknown }> = []
  const post: OpenCodeHttpPost = (url, init) => {
    received.push({ url, headers: { ...init.headers }, body: JSON.parse(init.body) })
    return Promise.resolve({ status: 200, text: () => Promise.resolve('true') })
  }
  let state: IntegrationState = 'on-verified'

  /** The sessions observation knows: a legacy-launched one it observes, and a Host-launched one. */
  const sessions = new Map<string, ObservedSession>([
    ['ses-observed', { dwarfId: observed, cwd: '/work/mine-one' } as ObservedSession],
    ['ses-launched', { dwarfId: launched, cwd: '/work/mine-one' } as ObservedSession]
  ])
  const asks = seeded.open()
  let open: ReturnType<typeof createAskOpening>['open'] = () => {
    throw new Error('not wired')
  }
  const wired = wireOpenCodePluginAsking({
    providerId: OPENCODE_ID,
    sessions: {
      byIdentity: (identity) =>
        identity.providerId === OPENCODE_ID
          ? (sessions.get(identity.providerSessionId) ?? null)
          : null
    },
    asks: { open: (dwarfId, input) => open(dwarfId, input) },
    preferences: {
      queries: { integrationState: () => state },
      channelTokens: tokens.store
    },
    observation: { nudge: () => undefined },
    secrets,
    post,
    scheduler,
    redact: redactSecrets,
    log
  })
  const channelFor = (channel: string) => (channel === 'http' ? wired.channel : null)

  /** Suppliers' launched OpenCode capabilities: the catalog ceiling only while the gate is open. */
  const launchedCapabilities = (): AskCapabilities =>
    state === 'on-verified'
      ? {
          permission: 'interactive',
          question: 'none',
          observedPermission: 'none',
          observedQuestion: 'none'
        }
      : {
          permission: 'none',
          question: 'none',
          observedPermission: 'none',
          observedQuestion: 'none'
        }
  const sessionOf = (dwarfId: DwarfId): AskSession =>
    dwarfId === launched
      ? { providerId: OPENCODE_ID, origin: 'launched', capabilities: launchedCapabilities() }
      : {
          providerId: OPENCODE_ID,
          origin: 'observed',
          capabilities: wired.observedCapabilities(OPENCODE_ID, OPENCODE_DECLARED)
        }

  const opening = createAskOpening({
    asks,
    sessions: { sessionOf },
    lines,
    joinedLines: lines,
    channelFor,
    transactions: runner,
    bus,
    clock,
    ids,
    hostEpoch: EPOCH
  })
  open = (dwarfId, input) => opening.open(dwarfId, input)
  const answering = createAsking({
    asks,
    records: new StoredAnswerRecords(seeded.db, { scope: runner, clock, ids }),
    channelFor,
    staleAnswerSafe: (channel) => channelFor(channel)?.capabilities.staleAnswerSafe ?? true,
    transactions: runner,
    bus,
    clock,
    scheduler,
    ids,
    hostEpoch: EPOCH
  })

  const pluginToken = tokens.issue('opencode-plugin', clock.now())
  /** One plugin request as the ingress serves it: the admission, then the accepted delivery. */
  const plugin = (body: string, token = pluginToken): 'accepted' | 401 | 400 => {
    if (!wired.route.admits(token)) return 401
    const delivery = wired.route.accept(body)
    if (delivery === null) return 400
    delivery()
    return 'accepted'
  }

  return {
    observed,
    launched,
    asks,
    bus,
    lines,
    received,
    password,
    answering,
    plugin,
    tokens,
    setState: (next: IntegrationState) => {
      state = next
    }
  }
}

/** Lets the answer channel's awaited secret read and post settle (no timer involved). */
async function settleAnswers(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

describe('the OpenCode plugin asks of a launched session (ISSUE-229)', () => {
  it("[C-27, ADR-011] with the gate off or on-unverified no card opens; a launched session's request is auto-denied with one chat line", async () => {
    const h = composedOpenCodeHost()
    h.setState('on-unverified')

    expect(h.plugin(pluginReport('ses-observed', 'per-2'))).toBe('accepted')
    expect(h.asks.byProviderRequest({ dwarfId: h.observed }, 'per-2')).toBeNull()

    expect(h.plugin(pluginReport('ses-launched', 'per-3'))).toBe('accepted')
    await settleAnswers()

    expect(h.bus.ofType('AskOpened')).toStrictEqual([])
    expect(h.asks.byProviderRequest({ dwarfId: h.launched }, 'per-3')?.state).toBe('auto-denied')
    expect(h.bus.ofType('AskClosed').map((event) => event.payload.reason)).toStrictEqual([
      'auto-denied'
    ])
    expect(h.lines.rows.map((row) => [row.dwarfId, row.entry.text])).toStrictEqual([
      [h.launched, AUTO_DENIED_LINE]
    ])
    // Denied through the OpenCode protocol, on the server that asked.
    expect(h.received.map((sent) => [sent.url, sent.body])).toStrictEqual([
      [
        'http://127.0.0.1:4096/permission/per-3/reply?directory=%2Fwork%2Fmine-one',
        { reply: 'reject' }
      ]
    ])

    // Off: the plugin token is revoked with the integration (ADR-016 item 1), so nothing arrives.
    h.setState('off')
    h.tokens.store.revoke('opencode-plugin', 2)
    expect(h.plugin(pluginReport('ses-launched', 'per-4'))).toBe(401)
    expect(h.asks.byProviderRequest({ dwarfId: h.launched }, 'per-4')).toBeNull()
  })
})
