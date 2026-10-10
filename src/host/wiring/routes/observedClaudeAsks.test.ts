// layer: L2
// L2 (17 §1.2): the observed-Claude hook route (08 §4: hook ingress → asking `open` after resolving
// the session to its dwarf; ADR-012 items 3–6; ADR-010 item 10) over the asking module as the Host
// composes it — `createAskOpening` and `createAsking` over in-memory doubles, the real
// `PermissionPromptRegistry` and `ObservedClaudeKeystrokeChannel` — with a fake transcript tail and
// a fake keystroke relay recording keys. Composing it into the Host's main is later: ISSUE-140.
import { describe, expect, it } from 'vitest'
import { redactSecrets } from '../../../contracts/logging'
import type { DwarfId, ProviderId, ProviderIdentity } from '../../kernel/domain/values'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import type { AskRecord } from '../../modules/asking'
import { ObservedClaudeKeystrokeChannel } from '../../modules/asking/adapters/observedClaude/ObservedClaudeKeystrokeChannel'
import { PermissionPromptRegistry } from '../../modules/asking/adapters/observedClaude/permissionPromptRegistry'
import { FakeKeystrokeRelay } from '../../modules/asking/testing/FakeKeystrokeRelay'
import { FakeTranscriptTail } from '../../modules/asking/testing/FakeTranscriptTail'
import {
  toolResultLine,
  toolUseLine,
  transcript
} from '../../modules/asking/testing/claudeTranscript'
import { inMemoryAsking } from '../../modules/asking/testing/inMemoryAsking'
import { createObservedClaudeAsks } from './observedClaudeAsks'

const CLAUDE = 'claude' as ProviderId
const DWARF = '00000000-0000-7000-8000-0000000134d1' as DwarfId
const SESSION = '01a0b000-0000-7000-8000-000000001341'
const PATH = '/home/j/.claude/projects/sample/01a0b000.jsonl'
const CALL = 'toolu_01KeystrokeBash'
const R1 = '01890a5d-ac96-774b-bcce-000000001341'

const permissionRequest = {
  event: 'PermissionRequest',
  sessionId: SESSION,
  transcriptPath: PATH,
  toolName: 'Bash'
} as const

function world() {
  const tail = new FakeTranscriptTail()
  tail.set(PATH, transcript(toolUseLine(CALL)))
  const relay = new FakeKeystrokeRelay()
  const log = new RecordingDiagnosticsLog()
  // The registry with the one redaction rule, as the Host binds it (05 R9).
  const prompts = new PermissionPromptRegistry({ transcripts: tail, redact: redactSecrets })
  const keystrokes = new ObservedClaudeKeystrokeChannel({ prompts, transcripts: tail, relay, log })
  const channelFor = (kind: AskRecord['channel']) => (kind === 'hook-keystroke' ? keystrokes : null)
  const { opening, asking, asks, sessions, bus, clock } = inMemoryAsking({
    channelFor,
    // From the composed channel's own capability record (ADR-012 item 3).
    staleAnswerSafe: (kind) => channelFor(kind)?.capabilities.staleAnswerSafe ?? true
  })
  // An observed Claude session with the Claude hooks on: its permission dialogs are detected.
  sessions.set(DWARF, {
    providerId: CLAUDE,
    origin: 'observed',
    capabilities: {
      permission: 'interactive',
      question: 'none',
      observedPermission: 'detected',
      observedQuestion: 'none'
    }
  })
  const known = new Map<string, DwarfId>([[SESSION, DWARF]])
  const route = createObservedClaudeAsks({
    providerId: CLAUDE,
    sessions: {
      byIdentity: (identity: ProviderIdentity) => {
        const dwarfId = known.get(identity.providerSessionId)
        return identity.providerId === CLAUDE && dwarfId !== undefined
          ? ({ dwarfId } as never)
          : null
      }
    },
    prompts,
    asks: {
      open: (dwarfId, input) => opening.open(dwarfId, input),
      resolveExternally: (dwarfId, providerRequestId, by) =>
        asking.resolutions.resolveExternally(dwarfId, providerRequestId, by)
    },
    log
  })
  const askOf = () => asks.byProviderRequest({ dwarfId: DWARF }, CALL)
  return { route, tail, relay, log, bus, clock, asks, asking, sessions, known, askOf }
}

describe('observed-Claude hook route (08 §4; ADR-012)', () => {
  it('[ADR-012, S6.01] a permission prompt from the hook ingress opens one observed-Claude ask on the hook-keystroke channel for the session dwarf', async () => {
    const w = world()

    w.route.accept(permissionRequest)
    w.route.accept({
      event: 'Notification',
      sessionId: SESSION,
      notificationType: 'permission_prompt'
    })
    await w.route.idle()

    expect(w.askOf()).toMatchObject({
      dwarfId: DWARF,
      kind: 'permission',
      channel: 'hook-keystroke',
      providerRequestId: CALL,
      payload: { toolName: 'Bash', requestText: 'pnpm test' },
      state: 'open'
    })
    expect(w.bus.ofType('AskOpened')).toHaveLength(1)
    expect(w.relay.pressed).toEqual([])
  })

  it('[ADR-012, FM-082] Allow answered in the app presses 1 after a fresh re-read and closes the ask in the app; a dialog answered in the terminal first presses nothing', async () => {
    const w = world()
    w.route.accept(permissionRequest)
    await w.route.idle()
    const ask = w.askOf()!

    expect(await w.asking.answers.answerPermission(ask.id, 'allow', R1)).toEqual({
      kind: 'accepted'
    })
    expect(w.relay.pressed.map((p) => p.key)).toEqual([{ kind: 'text', text: '1' }])
    expect(w.askOf()?.state).toBe('answered-in-app')

    // Answered at the terminal before the app's Deny: the re-read finds the result, no key.
    const late = world()
    late.route.accept(permissionRequest)
    await late.route.idle()
    late.tail.set(PATH, transcript(toolUseLine(CALL), toolResultLine(CALL)))
    expect(await late.asking.answers.answerPermission(late.askOf()!.id, 'deny', R1)).toEqual({
      kind: 'refused',
      reason: 'ask-closed'
    })
    expect(late.relay.pressed).toEqual([])
    expect(late.askOf()?.state).toBe('answered-elsewhere')
  })

  it('[S6.11, S6.12, ADR-010] a resolution in the transcript closes the ask: within 10 s of an injection answered-in-app, otherwise answered-elsewhere', async () => {
    const resolveAfter = async (injected: boolean, ms: number) => {
      const w = world()
      w.route.accept(permissionRequest)
      await w.route.idle()
      if (injected) {
        // The relay failed after the keys may have landed: the ask is open again (S6.09).
        w.relay.fail = true
        await w.asking.answers.answerPermission(w.askOf()!.id, 'allow', R1)
        expect(w.askOf()?.state).toBe('open')
      }
      w.clock.advance(ms)
      w.tail.set(PATH, transcript(toolUseLine(CALL), toolResultLine(CALL)))
      w.route.accept({ event: 'PostToolUse', sessionId: SESSION, toolName: 'Bash' })
      await w.route.idle()
      return w.askOf()?.state
    }

    expect(await resolveAfter(true, 2_000)).toBe('answered-in-app')
    expect(await resolveAfter(true, 10_001)).toBe('answered-elsewhere')
    expect(await resolveAfter(false, 0)).toBe('answered-elsewhere')
  })

  it('[ADR-012] the request text reaches the ask with its secrets redacted by the one redaction rule', async () => {
    const w = world()
    const key = `sk-ant-${'a'.repeat(40)}`
    w.tail.set(
      PATH,
      transcript(
        toolUseLine(CALL, 'Bash', '2.1.261', {
          command: `curl -H "x-api-key: ${key}" example.test`
        })
      )
    )

    w.route.accept(permissionRequest)
    await w.route.idle()

    const requestText = (w.askOf()?.payload as { requestText: string } | undefined)?.requestText
    expect(requestText).toBe(redactSecrets(`curl -H "x-api-key: ${key}" example.test`))
    expect(requestText).not.toContain(key)
  })

  it('[ADR-012] the broker attaches the late-Deny status line from the composed channel capability record', async () => {
    const w = world()
    w.route.accept(permissionRequest)
    await w.route.idle()

    await w.asking.answers.answerPermission(w.askOf()!.id, 'deny', R1)

    expect(w.relay.pressed.map((p) => p.key)).toEqual([{ kind: 'escape' }])
    expect(w.bus.ofType('AskClosed')[0]?.payload).toMatchObject({
      reason: 'answered-in-app',
      statusLine: 'late-deny-interrupts-turn'
    })
  })

  it('[ADR-012] evidence of a session no dwarf carries, or one that cannot detect permissions, opens nothing and never throws into the ingress', async () => {
    const stranger = world()
    stranger.known.clear()
    expect(() => stranger.route.accept(permissionRequest)).not.toThrow()
    await stranger.route.idle()
    expect(stranger.askOf()).toBeNull()

    // A capability record with no detected permission: the broker refuses the open (07 S1.17);
    // the route records it and the ingress never sees an error.
    const blind = world()
    blind.sessions.set(DWARF, {
      providerId: CLAUDE,
      origin: 'observed',
      capabilities: {
        permission: 'none',
        question: 'none',
        observedPermission: 'none',
        observedQuestion: 'none'
      }
    })
    expect(() => blind.route.accept(permissionRequest)).not.toThrow()
    await blind.route.idle()
    expect(blind.askOf()).toBeNull()
    expect(blind.log.byEvent('asking.hook-evidence.refused')).toEqual([
      expect.objectContaining({ level: 'warn', subsystem: 'asking', dwarfId: DWARF })
    ])
  })
})
