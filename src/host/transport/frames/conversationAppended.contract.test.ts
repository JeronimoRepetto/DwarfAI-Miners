// layer: L6
// L6 (17 §1.6): the conversation frame of seam B — B-F11 `conversation.appended {dwarfId,
// messages}` (14 §2.4, §3.5, frozen; ADR-031 item 2) — projected from `MessagesAppended` (08 §0)
// by frames/conversationAppended.ts. The conversation module is the real ingest over its
// in-memory doubles (its bus refuses a publish inside a transaction, 16 §2.3); the frames go
// through the real connection registry to one connection of each role and to a viewer of each of
// two dwarfs. Every frame is checked against its 14 §3.5 strict() schema (14 §1.4).
//
// TC-103-02 (a viewer of A never receives a frame of B), TC-103-04 (no message text logged).
import { describe, expect, it } from 'vitest'
import { HOST_FRAME_SCHEMAS } from '@dwarfai/contracts'
import type { DwarfId } from '../../kernel/domain/values'
import type { ChannelRole } from '../roles'
import { inMemoryConversation } from '../../modules/conversation/testing/inMemoryConversation'
import { ConnectionRegistry } from '../connectionRegistry'
import { CONVERSATION_FRAMES, publishConversationFrames } from './conversationAppended'

const DWARF_A = '01920000-0000-7000-9000-00000000000a' as DwarfId
const DWARF_B = '01920000-0000-7000-9000-00000000000b' as DwarfId
const CANARY = 'canary-0103-appended-text'

interface Received {
  name: string
  data: unknown
  seq: number
}

function validateFrame(name: string, data: unknown): void {
  const schemas: Readonly<Record<string, { parse(value: unknown): unknown } | undefined>> =
    HOST_FRAME_SCHEMAS
  const schema = schemas[name]
  if (schema === undefined) throw new Error(`no contract schema for ${name}`)
  schema.parse(data)
}

/** Attaches one connection of `role` (a viewer bound to `dwarfId`) and returns what it receives. */
function connect(
  connections: ConnectionRegistry,
  role: ChannelRole,
  clientId: string,
  dwarfId?: DwarfId
): Received[] {
  const received: Received[] = []
  connections.attach({
    role,
    clientId,
    ...(dwarfId === undefined ? {} : { dwarfId }),
    send: (name, data, seq) => received.push({ name, data, seq }),
    end: () => Promise.resolve()
  })
  return received
}

describe('the conversation frame (14 §2.4 B-F11; 08 §0 MessagesAppended)', () => {
  it('[ADR-003] conversation.appended reaches ui connections and the viewer of that dwarf only, never a notifier', () => {
    const c = inMemoryConversation()
    const connections = new ConnectionRegistry({ validateFrame })
    const stop = publishConversationFrames({ events: c.bus, frames: connections })
    const ui = connect(connections, 'ui', 'ui-1')
    const notifier = connect(connections, 'notifier', 'notifier-1')
    const viewerA = connect(connections, 'viewer', 'viewer-a', DWARF_A)
    const viewerB = connect(connections, 'viewer', 'viewer-b', DWARF_B)

    c.commands.ingest(
      DWARF_A,
      [
        { sourceKey: 'claude:a:1', role: 'person', text: `${CANARY} 1`, providerTime: 1_000 },
        { sourceKey: 'claude:a:2', role: 'dwarf', text: `${CANARY} 2`, providerTime: 1_001 }
      ],
      'live-stream'
    )
    // A repeat of a stored key appends nothing, so it sends nothing.
    c.commands.ingest(
      DWARF_A,
      [{ sourceKey: 'claude:a:1', role: 'person', text: `${CANARY} 1`, providerTime: 1_000 }],
      'transcript'
    )
    c.commands.ingest(
      DWARF_B,
      [{ sourceKey: 'claude:b:1', role: 'dwarf', text: `${CANARY} b`, providerTime: 2_000 }],
      'live-stream'
    )

    // The ui connection receives both frames, each the rows its batch inserted, as MessageView.
    expect(ui.map((frame) => frame.name)).toEqual([
      'conversation.appended',
      'conversation.appended'
    ])
    const first = HOST_FRAME_SCHEMAS['conversation.appended'].parse(ui[0]?.data)
    expect(first.dwarfId).toBe(DWARF_A)
    expect(first.messages.map((m) => [m.role, m.text, m.providerTime])).toEqual([
      ['person', `${CANARY} 1`, 1_000],
      ['dwarf', `${CANARY} 2`, 1_001]
    ])
    expect(first.messages.map((m) => m.id)).toEqual(
      c.bus.ofType('MessagesAppended')[0]?.payload.messages.map((m) => m.id)
    )
    expect(HOST_FRAME_SCHEMAS['conversation.appended'].parse(ui[1]?.data).dwarfId).toBe(DWARF_B)

    // Each viewer receives its own dwarf's frame only; a notifier receives none.
    expect(viewerA.map((frame) => (frame.data as { dwarfId: string }).dwarfId)).toEqual([DWARF_A])
    expect(viewerB.map((frame) => (frame.data as { dwarfId: string }).dwarfId)).toEqual([DWARF_B])
    expect(notifier).toEqual([])
    expect(CONVERSATION_FRAMES).toEqual(['conversation.appended'])

    stop()
    c.commands.ingest(
      DWARF_A,
      [{ sourceKey: 'claude:a:3', role: 'dwarf', text: `${CANARY} 3`, providerTime: 1_002 }],
      'live-stream'
    )
    expect(ui).toHaveLength(2)
  })
})
