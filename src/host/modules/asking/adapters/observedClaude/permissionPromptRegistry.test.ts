// layer: L2
// L2 (17 §1.2): the observed-Claude permission-prompt registry (ADR-012 items 3, 5, 6; ADR-010
// item 10 "Observed Claude (hook ingress): hook event + prompt registry"; 08 §4 hook ingress →
// asking `open`) over a fake transcript tail. It turns hook evidence and the transcript tail into
// the asks to open and the resolutions to report; it never answers and never presses a key.
import { describe, expect, it } from 'vitest'
import type { DwarfId } from '../../../../kernel/domain/values'
import { FakeTranscriptTail } from '../../testing/FakeTranscriptTail'
import { toolResultLine, toolUseLine, transcript } from '../../testing/claudeTranscript'
import { PERMISSION_KEYSTROKES } from './keyMap'
import { PermissionPromptRegistry } from './permissionPromptRegistry'

const DWARF = '00000000-0000-7000-8000-0000000134d1' as DwarfId
const SESSION = '01a0b000-0000-7000-8000-000000001341'
const PATH = '/home/j/.claude/projects/sample/01a0b000.jsonl'
const CALL = 'toolu_01KeystrokeBash'

const permissionRequest = {
  event: 'PermissionRequest',
  sessionId: SESSION,
  transcriptPath: PATH,
  toolName: 'Bash'
} as const

function registry(text = transcript(toolUseLine(CALL))) {
  const tail = new FakeTranscriptTail()
  tail.set(PATH, text)
  return { tail, prompts: new PermissionPromptRegistry({ transcripts: tail }) }
}

describe('PermissionPromptRegistry (ADR-012)', () => {
  it('[ADR-012, S6.01] a permission prompt opens one hook-keystroke ask for the open call, once', async () => {
    const { prompts } = registry()

    expect(await prompts.note(permissionRequest, DWARF)).toEqual([
      {
        kind: 'open',
        dwarfId: DWARF,
        input: {
          kind: 'permission',
          providerRequestId: CALL,
          channel: 'hook-keystroke',
          payload: { toolName: 'Bash', requestText: 'pnpm test' },
          options: { hasAllowOnce: true, hasRejectOnce: true }
        }
      }
    ])
    // The notification that follows for the same dialog opens nothing more.
    expect(
      await prompts.note(
        { event: 'Notification', sessionId: SESSION, notificationType: 'permission_prompt' },
        DWARF
      )
    ).toEqual([])
    expect(prompts.sessionOf(DWARF)).toMatchObject({
      providerSessionId: SESSION,
      transcriptPath: PATH,
      promptOpen: true
    })
  })

  it('[S6.11, ADR-010] a call the transcript shows resolved is reported resolved elsewhere, once', async () => {
    const { tail, prompts } = registry()
    await prompts.note(permissionRequest, DWARF)
    tail.set(PATH, transcript(toolUseLine(CALL), toolResultLine(CALL)))

    expect(
      await prompts.note({ event: 'PostToolUse', sessionId: SESSION, toolName: 'Bash' }, DWARF)
    ).toEqual([{ kind: 'resolved', dwarfId: DWARF, providerRequestId: CALL, by: 'elsewhere' }])
    expect(await prompts.note({ event: 'Stop', sessionId: SESSION }, DWARF)).toEqual([])
    expect(prompts.sessionOf(DWARF)?.promptOpen).toBe(false)
  })

  it('[ADR-012] the next prompt of the session resolves the earlier call and opens the new one', async () => {
    const { tail, prompts } = registry()
    await prompts.note(permissionRequest, DWARF)
    tail.set(
      PATH,
      transcript(toolUseLine(CALL), toolResultLine(CALL), toolUseLine('toolu_01Next', 'Write'))
    )

    const changes = await prompts.note({ ...permissionRequest, toolName: 'Write' }, DWARF)

    expect(changes.map((change) => change.kind)).toEqual(['resolved', 'open'])
    expect(changes[1]).toMatchObject({ input: { providerRequestId: 'toolu_01Next' } })
  })

  it('[ADR-012] a measured shape change opens the ask with no answer channel (Jump to terminal only)', async () => {
    const tail = new FakeTranscriptTail()
    tail.set(PATH, transcript(toolUseLine(CALL, 'Bash', '2.1.290')))
    const prompts = new PermissionPromptRegistry({
      transcripts: tail,
      measurements: [
        { version: '2.1.261', measuredOn: '2026-09-05', keys: PERMISSION_KEYSTROKES },
        { version: '2.1.290', measuredOn: '2026-10-01', keys: null }
      ]
    })

    const [change] = await prompts.note(permissionRequest, DWARF)

    expect(change).toMatchObject({ kind: 'open', input: { channel: 'none' } })
  })

  it('[ADR-012] no ask for a question, an ambiguous dialog, a session with no dwarf or evidence with no session', async () => {
    const question = registry(transcript(toolUseLine('toolu_01Ask', 'AskUserQuestion')))
    expect(
      await question.prompts.note({ ...permissionRequest, toolName: 'AskUserQuestion' }, DWARF)
    ).toEqual([])

    const ambiguous = registry(transcript(toolUseLine('toolu_01A'), toolUseLine('toolu_01B')))
    expect(await ambiguous.prompts.note(permissionRequest, DWARF)).toEqual([])

    // No dwarf yet: nothing opens; the next evidence once the dwarf is known opens it.
    const early = registry()
    expect(await early.prompts.note(permissionRequest, null)).toEqual([])
    expect(
      await early.prompts.note(
        { event: 'Notification', sessionId: SESSION, notificationType: 'permission_prompt' },
        DWARF
      )
    ).toMatchObject([{ kind: 'open', input: { providerRequestId: CALL } }])

    const anonymous = registry()
    expect(
      await anonymous.prompts.note({ event: 'PermissionRequest', transcriptPath: PATH }, DWARF)
    ).toEqual([])
    expect(anonymous.prompts.sessionOf(DWARF)).toBeNull()
  })

  it('[ADR-012] a tool call that only ran, with no prompt open, opens nothing', async () => {
    const { prompts } = registry()
    expect(
      await prompts.note(
        { event: 'PreToolUse', sessionId: SESSION, transcriptPath: PATH, toolName: 'Bash' },
        DWARF
      )
    ).toEqual([])
    expect(prompts.sessionOf(DWARF)?.promptOpen).toBe(false)
  })
})
