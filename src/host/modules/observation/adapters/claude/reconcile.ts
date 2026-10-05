// The Claude reconciliation rules (15 §5 "Anti-ghost reconciliation placement" item 1 and "PID +
// creation-time re-adoption"; ADR-029 §B), kept inside the Claude adapter (R12). Pure: records and
// readings in, facts out; no I/O and no clock read.
//
// - Endings (#28, #64; docs/provider-formats.md §1.4): a subagent has ended when Claude Code
//   delivers its `<task-notification>` with a terminal `<status>` (`completed`, `failed` or
//   `killed`) through one of the three envelopes the harness itself writes: a `queue-operation`
//   record's `content`, a `queued_command` attachment's `prompt`, or a `user` line that is not a
//   tool result. Every other place the blob appears (a tool result, model output, a hook's stdout)
//   is a quotation and ends nobody. The ending's `<task-id>` is the subagent's agent id, so the
//   ended identity is the session plus that agent (ADR-015 item 7); the observation loop records it
//   in `EndedAgentLedger`, and nothing brings it back (INV-36). A resumed agent (#179, #338) is
//   therefore not re-surfaced: the trade-off the legacy provider made before #179, now the
//   invariant.
// - Depth (#157) and the sidecar sweep (#391) are the parent identity the adapter already reports
//   from a subagent's sidecar (`subagents.ts`, `parentAgentId`): every `agent-<id>.jsonl` under
//   `subagents/` is discovered whatever its launch record says, and crew ranks by the parent chain.
// - The session registry `sessions/<pid>.json` names the pid of a session's process and, as a
//   Windows FILETIME, when that process started (`procStart`). The #45 guard reads a probe of the
//   pid against it with the kernel's one tolerance (`PROCESS_START_TOLERANCE_MS`, ADR-015 item 1):
//   a probe further than that from the recorded start is another process on a recycled pid and is
//   not taken for the session. Its polarity is its own (15 §5): a probe with no answer stands
//   aside and keeps the registry's record, where the kernel's #231 rule (`matchesRecorded`) treats
//   no answer as a mismatch; that rule still runs before any kill (ADR-014), so standing aside can
//   never end a stranger's process. A pid with no recorded start is never evidence (INV-51).
//
// Reimplemented from the candidate `src/main/providers/claude/{claudeProvider,parse}.ts`
// (`terminalAgents`, `notificationStrings`, `procStartVerdicts`; R16).
import {
  PROCESS_START_TOLERANCE_MS,
  type ProbeResult,
  type ProcessIdentity
} from '../../../../kernel/domain/processIdentity'

type Rec = Record<string, unknown>

/** The statuses a `<task-notification>` ends an agent with; `killed` is an accidental stop. */
const TASK_ENDING =
  /<task-id>([^<]+)<\/task-id>[\s\S]*?<status>(completed|failed|killed)<\/status>/g

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Every string of a message's content, text blocks and nested content included. */
function contentStrings(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  const strings: string[] = []
  for (const item of content) {
    if (typeof item === 'string') strings.push(item)
    else if (isRecord(item))
      strings.push(...contentStrings(item.text), ...contentStrings(item.content))
  }
  return strings
}

/** The strings the harness delivered a notification in; never a quotation of one (#64). */
function deliveredStrings(record: Rec): string[] {
  if (record.type === 'queue-operation') {
    const content = asString(record.content)
    return content === undefined ? [] : [content]
  }
  if (record.type === 'attachment') {
    const attachment = record.attachment
    if (!isRecord(attachment) || attachment.type !== 'queued_command') return []
    const prompt = asString(attachment.prompt)
    return prompt === undefined ? [] : [prompt]
  }
  if (record.type !== 'user') return []
  // A user line with a tool result is a tool's output, whatever it printed.
  if (record.toolUseResult !== undefined || !isRecord(record.message)) return []
  const content = record.message.content
  if (Array.isArray(content) && content.some((b) => isRecord(b) && b.type === 'tool_result')) {
    return []
  }
  return contentStrings(content)
}

/** The agent ids one transcript record says have ended, in order, each once. */
export function endedAgentsIn(record: Rec): string[] {
  const ended: string[] = []
  for (const text of deliveredStrings(record)) {
    for (const match of text.matchAll(TASK_ENDING)) {
      const agentId = match[1]!.trim()
      if (agentId !== '' && !ended.includes(agentId)) ended.push(agentId)
    }
  }
  return ended
}

/** One entry of the session registry `sessions/<pid>.json`, as the #45 guard needs it. */
export interface RegistryEntry {
  pid: number
  sessionId: string
  /** When the session's process started (epoch ms), or null when the entry records none. */
  recordedStartMs: number | null
}

/** 100 ns ticks between 1601-01-01 (FILETIME) and 1970-01-01 (epoch). */
const FILETIME_EPOCH_OFFSET = 116_444_736_000_000_000n
/** A FILETIME outside these bounds is not a process start time this app could see. */
const MIN_PLAUSIBLE_EPOCH_MS = Date.UTC(2000, 0, 1)
const MAX_PLAUSIBLE_EPOCH_MS = Date.UTC(2200, 0, 1)

/** A Windows FILETIME (decimal 100 ns ticks since 1601) as epoch ms, or null when it is not one. */
export function filetimeToEpochMs(value: string): number | null {
  const trimmed = value.trim()
  if (!/^\d{1,20}$/.test(trimmed)) return null
  const epochMs = Number((BigInt(trimmed) - FILETIME_EPOCH_OFFSET) / 10_000n)
  if (epochMs < MIN_PLAUSIBLE_EPOCH_MS || epochMs > MAX_PLAUSIBLE_EPOCH_MS) return null
  return epochMs
}

/** A registry file's entry, or null when it names no pid or no session. */
export function registryEntryOf(text: string): RegistryEntry | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const pid = parsed.pid
  const sessionId = asString(parsed.sessionId)
  if (
    typeof pid !== 'number' ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    sessionId === undefined
  ) {
    return null
  }
  const procStart = asString(parsed.procStart)
  return {
    pid,
    sessionId,
    recordedStartMs: procStart === undefined ? null : filetimeToEpochMs(procStart)
  }
}

/**
 * The #45 guard: the process identity of a registry entry, given a probe of its pid and the
 * current boot id. Null when the pid is not the session's process (nothing runs on it, or a probe
 * further than the kernel's tolerance from the recorded start), when the entry records no start,
 * or when no boot id is known. A probe with no answer stands aside (#45 polarity) and keeps the
 * registry's record. The identity always carries the recorded start, so every later check is
 * against the session's own process, never against whatever the probe found.
 */
export function registryIdentity(
  entry: RegistryEntry,
  probe: ProbeResult,
  currentBootId: string | 'unknown'
): ProcessIdentity | null {
  if (entry.recordedStartMs === null || probe === 'absent') return null
  if (probe === 'unknown') {
    if (currentBootId === 'unknown') return null
    return { pid: entry.pid, processStartTimeMs: entry.recordedStartMs, bootId: currentBootId }
  }
  const apart = Math.abs(probe.processStartTimeMs - entry.recordedStartMs)
  if (!Number.isFinite(apart) || apart > PROCESS_START_TOLERANCE_MS) return null
  return { pid: entry.pid, processStartTimeMs: entry.recordedStartMs, bootId: probe.bootId }
}
