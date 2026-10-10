// layer: L2
// L2 (17 §1.2): the observed-Claude keystroke channel (ADR-012 items 3–5; 16 §4.7 row
// `AskAnswerChannel` `hook-keystroke`, "a closed ask never presses a key"; 15 §2.7 row "Observed
// Claude keystroke"; 13 FM-082) over a fake keystroke relay recording keys, a fake transcript tail
// and the real prompt registry fed with hook evidence.
//
// TC-134-01: exactly `1` or `Esc` after a fresh re-read, or nothing and `not-open` when the dialog
// is gone. TC-134-03: a question on this channel presses no key.
import { describe, expect, it } from 'vitest'
import { RecordingDiagnosticsLog } from '../../../../kernel/fakes/RecordingDiagnosticsLog'
import type { DwarfId } from '../../../../kernel/domain/values'
import { FakeKeystrokeRelay } from '../../testing/FakeKeystrokeRelay'
import { FakeTranscriptTail } from '../../testing/FakeTranscriptTail'
import { toolResultLine, toolUseLine, transcript } from '../../testing/claudeTranscript'
import {
  OBSERVED_CLAUDE_KEYSTROKE_CAPABILITIES,
  ObservedClaudeKeystrokeChannel
} from './ObservedClaudeKeystrokeChannel'
import { PERMISSION_KEYSTROKES, type KeyMapMeasurement } from './keyMap'
import { PermissionPromptRegistry } from './permissionPromptRegistry'

const DWARF = '00000000-0000-7000-8000-0000000134d1' as DwarfId
const SESSION = '01a0b000-0000-7000-8000-000000001341'
const PATH = '/home/j/.claude/projects/sample/01a0b000.jsonl'
const CALL = 'toolu_01KeystrokeBash'
const REF = { dwarfId: DWARF }

/** A session whose permission dialog for CALL is open, as hook evidence and the tail show it. */
async function openDialog(version = '2.1.261') {
  const tail = new FakeTranscriptTail()
  tail.set(PATH, transcript(toolUseLine(CALL, 'Bash', version)))
  const prompts = new PermissionPromptRegistry({ transcripts: tail })
  await prompts.note(
    { event: 'PermissionRequest', sessionId: SESSION, transcriptPath: PATH, toolName: 'Bash' },
    DWARF
  )
  const relay = new FakeKeystrokeRelay()
  const log = new RecordingDiagnosticsLog()
  const channel = new ObservedClaudeKeystrokeChannel({ prompts, transcripts: tail, relay, log })
  return { tail, prompts, relay, log, channel }
}

describe('ObservedClaudeKeystrokeChannel (ADR-012 item 3)', () => {
  it('[ADR-012] Allow presses 1 without Enter and Deny presses Esc, after re-reading that the dialog is still open', async () => {
    const allow = await openDialog()
    const readsBefore = allow.tail.reads
    expect(await allow.channel.answerPermission(REF, CALL, 'allow')).toEqual({ kind: 'accepted' })
    expect(allow.relay.pressed).toEqual([
      { target: { dwarfId: DWARF, providerSessionId: SESSION }, key: { kind: 'text', text: '1' } }
    ])
    // The re-read happened for this answer, not only when the dialog opened.
    expect(allow.tail.reads).toBeGreaterThan(readsBefore)

    const deny = await openDialog()
    expect(await deny.channel.answerPermission(REF, CALL, 'deny')).toEqual({ kind: 'accepted' })
    expect(deny.relay.pressed.map((p) => p.key)).toEqual([{ kind: 'escape' }])

    // Nothing else is ever pressed: one key per answer, never a line terminator.
    for (const { key } of [...allow.relay.pressed, ...deny.relay.pressed]) {
      if (key.kind === 'text') expect(key.text).toMatch(/^1$/)
    }
  })

  it('[FM-082, ADR-012] when the fresh re-read no longer shows the dialog the answer is not-open and no key is pressed', async () => {
    // Answered in the terminal: the hook registry still says open, the fresh tail has the result.
    const answered = await openDialog()
    answered.tail.set(PATH, transcript(toolUseLine(CALL), toolResultLine(CALL)))
    expect(await answered.channel.answerPermission(REF, CALL, 'allow')).toEqual({
      kind: 'not-open'
    })
    expect(answered.relay.pressed).toEqual([])

    // Another call is the open one now.
    const moved = await openDialog()
    moved.tail.set(
      PATH,
      transcript(toolUseLine(CALL), toolResultLine(CALL), toolUseLine('toolu_01Next'))
    )
    expect(await moved.channel.answerPermission(REF, CALL, 'deny')).toEqual({ kind: 'not-open' })
    expect(moved.relay.pressed).toEqual([])

    // The turn ended (hook evidence) though the tail still shows the call.
    const ended = await openDialog()
    await ended.prompts.note({ event: 'Stop', sessionId: SESSION, transcriptPath: PATH }, DWARF)
    expect(await ended.channel.answerPermission(REF, CALL, 'allow')).toEqual({ kind: 'not-open' })
    expect(ended.relay.pressed).toEqual([])

    // The dialog closes while the tail is being read: the check after the read catches it.
    const racing = await openDialog()
    racing.tail.onRead = () => {
      racing.tail.onRead = null // once: the registry's own re-read must not trigger it again
      void racing.prompts.note({ event: 'UserPromptSubmit', sessionId: SESSION }, DWARF)
    }
    expect(await racing.channel.answerPermission(REF, CALL, 'allow')).toEqual({
      kind: 'not-open'
    })
    expect(racing.relay.pressed).toEqual([])

    // An unreadable tail, or a dwarf with no observed Claude session, proves nothing open.
    const unreadable = await openDialog()
    unreadable.tail.texts.clear()
    expect(await unreadable.channel.answerPermission(REF, CALL, 'allow')).toEqual({
      kind: 'not-open'
    })
    const stranger = await openDialog()
    expect(
      await stranger.channel.answerPermission(
        { dwarfId: '00000000-0000-7000-8000-0000000134d2' as DwarfId },
        CALL,
        'allow'
      )
    ).toEqual({ kind: 'not-open' })
    expect([...unreadable.relay.pressed, ...stranger.relay.pressed]).toEqual([])
  })

  it('[ADR-012] a question on this channel is never answered by keys', async () => {
    const { channel, relay } = await openDialog()
    expect(await channel.answerQuestion(REF, CALL, [{ step: 0, option: 'Yes' }])).toEqual({
      kind: 'not-open'
    })
    expect(await channel.declineQuestion(REF, CALL)).toEqual({ kind: 'not-open' })
    expect(relay.pressed).toEqual([])
  })

  it('[ADR-012] an unmeasured Claude Code version keeps the last key map and logs a drift event; a measured shape change disables the channel', async () => {
    // Measured version: keys, no drift.
    const measured = await openDialog('2.1.261')
    await measured.channel.answerPermission(REF, CALL, 'allow')
    expect(measured.log.byEvent('asking.keymap.drift')).toEqual([])

    // A newer, unmeasured version: the last measured map, and one drift record per version.
    const newer = await openDialog('2.1.300')
    expect(await newer.channel.answerPermission(REF, CALL, 'deny')).toEqual({ kind: 'accepted' })
    expect(newer.relay.pressed.map((p) => p.key)).toEqual([{ kind: 'escape' }])
    await newer.channel.answerPermission(REF, CALL, 'deny')
    expect(newer.log.byEvent('asking.keymap.drift')).toEqual([
      {
        level: 'warn',
        event: 'asking.keymap.drift',
        subsystem: 'asking',
        provider: 'claude',
        providerVersion: '2.1.300'
      }
    ])

    // A measured change of the dialog's shape on 2.1.290: no key on it or after it.
    const changed: KeyMapMeasurement[] = [
      { version: '2.1.261', measuredOn: '2026-09-05', keys: PERMISSION_KEYSTROKES },
      { version: '2.1.290', measuredOn: '2026-10-01', keys: null }
    ]
    for (const version of ['2.1.290', '2.1.300']) {
      const disabled = await openDialog(version)
      const channel = new ObservedClaudeKeystrokeChannel({
        prompts: disabled.prompts,
        transcripts: disabled.tail,
        relay: disabled.relay,
        log: disabled.log,
        measurements: changed
      })
      expect(await channel.answerPermission(REF, CALL, 'allow')).toEqual({
        kind: 'refused',
        reason: 'channel-unavailable'
      })
      expect(disabled.relay.pressed).toEqual([])
    }
  })

  it('[ADR-012] the channel reports staleAnswerSafe false, and a relay that cannot press refuses with nothing pressed', async () => {
    expect(OBSERVED_CLAUDE_KEYSTROKE_CAPABILITIES.staleAnswerSafe).toBe(false)

    const refused = await openDialog()
    refused.relay.refuse = true
    expect(await refused.channel.answerPermission(REF, CALL, 'allow')).toEqual({
      kind: 'refused',
      reason: 'channel-unavailable'
    })
    const failing = await openDialog()
    failing.relay.fail = true
    expect(await failing.channel.answerPermission(REF, CALL, 'allow')).toEqual({
      kind: 'refused',
      reason: 'channel-unavailable'
    })
    expect([...refused.relay.pressed, ...failing.relay.pressed]).toEqual([])
  })
})
