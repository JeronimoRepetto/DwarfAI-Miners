// layer: L2
// Ask parity for observed Claude sessions (21 §2 cut 2 exit, `21-migration-plan.md:186`; ADR-012; TC-141-02): for every
// recorded observed-Claude fixture (`fixtures/claude/hook-keystroke/2.1.x`, each base case with its `-crlf` and
// `-with-extra` variants), the answer the Host delivers to the provider equals the one today's runtime delivered, except
// the differences listed below, which ISSUE-141 records in `docs/strangler/parity-cut-2.md`. SP-11 did not pass (ISSUE-135
// closed as not needed, owner 2026-10-14), so the answer channel is the keystroke exception on both sides (ADR-012 item 3):
// what reaches the provider is one key press.
//
// The two sides hear the same hook evidence: Claude Code's `Notification` with `notification_type: permission_prompt` for
// the session, the one event today's registry reads.
// - Today's side (`src/main`, only `src/legacy-bridge/**` may import it, R16): today's `PermissionPromptRegistry`, which
//   holds the dialog open from that hook until the transcript moves past it, and today's `permissionKeystrokeFor`, the key
//   today's runtime pressed for an Allow or a Deny while the dialog was held open.
// - The Host's side: the asking module's observed-Claude adapters over its doubles (the prompt registry fed with the same
//   hook and the fixture as the transcript tail, the keystroke channel over a recording relay). The adapters are read
//   directly, as their own tests read them: the asking module's index exports none of them and host/wiring composes them
//   (R6 binds the Host tree; `LegacyLaunchObservation.test.ts` reads a Host adapter the same way). The Host opens an ask
//   only for the call the fresh tail read shows open, and answers it through the channel, which re-reads the tail first.
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { DwarfId } from '../../host/kernel/domain/values'
import { RecordingDiagnosticsLog } from '../../host/kernel/fakes/RecordingDiagnosticsLog'
import { ObservedClaudeKeystrokeChannel } from '../../host/modules/asking/adapters/observedClaude/ObservedClaudeKeystrokeChannel'
import { PermissionPromptRegistry as HostPromptRegistry } from '../../host/modules/asking/adapters/observedClaude/permissionPromptRegistry'
import { FakeKeystrokeRelay } from '../../host/modules/asking/testing/FakeKeystrokeRelay'
import { FakeTranscriptTail } from '../../host/modules/asking/testing/FakeTranscriptTail'
import { PermissionPromptRegistry as LegacyPromptRegistry } from '../../main/hooks/permissionPrompts'
import { permissionKeystrokeFor } from '../../main/textDelivery/permissionKeys'

const FIXTURES = resolve(import.meta.dirname, '../../../fixtures/claude/hook-keystroke/2.1.x')
const DWARF = '00000000-0000-7000-8000-0000000141d1' as DwarfId
const SESSION = '01a0b000-0000-7000-8000-000000001341'
const PATH = '/home/j/.claude/projects/sample/01a0b000.jsonl'
const DECISIONS = ['allow', 'deny'] as const

/** One key press as either side delivers it: a digit sent with no Enter, or a raw Esc. */
type Key = { kind: 'text'; text: string } | { kind: 'escape' }

/** What reaches the provider for one decision: the key pressed, or nothing. */
type Delivered = Key | null

/**
 * The intended differences of cut 2 (21 §1 item 3; `docs/strangler/parity-cut-2.md`), per base case: what today's
 * runtime delivered and what the Host delivers instead, with the ADR or owner answer that decides it.
 */
const LISTED_DIFFERENCES: Readonly<Record<string, { host: 'nothing'; decidedBy: string }>> = {
  // The transcript already holds the call's result: the dialog was answered elsewhere. Today's registry still held it
  // open (only a later transcript move closes it) and pressed the key into whatever the console showed; the Host's
  // fresh re-read finds no open call and presses nothing (13 FM-082).
  'resolved-permission': { host: 'nothing', decidedBy: 'ADR-012 item 3' },
  // The only unresolved call is a subagent's (`isSidechain`): no main-session dialog is open. Today's registry keyed the
  // dialog by session alone; the Host never matches a sidechain call.
  'sidechain-pending': { host: 'nothing', decidedBy: 'ADR-012 item 3' },
  // Two unresolved calls of the same tool: which one the dialog is for cannot be told, so the Host opens no card and
  // presses nothing (never a guess); today's registry pressed the key for whichever was drawn.
  'two-pending-same-tool': { host: 'nothing', decidedBy: 'ADR-012 item 3' },
  // An observed Claude question (`AskUserQuestion`): the keystroke channel answers no question (fixture meta
  // `observedQuestion: "none"`; 15 §2.7 "Observed Claude keystroke"), so the Host opens no question card for it and no
  // permission answer reaches it; today's hook-only registry held a permission dialog open and pressed the key.
  'pending-question': { host: 'nothing', decidedBy: 'ADR-012 item 3; ADR-011 item 4; OQ-05' }
}

/** Every recorded fixture: its file, the base case it belongs to, and the transcript text. */
function fixtures(): Array<{ file: string; base: string; text: string }> {
  return readdirSync(FIXTURES)
    .filter((file) => file.endsWith('.jsonl'))
    .sort()
    .map((file) => ({
      file,
      base: file.replace(/(-crlf|-with-extra)?\.jsonl$/, ''),
      text: readFileSync(resolve(FIXTURES, file), 'utf8')
    }))
}

/** The hook Claude Code raised for the session: its permission dialog is up. */
const PERMISSION_PROMPT = {
  event: 'Notification' as const,
  notificationType: 'permission_prompt',
  sessionId: SESSION,
  transcriptPath: PATH
}

/** What today's runtime delivered: while its registry held the dialog open, the key of the decision. */
function legacyDelivered(decision: (typeof DECISIONS)[number]): Delivered {
  const registry = new LegacyPromptRegistry({ now: () => 0 })
  registry.note({ provider: 'claude', ...PERMISSION_PROMPT })
  return registry.isOpen(SESSION) ? permissionKeystrokeFor(decision) : null
}

/** What the Host delivers: for the permission ask it opened, the key its channel pressed after the re-read. */
async function hostDelivered(
  text: string,
  decision: (typeof DECISIONS)[number]
): Promise<{ delivered: Delivered; opened: string[] }> {
  const tail = new FakeTranscriptTail()
  tail.set(PATH, text)
  const prompts = new HostPromptRegistry({ transcripts: tail, redact: (value) => value })
  const changes = await prompts.note(PERMISSION_PROMPT, DWARF)
  const opened = changes.flatMap((change) => (change.kind === 'open' ? [change.input] : []))
  const relay = new FakeKeystrokeRelay()
  const channel = new ObservedClaudeKeystrokeChannel({
    prompts,
    transcripts: tail,
    relay,
    log: new RecordingDiagnosticsLog()
  })
  for (const input of opened) {
    if (input.kind === 'permission') {
      await channel.answerPermission({ dwarfId: DWARF }, input.providerRequestId, decision)
    }
  }
  expect(relay.pressed.length, 'one key per answer at most').toBeLessThanOrEqual(1)
  return {
    delivered: relay.pressed[0]?.key ?? null,
    opened: opened.map((input) => `${input.kind} ${input.providerRequestId}`)
  }
}

describe('ask parity, observed Claude (21 §2 cut 2 exit)', () => {
  it('[ADR-012] for every recorded observed-Claude permission and question fixture the answer delivered to the provider equals the legacy one, except the listed differences', async () => {
    const cases = fixtures()
    // Five base cases, each with its CRLF and extra-field variants (17 §1.4).
    expect(cases).toHaveLength(15)
    const seen = new Set<string>()
    for (const { file, base, text } of cases) {
      const expected = JSON.parse(
        readFileSync(resolve(FIXTURES, `${base}.expected.json`), 'utf8')
      ) as { pending: { id: string; kind: 'permission' | 'question' } | null; ambiguous: boolean }
      for (const decision of DECISIONS) {
        const legacy = legacyDelivered(decision)
        const host = await hostDelivered(text, decision)
        const listed = LISTED_DIFFERENCES[base]
        if (listed === undefined) {
          // Parity: the same key reaches the provider, for the call the fixture's contract names.
          expect(host.delivered, `${file} ${decision}`).toEqual(legacy)
          expect(host.opened, file).toEqual([`permission ${expected.pending?.id}`])
        } else {
          seen.add(base)
          expect(legacy, `${file} ${decision}: today's runtime pressed`).not.toBeNull()
          expect(host.delivered, `${file} ${decision}: ${listed.decidedBy}`).toBeNull()
          expect(
            host.opened.filter((opened) => opened.startsWith('permission')),
            file
          ).toEqual([])
        }
      }
    }
    // Every listed difference is a recorded case; nothing is listed that the fixtures do not show.
    expect([...seen].sort()).toEqual(Object.keys(LISTED_DIFFERENCES).sort())
    // And the one parity case is the open permission (Allow presses 1, Deny presses Esc on both sides).
    expect(legacyDelivered('allow')).toEqual({ kind: 'text', text: '1' })
    expect(legacyDelivered('deny')).toEqual({ kind: 'escape' })
  })
})
