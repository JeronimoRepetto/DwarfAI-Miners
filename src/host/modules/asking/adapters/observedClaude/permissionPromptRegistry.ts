// Which observed Claude sessions have a permission dialog open, and for which tool call (ADR-012
// item 3; ADR-010 item 10 "Observed Claude (hook ingress): hook event + prompt registry"; 08 §4 hook
// ingress → asking `open`).
//
// Evaluated candidate: the legacy `hooks/permissionPrompts.ts` (found tree). Replaced: it keeps one
// open flag per session, closed by the board poll's transcript mtime moving past a baseline, and
// its tests stamp the legacy board (`Mine`/`Dwarf`); ADR-012 needs the open CALL (to re-match its
// id just before pressing) and an ask per call. Kept from it, as rules:
// - The correlation is Claude Code's own `session_id` and nothing weaker; evidence without one is
//   dropped, never matched by `cwd`, which two sessions in one folder share.
// - A permission prompt is Claude Code's own structured statement — `PermissionRequest`, or a
//   `Notification` of type `permission_prompt` — never inferred from silence or prose. A re-raised
//   prompt for the same dialog is idempotent.
// - `Stop`, `SessionEnd` (and `UserPromptSubmit`: the person typed, so no dialog is up) end the
//   turn and any prompt in it; `SubagentStop` is not an ending (a subagent finishing says nothing
//   about the main session's dialog).
//
// What it adds: the transcript tail (transcriptTail.ts) names the open call. Each `note` updates the
// hook state at once, then reconciles against a fresh read of the tail, one note after another:
// - a call it reported open whose `tool_result` is now in the tail is `resolved` elsewhere (the
//   broker's attribution window decides whether that was DwarfAI's injection, ADR-010 item 10);
// - while a prompt is open, the one unresolved main-session call (of the hook's tool) that is a
//   permission opens an ask once: channel `hook-keystroke`, or `none` when the key map of the
//   tail's Claude Code version is disabled by a measured shape change (the card offers only "Jump
//   to terminal", ADR-012 item 3). A question is never opened here (ADR-012 item 5), nor an
//   ambiguous dialog (fail closed).
// - Nothing opens before the session's dwarf is known; the next evidence of the session, once it
//   is, opens the still-open dialog's ask.
//
// It never answers and never presses a key: the channel re-reads for itself just before pressing
// and never trusts this registry's record of the call (FM-082).
import type { DwarfId } from '../../../../kernel/domain/values'
import type { AskInput } from '../../../suppliers'
import { KEY_MAP_MEASUREMENTS, resolveKeyMap, type KeyMapMeasurement } from './keyMap'
import { isResolved, readTail, type TranscriptTail } from './transcriptTail'

/**
 * The hook evidence this registry reads: structurally the transport's `ClaudeHookEvidence`
 * (transport/ingress/claudeHookPayload.ts), which a module never imports.
 */
export interface ObservedClaudeHookEvidence {
  readonly event: string
  readonly sessionId?: string
  readonly transcriptPath?: string
  readonly notificationType?: string
  readonly toolName?: string
}

/** A dwarf's observed Claude session as the hook evidence last left it. */
export interface PromptSession {
  readonly providerSessionId: string
  readonly transcriptPath: string | null
  /** A permission dialog is open, as the hooks said and no turn end has said otherwise. */
  readonly promptOpen: boolean
  /** The tool the open dialog is for, when the hook named it. */
  readonly toolName: string | null
  /** The calls this registry opened an ask for and has not seen resolved (its own record). */
  readonly askedCalls: readonly string[]
}

/** What one note asks of the broker. */
export type PromptChange =
  | { kind: 'open'; dwarfId: DwarfId; input: AskInput }
  | { kind: 'resolved'; dwarfId: DwarfId; providerRequestId: string; by: 'elsewhere' }

export interface PermissionPromptRegistryDeps {
  transcripts: TranscriptTail
  /**
   * Redacts the secrets of a request's text before it leaves for an ask: the one redaction rule
   * (`contracts/logging` `redactSecrets`), bound by the wiring since an adapter never imports
   * `contracts` (05 R9).
   */
  redact(text: string): string
  /** The key-map measurements (keyMap.ts); the recorded ones by default. */
  measurements?: readonly KeyMapMeasurement[]
}

interface SessionState {
  readonly providerSessionId: string
  dwarfId: DwarfId | null
  transcriptPath: string | null
  promptOpen: boolean
  toolName: string | null
  readonly asked: Set<string>
}

/** The opening evidence: Claude Code's own statement that a permission dialog is up. */
function opensPrompt(evidence: ObservedClaudeHookEvidence): boolean {
  return (
    evidence.event === 'PermissionRequest' ||
    (evidence.event === 'Notification' && evidence.notificationType === 'permission_prompt')
  )
}

const TURN_ENDED: ReadonlySet<string> = new Set(['Stop', 'SessionEnd', 'UserPromptSubmit'])

export class PermissionPromptRegistry {
  private readonly sessions = new Map<string, SessionState>()
  private readonly sessionOfDwarf = new Map<DwarfId, string>()
  /** The reconciles, one after another, so two reads never interleave their changes. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: PermissionPromptRegistryDeps) {}

  /**
   * Reads one hook event of `dwarfId`'s session (null: not known yet) and answers the asks to open
   * and the calls resolved. The hook state changes now; the changes follow the tail's fresh read.
   */
  note(evidence: ObservedClaudeHookEvidence, dwarfId: DwarfId | null): Promise<PromptChange[]> {
    const id = evidence.sessionId
    if (id === undefined) return Promise.resolve([])
    const session = this.sessionFor(id)
    if (dwarfId !== null) {
      session.dwarfId = dwarfId
      this.sessionOfDwarf.set(dwarfId, id)
    }
    if (evidence.transcriptPath !== undefined) session.transcriptPath = evidence.transcriptPath
    if (opensPrompt(evidence)) {
      session.promptOpen = true
      if (evidence.toolName !== undefined) session.toolName = evidence.toolName
    } else if (TURN_ENDED.has(evidence.event)) {
      session.promptOpen = false
      session.toolName = null
    }
    const run = this.queue.then(() => this.reconcile(session))
    this.queue = run.catch(() => undefined)
    return run
  }

  /** The dwarf's observed Claude session, or null when no hook evidence named it. */
  sessionOf(dwarfId: DwarfId): PromptSession | null {
    const id = this.sessionOfDwarf.get(dwarfId)
    const session = id === undefined ? undefined : this.sessions.get(id)
    if (session === undefined || session.dwarfId !== dwarfId) return null
    return {
      providerSessionId: session.providerSessionId,
      transcriptPath: session.transcriptPath,
      promptOpen: session.promptOpen,
      toolName: session.toolName,
      askedCalls: [...session.asked]
    }
  }

  private sessionFor(id: string): SessionState {
    let session = this.sessions.get(id)
    if (session === undefined) {
      session = {
        providerSessionId: id,
        dwarfId: null,
        transcriptPath: null,
        promptOpen: false,
        toolName: null,
        asked: new Set()
      }
      this.sessions.set(id, session)
    }
    return session
  }

  private async reconcile(session: SessionState): Promise<PromptChange[]> {
    const { dwarfId, transcriptPath } = session
    if (dwarfId === null || transcriptPath === null) return []
    const text = await this.deps.transcripts.read(transcriptPath)
    if (text === null) return []
    const changes: PromptChange[] = []
    for (const call of [...session.asked]) {
      if (!isResolved(text, call)) continue
      session.asked.delete(call)
      changes.push({ kind: 'resolved', dwarfId, providerRequestId: call, by: 'elsewhere' })
    }
    if (!session.promptOpen) return changes
    const reading = readTail(text, session.toolName ?? undefined)
    const call = reading.pending
    if (call === null || call.kind !== 'permission' || session.asked.has(call.id)) return changes
    session.asked.add(call.id)
    const keyMap = resolveKeyMap(reading.version, this.deps.measurements ?? KEY_MAP_MEASUREMENTS)
    changes.push({
      kind: 'open',
      dwarfId,
      input: {
        kind: 'permission',
        providerRequestId: call.id,
        channel: keyMap.kind === 'disabled' ? 'none' : 'hook-keystroke',
        payload: { toolName: call.toolName, requestText: this.deps.redact(call.requestText) },
        // Claude Code's dialog: "Yes" allows this call once; Esc declines it (ADR-012 item 3).
        options: { hasAllowOnce: true, hasRejectOnce: true }
      }
    })
    return changes
  }
}
