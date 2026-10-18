// The OpenCode server's event stream (`GET /event`, one JSON object per event) → DriverEvents for
// one session (15 §1.4, §4.6), read from the recorded OpenCode 1.18.32 runs
// (`fixtures/opencode/http-server/1.18.32/*-events.jsonl`). Skip-not-throw: a line that is not
// JSON, an event of another session and every event type this driver does not read are skipped; a
// read event whose shape is broken is one `protocol-drift` error and the stream goes on (HO-33).
//
// What is read (15 §4.6 Keys: `sourceKey = opencode:opencode:<sessionId>:<messageId or partId>`):
// - `session.status` busy / idle → `status` working / idle, on a change only.
// - `message.updated` → the role of each message; an assistant message once it reports
//   `time.completed` → one sealed fidelity-1 usage observation, `unitKey` = its message id.
// - `message.part.updated` text part → one message (person for a user message, dwarf for an
//   assistant one once its part reports `time.end`); tool part → activity started / finished /
//   failed, summarised by the tool name only (never its input or output, ADR-007 item 4).
// - `permission.asked` → one permission ask on the driver channel (Allow `once`, Deny `reject`).
// - `session.error` → a provider error, except `MessageAbortedError`: the abort DwarfAI asked for.
// Not read: `permission.replied` (answeredElsewhere U→no, SP-09), `session.idle` (no turn end
// until S-021-2), deltas (a part is read whole), reasoning and step parts, and every other type.
import type { DriverEvent } from '../../../ports/providerDriver'

export interface ServerEventMapperDeps {
  readonly providerId: string
  readonly sessionId: string
  /** One-line redaction of activity summaries and card lines (bound by wiring). */
  readonly redact: (text: string) => string
}

type Fields = Readonly<Record<string, unknown>>

const ABORTED = 'MessageAbortedError'

const fields = (value: unknown): Fields | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Fields) : null
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const count = (value: unknown): number => (typeof value === 'number' && value >= 0 ? value : 0)

export class ServerEventMapper {
  private status: 'working' | 'idle' | null = null
  private readonly roles = new Map<string, string>()
  private readonly sealed = new Set<string>()
  private readonly said = new Set<string>()
  /** Per tool part, the last state reported; per tool call, its tool's name (for the ask card). */
  private readonly tools = new Map<string, string>()
  private readonly toolNames = new Map<string, string>()
  private readonly asked = new Set<string>()

  constructor(private readonly deps: ServerEventMapperDeps) {}

  map(line: string): DriverEvent[] {
    let event: Fields | null
    try {
      event = fields(JSON.parse(line))
    } catch {
      return []
    }
    const props = fields(event?.['properties'])
    if (event === null || props === null) return []
    if (props['sessionID'] !== this.deps.sessionId) return []
    switch (event['type']) {
      case 'session.status':
        return this.onStatus(props)
      case 'message.updated':
        return this.onMessage(props)
      case 'message.part.updated':
        return this.onPart(props)
      case 'permission.asked':
        return this.onPermission(props)
      case 'session.error':
        return this.onError(props)
      default:
        return []
    }
  }

  private key(id: string): string {
    return `${this.deps.providerId}:${this.deps.providerId}:${this.deps.sessionId}:${id}`
  }

  private onStatus(props: Fields): DriverEvent[] {
    const kind = fields(props['status'])?.['type']
    const value = kind === 'busy' ? 'working' : kind === 'idle' ? 'idle' : null
    if (value === null || value === this.status) return []
    this.status = value
    return [{ t: 'status', value }]
  }

  private onMessage(props: Fields): DriverEvent[] {
    const info = fields(props['info'])
    const id = text(info?.['id'])
    const role = text(info?.['role'])
    if (info === null || id === null || role === null) return []
    this.roles.set(id, role)
    const completed = fields(info['time'])?.['completed']
    const tokens = fields(info['tokens'])
    if (role !== 'assistant' || typeof completed !== 'number' || tokens === null) return []
    if (this.sealed.has(id)) return []
    this.sealed.add(id)
    const cache = fields(tokens['cache'])
    return [
      {
        t: 'usage',
        observation: {
          sourceKey: this.key(id),
          unitKey: id,
          fidelity: 1,
          tokens: {
            inputNet: count(tokens['input']),
            output: count(tokens['output']),
            cacheRead: count(cache?.['read']),
            cacheWrite: count(cache?.['write']),
            reasoning: count(tokens['reasoning'])
          },
          sealed: true,
          providerTime: completed
        }
      }
    ]
  }

  private onPart(props: Fields): DriverEvent[] {
    const part = fields(props['part'])
    const id = text(part?.['id'])
    if (part === null || id === null) return []
    if (part['type'] === 'text') return this.onText(part, id)
    if (part['type'] === 'tool') return this.onTool(part, id)
    return []
  }

  private onText(part: Fields, id: string): DriverEvent[] {
    const body = text(part['text'])
    const messageId = text(part['messageID'])
    const role = messageId === null ? undefined : this.roles.get(messageId)
    if (body === null || this.said.has(id)) return []
    const done = fields(part['time'])?.['end'] !== undefined
    const speaker = role === 'user' ? 'person' : role === 'assistant' && done ? 'dwarf' : null
    if (speaker === null) return []
    this.said.add(id)
    return [
      {
        t: 'message',
        record: { sourceKey: this.key(id), role: speaker, text: body, providerTime: null }
      }
    ]
  }

  private onTool(part: Fields, id: string): DriverEvent[] {
    const name = text(part['tool'])
    const status = fields(part['state'])?.['status']
    const call = text(part['callID'])
    if (name === null) return []
    if (call !== null) this.toolNames.set(call, name)
    const state =
      status === 'running'
        ? 'started'
        : status === 'completed'
          ? 'finished'
          : status === 'error'
            ? 'failed'
            : null
    if (state === null || this.tools.get(id) === state) return []
    this.tools.set(id, state)
    return [
      {
        t: 'activity',
        step: {
          sourceKey: this.key(id),
          turnKey: null,
          kind: 'tool',
          toolName: name,
          summary: this.deps.redact(name),
          state,
          at: null
        }
      }
    ]
  }

  private onPermission(props: Fields): DriverEvent[] {
    const id = text(props['id'])
    if (id === null) {
      return [
        { t: 'error', cause: { kind: 'protocol-drift', detail: 'permission.asked without an id' } }
      ]
    }
    if (this.asked.has(id)) return []
    this.asked.add(id)
    const kind = text(props['permission']) ?? 'permission'
    const patterns = Array.isArray(props['patterns'])
      ? props['patterns'].filter((p): p is string => typeof p === 'string')
      : []
    const call = text(fields(props['tool'])?.['callID'])
    const toolName = (call === null ? undefined : this.toolNames.get(call)) ?? kind
    const line = patterns.length === 0 ? kind : `${kind}: ${patterns.join(', ')}`
    return [
      {
        t: 'ask.opened',
        ask: {
          kind: 'permission',
          providerRequestId: id,
          channel: 'driver',
          payload: { toolName, requestText: this.deps.redact(line.split(/\r?\n/)[0] ?? '') },
          options: { hasAllowOnce: true, hasRejectOnce: true }
        }
      }
    ]
  }

  private onError(props: Fields): DriverEvent[] {
    const name = text(fields(props['error'])?.['name'])
    if (name === ABORTED) return []
    return [
      {
        t: 'error',
        cause: { kind: 'provider-error', detail: name ?? 'unknown error', retryable: false }
      }
    ]
  }
}
