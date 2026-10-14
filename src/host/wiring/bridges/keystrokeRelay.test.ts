// layer: L3
// L3 (17 §1.3): the `KeystrokeRelay` bridge (ADR-012 item 3; ADR-014 item 1) over the crew
// application on its in-memory doubles, a scripted read of observation's recorded process
// identities and a recording key delivery. The key goes only to the process observation recorded
// for the dwarf's own observed session, and to nothing when there is none.
import { describe, expect, it } from 'vitest'
import type { ProcessIdentity } from '../../kernel/domain/processIdentity'
import type { DwarfId, MineId } from '../../kernel/domain/values'
import type { KeystrokeTarget } from '../../modules/asking/adapters/observedClaude/ObservedClaudeKeystrokeChannel'
import type { ConsoleKey } from '../../modules/conversation/adapters/observed-send/consoleKeys'
import { rankForDepth } from '../../modules/crew'
import { inMemoryCrew } from '../../modules/crew/testing/inMemoryCrew'
import { createKeystrokeRelay } from './keystrokeRelay'

const MINE = '00000000-0000-7000-8000-0000000000f1' as MineId
const PROCESS: ProcessIdentity = {
  pid: 4242,
  processStartTimeMs: 1_790_000_000_000,
  bootId: 'boot'
}
const ONE: ConsoleKey = { kind: 'text', text: '1' }
const ESC: ConsoleKey = { kind: 'escape' }

function harness(answer: 'pressed' | 'refused' | 'throws' = 'pressed') {
  const crew = inMemoryCrew()
  const identities = new Map<DwarfId, ProcessIdentity>()
  const pressed: { target: ProcessIdentity; key: ConsoleKey }[] = []
  const relay = createKeystrokeRelay({
    crew: crew.queries,
    observed: { processIdentityOf: (dwarfId) => identities.get(dwarfId) ?? null },
    delivery: {
      press: (target, key) => {
        pressed.push({ target: { ...target }, key })
        if (answer === 'throws') return Promise.reject(new Error('spawn failed'))
        return Promise.resolve(answer)
      }
    }
  })
  let sequence = 0
  function seat(opts: { owned?: boolean; recorded?: boolean } = {}) {
    sequence += 1
    const providerSessionId = `session-${sequence}`
    const dwarfId = crew.commands.arrive({
      mineId: MINE,
      identity: { providerId: 'claude', providerSessionId },
      rank: rankForDepth(0),
      status: 'idle'
    })
    if (opts.owned === true) crew.owned.add(dwarfId)
    if (opts.recorded !== false) identities.set(dwarfId, { ...PROCESS })
    const target: KeystrokeTarget = { dwarfId, providerSessionId }
    return { dwarfId, target }
  }
  return { crew, relay, pressed, seat }
}

describe('KeystrokeRelay bridge (ADR-012 item 3, ADR-014 item 1)', () => {
  it("[ADR-012, ADR-014] a key is pressed in the process observation recorded for the dwarf's observed session", async () => {
    const { relay, pressed, seat } = harness()
    const { target } = seat()

    expect(await relay.press(target, ONE)).toBe('pressed')
    expect(await relay.press(target, ESC)).toBe('pressed')
    expect(pressed).toEqual([
      { target: PROCESS, key: ONE },
      { target: PROCESS, key: ESC }
    ])
  })

  it('[ADR-014, INV-51] no recorded process identity, an unknown dwarf or another session of the dwarf: refused, nothing pressed', async () => {
    const { relay, pressed, seat } = harness()
    const unrecorded = seat({ recorded: false })
    expect(await relay.press(unrecorded.target, ONE)).toBe('refused')

    const unknown = {
      dwarfId: '00000000-0000-7000-8000-00000000dead' as DwarfId,
      providerSessionId: 'x'
    }
    expect(await relay.press(unknown, ESC)).toBe('refused')

    const seated = seat()
    expect(await relay.press({ ...seated.target, providerSessionId: 'another-session' }, ONE)).toBe(
      'refused'
    )

    expect(pressed).toEqual([])
  })

  it('[ADR-012] an owned dwarf never uses the keystroke channel: refused, nothing pressed', async () => {
    const { relay, pressed, seat } = harness()
    const owned = seat({ owned: true })
    expect(await relay.press(owned.target, ONE)).toBe('refused')
    expect(pressed).toEqual([])
  })

  it('[ADR-012] a delivery that refuses or fails is refused', async () => {
    for (const answer of ['refused', 'throws'] as const) {
      const { relay, seat } = harness(answer)
      expect({ answer, outcome: await relay.press(seat().target, ONE) }).toEqual({
        answer,
        outcome: 'refused'
      })
    }
  })
})
