// `AskAnswerChannel` for `hook-keystroke` (16 §4.7 rows `AskAnswerChannel` and its adapter: "a
// closed ask never presses a key"; 15 §2.7 row "Observed Claude keystroke"; ADR-012 items 3–5):
// the one documented exception channel. An Allow or Deny chosen in the app is typed into the
// observed session's own terminal — `1` for Allow, `Esc` for Deny, nothing else, never Enter
// (keyMap.ts) — and only after the Host re-read the session's latest trusted state just before
// pressing:
//
// 1. The hook state (permissionPromptRegistry.ts): a permission dialog is open for the dwarf's
//    Claude session, and no turn end has been heard since.
// 2. A FRESH read of the transcript tail (transcriptTail.ts), never the registry's record of the
//    call: the one unresolved main-session call (of the dialog's tool) is this ask's
//    `providerRequestId`, and it is a permission.
// 3. The hook state again, after that read: the dialog did not close, and the session did not
//    change, while the tail was being read.
// If any check fails, the dialog is not provably open: `not-open`, and nothing is pressed (PO #28;
// 13 FM-082). Then the version-pinned key map of the tail's Claude Code version: a measured shape
// change refuses `channel-unavailable` with nothing pressed (the card keeps "Jump to terminal"); an
// unmeasured version keeps the last measured map and logs one `asking.keymap.drift` per version
// (HO-33). The key goes through the keystroke relay (`KeystrokeRelay`): `pressed` is `accepted`;
// a relay that cannot target the terminal, or fails, is `refused: 'channel-unavailable'`.
//
// What remains after the check is the last milliseconds before the key: a late `1` is one stray
// character in an idle input box (no Enter is ever pressed); a late `Esc` interrupts the running
// turn. That is why the capability record says `staleAnswerSafe: false` and the broker attaches the
// late-Deny status line to a Deny on this channel (domain/attribution.ts).
//
// Questions are never answered by keys (ADR-012 item 5: an option the panel cannot count must not be
// pressed): `answerQuestion` and `declineQuestion` answer `not-open` and press nothing.
//
// Package gap (resolved here, ISSUE-134): the keystroke relay is a dependency of this adapter, bound
// by the Host's composition; the real per-OS relay into a terminal the Host did not start is the
// observed-session relay of the conversation module (later: ISSUE-167, `ObservedSessionTurnSender`
// ← `textDelivery/**`, with the same "target checked just before writing" rule). Owned Claude
// sessions never use this channel (ADR-012 item 4).
import type { AnswerOutcome, QuestionAnswers } from '../../../../kernel/domain/sharedContracts'
import type { DwarfId } from '../../../../kernel/domain/values'
import type { DiagnosticsLog } from '../../../../kernel/ports/diagnosticsLog'
import type { ProviderCapabilities } from '../../../suppliers'
import type { AskAnswerChannel } from '../../ports/askAnswerChannel'
import type { AskChannelRef } from '../../ports/askRepository'
import {
  KEY_MAP_MEASUREMENTS,
  keystrokeIn,
  resolveKeyMap,
  type KeyMapMeasurement,
  type PermissionKeystroke
} from './keyMap'
import type { PermissionPromptRegistry, PromptSession } from './permissionPromptRegistry'
import { readTail, type TranscriptTail } from './transcriptTail'

/** The terminal a key is meant for: the dwarf's observed Claude session. */
export interface KeystrokeTarget {
  readonly dwarfId: DwarfId
  readonly providerSessionId: string
}

/**
 * Presses exactly one key in the target session's terminal, never followed by Enter, or refuses
 * when the terminal cannot be positively identified just before writing.
 */
export interface KeystrokeRelay {
  press(target: KeystrokeTarget, key: PermissionKeystroke): Promise<'pressed' | 'refused'>
}

/** This channel's capability record (ADR-009 D2 fields; ADR-012 item 3). */
export const OBSERVED_CLAUDE_KEYSTROKE_CAPABILITIES = {
  /** A late `Esc` interrupts the running turn (13 FM-082). */
  staleAnswerSafe: false,
  /** Hook and transcript evidence show a resolution outside DwarfAI (ADR-010 item 10). */
  answeredElsewhere: true
} as const satisfies Pick<ProviderCapabilities, 'staleAnswerSafe' | 'answeredElsewhere'>

/** The provider this channel answers for (catalog id), for its diagnostics. */
const CLAUDE_PROVIDER_ID = 'claude'

const NOT_OPEN: AnswerOutcome = { kind: 'not-open' }
const UNAVAILABLE: AnswerOutcome = { kind: 'refused', reason: 'channel-unavailable' }

export interface ObservedClaudeKeystrokeChannelDeps {
  /** The hook state of each dwarf's observed Claude session. */
  prompts: Pick<PermissionPromptRegistry, 'sessionOf'>
  /** The fresh read of the transcript tail. */
  transcripts: TranscriptTail
  relay: KeystrokeRelay
  log: DiagnosticsLog
  /** The key-map measurements (keyMap.ts); the recorded ones by default. */
  measurements?: readonly KeyMapMeasurement[]
}

export class ObservedClaudeKeystrokeChannel implements AskAnswerChannel {
  readonly capabilities = OBSERVED_CLAUDE_KEYSTROKE_CAPABILITIES
  /** The unmeasured versions already logged as drift. */
  private readonly drifted = new Set<string>()

  constructor(private readonly deps: ObservedClaudeKeystrokeChannelDeps) {}

  async answerPermission(
    ref: AskChannelRef,
    providerRequestId: string,
    decision: 'allow' | 'deny'
  ): Promise<AnswerOutcome> {
    const { prompts, transcripts, relay } = this.deps
    const before = prompts.sessionOf(ref.dwarfId)
    if (before === null || !before.promptOpen || before.transcriptPath === null) return NOT_OPEN
    const text = await transcripts.read(before.transcriptPath)
    if (text === null) return NOT_OPEN
    const reading = readTail(text, before.toolName ?? undefined)
    const call = reading.pending
    if (call === null || call.kind !== 'permission' || call.id !== providerRequestId) {
      return NOT_OPEN
    }
    if (!stillOpen(before, prompts.sessionOf(ref.dwarfId))) return NOT_OPEN

    const keyMap = resolveKeyMap(reading.version, this.deps.measurements ?? KEY_MAP_MEASUREMENTS)
    if (keyMap.kind === 'disabled') return UNAVAILABLE
    if (keyMap.kind === 'unmeasured') this.logDrift(reading.version)
    const key = keystrokeIn(keyMap.keys, decision)
    if (key === null) return UNAVAILABLE
    try {
      const pressed = await relay.press(
        { dwarfId: ref.dwarfId, providerSessionId: before.providerSessionId },
        key
      )
      return pressed === 'pressed' ? { kind: 'accepted' } : UNAVAILABLE
    } catch {
      return UNAVAILABLE
    }
  }

  answerQuestion(
    _ref: AskChannelRef,
    _providerRequestId: string,
    _answers: QuestionAnswers
  ): Promise<AnswerOutcome> {
    return Promise.resolve(NOT_OPEN)
  }

  declineQuestion(_ref: AskChannelRef, _providerRequestId: string): Promise<AnswerOutcome> {
    return Promise.resolve(NOT_OPEN)
  }

  /** One `asking.keymap.drift` per unmeasured version (HO-33; 19 §7 allowlisted fields only). */
  private logDrift(version: string | null): void {
    const key = version ?? ''
    if (this.drifted.has(key)) return
    this.drifted.add(key)
    this.deps.log.record({
      level: 'warn',
      event: 'asking.keymap.drift',
      subsystem: 'asking',
      provider: CLAUDE_PROVIDER_ID,
      ...(version === null ? {} : { providerVersion: version })
    })
  }
}

/** The dialog read before the tail is still the open one after it: same session, still open. */
function stillOpen(before: PromptSession, after: PromptSession | null): boolean {
  return (
    after !== null &&
    after.promptOpen &&
    after.providerSessionId === before.providerSessionId &&
    after.transcriptPath === before.transcriptPath
  )
}
