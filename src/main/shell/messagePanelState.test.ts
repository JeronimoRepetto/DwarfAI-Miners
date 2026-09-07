import { describe, expect, it } from 'vitest'
import {
  emptyMessagePanel,
  parseDwarfDeliveryReport,
  parseMessagePanelHeight,
  parseMessagePanelState
} from './messagePanelState'

describe('emptyMessagePanel', () => {
  it('is the window closed, naming neither a mine nor a dwarf', () => {
    expect(emptyMessagePanel()).toEqual({ surface: 'none', mineId: '', dwarfId: '' })
  })

  it('is a fresh object every time, so nobody can mutate the closed state', () => {
    const first = emptyMessagePanel()
    first.surface = 'message'
    expect(emptyMessagePanel().surface).toBe('none')
  })
})

describe('parseMessagePanelState', () => {
  it('takes the message surface a dwarf was selected on', () => {
    expect(
      parseMessagePanelState({ surface: 'message', mineId: 'mine:a', dwarfId: 'claude:s1' })
    ).toEqual({ surface: 'message', mineId: 'mine:a', dwarfId: 'claude:s1' })
  })

  it('takes the launch surface, which names a mine and no dwarf yet', () => {
    expect(parseMessagePanelState({ surface: 'launch', mineId: 'mine:a', dwarfId: '' })).toEqual({
      surface: 'launch',
      mineId: 'mine:a',
      dwarfId: ''
    })
  })

  it('forgets both ids on the closed surface, whatever was sent with it', () => {
    // 'none' is the window closed: keeping the ids would leave main holding a
    // selection nothing is showing, which the next reader would believe.
    expect(
      parseMessagePanelState({ surface: 'none', mineId: 'mine:a', dwarfId: 'claude:s1' })
    ).toEqual(emptyMessagePanel())
  })

  it('refuses a message surface that names nobody', () => {
    // Opening the panel on no dwarf is not a state to render; it is a payload
    // that could not say what it meant.
    expect(parseMessagePanelState({ surface: 'message', mineId: 'mine:a', dwarfId: '' })).toBeNull()
    expect(
      parseMessagePanelState({ surface: 'message', mineId: '', dwarfId: 'claude:s1' })
    ).toBeNull()
  })

  it('refuses a launch surface with no mine to launch into', () => {
    expect(parseMessagePanelState({ surface: 'launch', mineId: '', dwarfId: '' })).toBeNull()
  })

  it('refuses a surface this build does not have, rather than guessing one', () => {
    expect(parseMessagePanelState({ surface: 'history', mineId: 'mine:a', dwarfId: '' })).toBeNull()
    expect(parseMessagePanelState({ mineId: 'mine:a', dwarfId: '' })).toBeNull()
  })

  it('refuses anything that is not an object of strings', () => {
    expect(parseMessagePanelState(null)).toBeNull()
    expect(parseMessagePanelState('message')).toBeNull()
    expect(
      parseMessagePanelState({ surface: 'message', mineId: 1, dwarfId: 'claude:s1' })
    ).toBeNull()
    expect(parseMessagePanelState({ surface: 'message', mineId: 'mine:a', dwarfId: 7 })).toBeNull()
  })
})

describe('parseMessagePanelHeight', () => {
  it('takes a whole number of design pixels', () => {
    expect(parseMessagePanelHeight(235)).toBe(235)
    expect(parseMessagePanelHeight(578)).toBe(578)
  })

  it('rounds a measured height, because Electron bounds take nothing else', () => {
    expect(parseMessagePanelHeight(235.4)).toBe(235)
    expect(parseMessagePanelHeight(235.6)).toBe(236)
  })

  it('refuses a height no window could have', () => {
    // A zero or negative height would make the window vanish, and NaN/Infinity
    // reach setBounds as a rectangle Electron cannot apply.
    expect(parseMessagePanelHeight(0)).toBeNull()
    expect(parseMessagePanelHeight(-235)).toBeNull()
    expect(parseMessagePanelHeight(Number.NaN)).toBeNull()
    expect(parseMessagePanelHeight(Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('refuses anything that is not a number', () => {
    expect(parseMessagePanelHeight('235')).toBeNull()
    expect(parseMessagePanelHeight(null)).toBeNull()
    expect(parseMessagePanelHeight({ height: 235 })).toBeNull()
  })
})

describe('parseDwarfDeliveryReport', () => {
  it('takes the two maps of verdicts the panel window holds', () => {
    const report = {
      send: { 'claude:s1': { phase: 'delivered', via: 'terminal', awaitingReaction: true } },
      kick: { 'claude:s2': { phase: 'failed', error: 'No channel could carry it.' } }
    }
    expect(parseDwarfDeliveryReport(report)).toEqual(report)
  })

  it('takes an empty report, which is every marker having expired', () => {
    expect(parseDwarfDeliveryReport({ send: {}, kick: {} })).toEqual({ send: {}, kick: {} })
  })

  it('keeps the two vocabularies apart: a kick never "sends" and a send never "kicks"', () => {
    expect(parseDwarfDeliveryReport({ send: { a: { phase: 'kicking' } }, kick: {} })).toBeNull()
    expect(parseDwarfDeliveryReport({ send: {}, kick: { a: { phase: 'sending' } } })).toBeNull()
  })

  it('refuses the whole report when one entry is malformed, rather than dropping it', () => {
    // Same discipline as parseAnswerRequest's record: a partly-read report is
    // one the mine would draw a marker from and be missing another, with
    // nothing anywhere saying so.
    expect(
      parseDwarfDeliveryReport({
        send: { 'claude:s1': { phase: 'delivered' }, 'claude:s2': { phase: 'exploded' } },
        kick: {}
      })
    ).toBeNull()
    expect(
      parseDwarfDeliveryReport({ send: { 'claude:s1': { phase: 'delivered', via: 7 } }, kick: {} })
    ).toBeNull()
    expect(
      parseDwarfDeliveryReport({
        send: { 'claude:s1': { phase: 'delivered', awaitingReaction: 'yes' } },
        kick: {}
      })
    ).toBeNull()
  })

  it('refuses anything that is not the pair of maps', () => {
    expect(parseDwarfDeliveryReport(null)).toBeNull()
    expect(parseDwarfDeliveryReport({ send: {} })).toBeNull()
    expect(parseDwarfDeliveryReport({ send: {}, kick: null })).toBeNull()
    expect(parseDwarfDeliveryReport({ send: [], kick: {} })).toBeNull()
  })

  it('drops nothing it accepted: an absent optional field stays absent', () => {
    // The renderer's own stores leave `via`, `error` and `awaitingReaction` off
    // when they have nothing to say, and a normalizer that filled them in
    // would put words on a marker nobody wrote.
    const parsed = parseDwarfDeliveryReport({ send: { a: { phase: 'sending' } }, kick: {} })
    expect(parsed?.send.a).toEqual({ phase: 'sending' })
  })
})
