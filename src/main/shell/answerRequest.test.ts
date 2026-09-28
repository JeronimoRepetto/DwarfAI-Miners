import { describe, expect, it } from 'vitest'
import { MAX_DWARF_TEXT_CHARS } from '../domain/types'
import { parseAnswerRequest } from './answerRequest'

/*
 * MOVED here for #635 from messagePanelState.test.ts with the parser it tests. REMOVED with the
 * parsers that went with the message panel's own window, stated rather than passing unseen:
 * 'emptyMessagePanel', 'parseMessagePanelState', 'parseMessagePanelHeight',
 * 'parseDwarfDeliveryReport' and 'parseDwarfDeliveryReport, failed sends'. Nothing crosses the
 * bridge for them any more: the surface and the delivery verdicts are the renderer's own state
 * (useMessageDock, asserted in App.messageDock.test.ts), and the panel has no window to size.
 */

/*
 * The answer channel's own boundary, moved here from index.ts by #481 so that
 * every refusal below is assertable without an Electron window — the reason
 * every other parser in this file is here.
 *
 * Two forms cross it now. The LABEL form has been on the wire since #125: a
 * record keyed by the question's text and valued by one of the agent's own
 * option labels. The TEXT form is #481's, and it is the person's own words for
 * the picker's "Other" row. Exactly one of them, never both and never neither,
 * because a payload carrying both could not say which answer it meant and main
 * would be picking one on the person's behalf.
 */
describe('parseAnswerRequest (#125, #481)', () => {
  it('reads an answer that names one of the agent’s own labels', () => {
    expect(
      parseAnswerRequest({
        dwarfId: 'claude:s1',
        toolUseId: 'toolu_01',
        answers: { 'Which database?': 'Postgres' }
      })
    ).toEqual({
      dwarfId: 'claude:s1',
      toolUseId: 'toolu_01',
      answers: { 'Which database?': 'Postgres' }
    })
  })

  it('reads an answer written in the person’s own words', () => {
    expect(
      parseAnswerRequest({
        dwarfId: 'claude:s1',
        toolUseId: 'toolu_01',
        text: 'neither — put it in Redis'
      })
    ).toEqual({
      dwarfId: 'claude:s1',
      toolUseId: 'toolu_01',
      text: 'neither — put it in Redis'
    })
  })

  it('refuses a payload carrying both forms, which says two things at once', () => {
    expect(
      parseAnswerRequest({
        dwarfId: 'claude:s1',
        toolUseId: 'toolu_01',
        answers: { 'Which database?': 'Postgres' },
        text: 'neither'
      })
    ).toBeNull()
  })

  it('refuses a payload carrying neither, which answers nothing', () => {
    expect(parseAnswerRequest({ dwarfId: 'claude:s1', toolUseId: 'toolu_01' })).toBeNull()
  })

  it('refuses an empty text, which is a field that could not say anything', () => {
    // A shape refusal and not a judgement of the words: whitespace alone is
    // content, and it is refused deeper down where the keys are built, with the
    // sentence that is true of it.
    expect(parseAnswerRequest({ dwarfId: 'd', toolUseId: 't', text: '' })).toBeNull()
  })

  it('refuses a text past the wire’s own ceiling', () => {
    const long = 'x'.repeat(MAX_DWARF_TEXT_CHARS + 1)
    expect(parseAnswerRequest({ dwarfId: 'd', toolUseId: 't', text: long })).toBeNull()
    const atLimit = 'x'.repeat(MAX_DWARF_TEXT_CHARS)
    expect(parseAnswerRequest({ dwarfId: 'd', toolUseId: 't', text: atLimit })).toEqual({
      dwarfId: 'd',
      toolUseId: 't',
      text: atLimit
    })
  })

  it('refuses a text that is not a string at all', () => {
    expect(parseAnswerRequest({ dwarfId: 'd', toolUseId: 't', text: 42 })).toBeNull()
    expect(parseAnswerRequest({ dwarfId: 'd', toolUseId: 't', text: null })).toBeNull()
  })

  it('takes one malformed record entry down with the whole answer', () => {
    // Unchanged by #481 and stated again because the text form sits beside it: a
    // partly-read answer is one the panel would be answering differently from
    // how the person did.
    expect(
      parseAnswerRequest({ dwarfId: 'd', toolUseId: 't', answers: { 'Which?': 7 } })
    ).toBeNull()
  })

  it('refuses a payload whose address is not a pair of strings', () => {
    expect(parseAnswerRequest({ dwarfId: 42, toolUseId: 't', answers: {} })).toBeNull()
    expect(parseAnswerRequest({ dwarfId: 'd', toolUseId: null, answers: {} })).toBeNull()
    expect(parseAnswerRequest(null)).toBeNull()
    expect(parseAnswerRequest('answer')).toBeNull()
  })

  it('accepts an empty record, which names no option and is refused where the ask is', () => {
    // The boundary refuses a SHAPE and never a choice (its own rule since
    // #125): an answer that chose nothing is a well-formed payload, and
    // questionKeystrokesFor is what tells the person it chose nothing.
    expect(parseAnswerRequest({ dwarfId: 'd', toolUseId: 't', answers: {} })).toEqual({
      dwarfId: 'd',
      toolUseId: 't',
      answers: {}
    })
  })

  /*
   * ADDED for #635 (PO decision 2026-09-28, held free-text answers): a question answered in the
   * person's own words rides in its own record, `ownWords`, beside the label record — the
   * renderer saying so explicitly, so main never reads words out of a label that matched nothing.
   */
  it('carries a record of own words beside the labels, and refuses a malformed one', () => {
    expect(
      parseAnswerRequest({ dwarfId: 'd', toolUseId: 't', answers: {}, ownWords: { 'Q?': 'mine' } })
    ).toEqual({ dwarfId: 'd', toolUseId: 't', answers: {}, ownWords: { 'Q?': 'mine' } })
    expect(
      parseAnswerRequest({ dwarfId: 'd', toolUseId: 't', answers: {}, ownWords: { 'Q?': 3 } })
    ).toBeNull()
    expect(
      parseAnswerRequest({ dwarfId: 'd', toolUseId: 't', answers: {}, ownWords: 'mine' })
    ).toBeNull()
  })

  it('refuses own words beside the picker’s typed form: exactly one of the two forms travels', () => {
    expect(
      parseAnswerRequest({ dwarfId: 'd', toolUseId: 't', text: 'x', ownWords: { 'Q?': 'mine' } })
    ).toBeNull()
  })
})
