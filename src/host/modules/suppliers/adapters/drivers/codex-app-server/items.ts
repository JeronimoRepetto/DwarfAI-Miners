// Readers of Codex app-server thread items (15 §4.4 Keys; codex@8f195c9 `ThreadItem`), pure. A
// `userMessage` is the person's line, an `agentMessage` the dwarf's (aggregated: the completed item
// holds the whole text, so deltas are not read); a tool item is one activity step whose summary is
// one redacted line and never tool output (ADR-007 item 4). Reasoning, plans, hook prompts, review
// markers and compactions are not conversation and yield nothing.
import type { ActivityStep } from '../../../ports/providerDriver'

type Rec = Record<string, unknown>

function isRecord(value: unknown): value is Rec {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** The item types that are one tool step each. */
const TOOL_ITEMS: ReadonlySet<string> = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'webSearch',
  'imageView',
  'imageGeneration'
])

/** One item of an `item/started` / `item/completed` notification, with where it belongs. */
export interface ItemEvent {
  readonly threadId: string
  readonly turnId: string | null
  readonly item: Rec
  readonly id: string
  readonly type: string
  /** The notification's own instant (`startedAtMs` / `completedAtMs`), or null. */
  readonly at: number | null
}

export function readItemEvent(params: unknown): ItemEvent | null {
  if (!isRecord(params) || !isRecord(params.item)) return null
  const threadId = text(params.threadId)
  const id = text(params.item.id)
  const type = text(params.item.type)
  if (threadId === null || id === null || type === null) return null
  const at = params.completedAtMs ?? params.startedAtMs
  return {
    threadId,
    turnId: text(params.turnId),
    item: params.item,
    id,
    type,
    at: typeof at === 'number' && Number.isFinite(at) ? at : null
  }
}

/** The text of a conversation item: the person's input text parts, or the dwarf's message. */
export function messageOf(item: Rec): { role: 'person' | 'dwarf'; text: string } | null {
  if (item.type === 'agentMessage') {
    const said = text(item.text)
    return said === null ? null : { role: 'dwarf', text: said }
  }
  if (item.type !== 'userMessage' || !Array.isArray(item.content)) return null
  const parts = item.content.flatMap((part) =>
    isRecord(part) && part.type === 'text' && text(part.text) !== null ? [part.text as string] : []
  )
  return parts.length === 0 ? null : { role: 'person', text: parts.join('\n') }
}

export function isToolItem(type: string): boolean {
  return TOOL_ITEMS.has(type)
}

/** One line naming what a tool step does (never its output). */
function summaryOf(item: Rec): string {
  switch (item.type) {
    case 'commandExecution':
      return text(item.command) ?? 'command'
    case 'fileChange': {
      const paths = Array.isArray(item.changes)
        ? item.changes.flatMap((change) =>
            isRecord(change) && text(change.path) !== null ? [change.path as string] : []
          )
        : []
      return paths.length === 0 ? 'file change' : paths.join(', ')
    }
    case 'mcpToolCall':
      return (
        [text(item.server), text(item.tool)].filter((part) => part !== null).join('.') || 'tool'
      )
    case 'dynamicToolCall':
      return text(item.tool) ?? 'tool'
    case 'webSearch':
      return text(item.query) ?? 'web search'
    default:
      return String(item.type)
  }
}

/** The step's state: started, or how the completed item ended. */
function stateOf(item: Rec, completed: boolean): ActivityStep['state'] {
  if (!completed) return 'started'
  return item.status === 'failed' || item.status === 'declined' ? 'failed' : 'finished'
}

/** The activity step of a tool item, keyed by `sourceKey`; `redact` runs over its summary. */
export function activityOf(
  event: ItemEvent,
  sourceKey: string,
  completed: boolean,
  redact: (text: string) => string
): ActivityStep {
  return {
    sourceKey,
    turnKey: event.turnId,
    kind: 'tool',
    toolName: event.type,
    summary: redact(summaryOf(event.item)),
    state: stateOf(event.item, completed),
    at: event.at
  }
}

/** The conversation items of a resumed thread's history (`thread.turns[].items[]`), in order. */
export function historyMessages(
  thread: unknown
): { id: string; role: 'person' | 'dwarf'; text: string }[] {
  if (!isRecord(thread) || !Array.isArray(thread.turns)) return []
  return thread.turns.flatMap((turn) =>
    isRecord(turn) && Array.isArray(turn.items)
      ? turn.items.flatMap((item) => {
          if (!isRecord(item)) return []
          const id = text(item.id)
          const message = messageOf(item)
          return id === null || message === null ? [] : [{ id, ...message }]
        })
      : []
  )
}
