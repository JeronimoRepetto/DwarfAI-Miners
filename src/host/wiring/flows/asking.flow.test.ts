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
import { afterEach, describe, expect, it } from 'vitest'
import { frameCapability, methodCapability } from '@dwarfai/contracts'
import type { AskId } from '../../kernel/domain/values'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
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
