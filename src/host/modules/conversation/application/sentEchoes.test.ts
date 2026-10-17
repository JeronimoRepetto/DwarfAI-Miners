// L1 (17 §1.1): `SentEchoes`, the in-memory record of the person's messages handed to a launched
// session whose echo has not come back yet (INV-60; ISSUE-182, amendment-16 lead decision of
// 2026-10-15). A live-stream echo claims its message once: by the receipt's correlation once known,
// and while the hand-over is still in flight by the text sent. Nothing else is claimed.
import { describe, expect, it } from 'vitest'
import type { DwarfId, MessageId } from '../../../kernel/domain/values'
import type { ConversationEntry } from '../../suppliers'
import { SentEchoes } from './sentEchoes'

const DWARF = '00000000-0000-7000-8000-0000000182c1' as DwarfId
const OTHER = '00000000-0000-7000-8000-0000000182c2' as DwarfId
const SENT = '00000000-0000-7000-8000-0000000182c3' as MessageId
const SECOND = '00000000-0000-7000-8000-0000000182c4' as MessageId

function person(text: string, echoOf?: string): ConversationEntry {
  return {
    sourceKey: `driver:${text}:${echoOf ?? 'none'}`,
    role: 'person',
    text,
    providerTime: null,
    ...(echoOf === undefined ? {} : { echoOf })
  }
}

describe('SentEchoes', () => {
  it('[INV-60] an echo that arrives while the hand-over is in flight claims the sent message once, by its text', () => {
    const echoes = new SentEchoes()
    echoes.track(DWARF, SENT, 'Mark the face with chalk')

    expect(echoes.claim(DWARF, person('Mark the face with chalk', 'corr-1'), 'live-stream')).toBe(
      SENT
    )
    expect(echoes.claim(DWARF, person('Mark the face with chalk', 'corr-1'), 'live-stream')).toBe(
      null
    )
  })

  it('[INV-60] once the receipt names its correlation, the echo naming it claims the message whatever its text', () => {
    const echoes = new SentEchoes()
    echoes.track(DWARF, SENT, 'Mark the face with chalk')
    echoes.correlate(SENT, 'corr-1')

    expect(echoes.claim(DWARF, person('Mark the face with chalk.', 'corr-2'), 'live-stream')).toBe(
      null
    )
    expect(echoes.claim(DWARF, person('mark the face', 'corr-1'), 'live-stream')).toBe(SENT)
  })

  it('[INV-60] the oldest waiting message with the same text is claimed first', () => {
    const echoes = new SentEchoes()
    echoes.track(DWARF, SENT, 'again')
    echoes.track(DWARF, SECOND, 'again')

    expect(echoes.claim(DWARF, person('again'), 'live-stream')).toBe(SENT)
    expect(echoes.claim(DWARF, person('again'), 'live-stream')).toBe(SECOND)
  })

  it('[INV-60] a dwarf reply, another dwarf, a transcript entry, other text and a forgotten send claim nothing', () => {
    const echoes = new SentEchoes()
    echoes.track(DWARF, SENT, 'Mark the face with chalk')

    expect(
      echoes.claim(DWARF, { ...person('Mark the face with chalk'), role: 'dwarf' }, 'live-stream')
    ).toBe(null)
    expect(echoes.claim(OTHER, person('Mark the face with chalk'), 'live-stream')).toBe(null)
    expect(echoes.claim(DWARF, person('Mark the face with chalk'), 'transcript')).toBe(null)
    expect(echoes.claim(DWARF, person('Something else'), 'live-stream')).toBe(null)
    echoes.forget(SENT)
    expect(echoes.claim(DWARF, person('Mark the face with chalk'), 'live-stream')).toBe(null)
  })
})
