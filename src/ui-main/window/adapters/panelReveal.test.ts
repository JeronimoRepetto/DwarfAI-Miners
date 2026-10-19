// layer: L6
import { describe, expect, it } from 'vitest'
import { CHANNELS, type DwarfId, type MineId } from '@dwarfai/contracts'
import { createPanelReveal, REVEAL_DWARF_CHAT_PUSH } from './panelReveal'

// L6 (17 §1.6): the seam A push of the Panel's reveal (ISSUE-114; 14 §2.2 A-N16, §3.8; ADR-018 item 6; ADR-025 item 8).
// What reaches the Panel's renderer is checked against the registry schema the preload exposes it under, so the
// payload is exactly `{ mineId, dwarfId | null }`, nothing more.

const MINE = '01890a5d-ac96-774b-bcce-b302099a8111' as MineId
const DWARF = '01890a5d-ac96-774b-bcce-b302099ad111' as DwarfId

class RecordingModeWindow {
  readonly sent: Array<{ push: string; payload: unknown }> = []
  send(push: string, payload: unknown): void {
    this.sent.push({ push, payload })
  }
}

describe('panelReveal (ISSUE-114)', () => {
  it('[ADR-019] onRevealDwarfChat pushes { mineId, dwarfId | null } as its registry schema declares', () => {
    const panel = new RecordingModeWindow()
    const reveal = createPanelReveal(() => [panel])

    reveal.reveal({ mineId: MINE, dwarfId: DWARF })
    reveal.reveal({ mineId: MINE, dwarfId: null })

    expect(REVEAL_DWARF_CHAT_PUSH).toBe('mode:revealDwarfChat')
    expect(panel.sent).toEqual([
      { push: 'mode:revealDwarfChat', payload: { mineId: MINE, dwarfId: DWARF } },
      { push: 'mode:revealDwarfChat', payload: { mineId: MINE, dwarfId: null } }
    ])
    const schema = CHANNELS['mode:revealDwarfChat'].response
    for (const { payload } of panel.sent) expect(schema.safeParse(payload).success).toBe(true)
    // The schema is strict and typed: an extra field, a missing dwarf or a non-id is refused.
    expect(schema.safeParse({ mineId: MINE, dwarfId: DWARF, title: 'Ember' }).success).toBe(false)
    expect(schema.safeParse({ mineId: MINE }).success).toBe(false)
    expect(schema.safeParse({ mineId: 'mine-one', dwarfId: null }).success).toBe(false)
  })
})
