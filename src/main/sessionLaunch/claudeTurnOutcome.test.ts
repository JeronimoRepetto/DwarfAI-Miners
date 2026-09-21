import { describe, expect, it } from 'vitest'
import { MAX_DWARF_TEXT_CHARS } from '../domain/types'
import { resultTurnOutcome, type ClaudeResultMessage } from './claudeTurnOutcome'

/*
 * Issue #510. `sdkHeldSession.ts` itself has no unit test — its own module
 * comment says so, because no test here may spawn a real Agent SDK query()
 * — so the decision this function makes (what a `result` message's own
 * `subtype` means) lives in its own file instead, the same split
 * `heldCrew.ts` already draws for a task signal: sdkHeldSession.ts
 * recognises the SDK's shapes and forwards them, and the actual reading is
 * proven here with a hand-built fixture rather than the SDK's whole result
 * type.
 */
const NOW = 1_700_000_000_000

describe('resultTurnOutcome', () => {
  it('reads a success result as concluded, with the SDK’s own result string', () => {
    const message: ClaudeResultMessage = { subtype: 'success', result: 'All done.' }
    expect(resultTurnOutcome(message, NOW)).toEqual({
      kind: 'concluded',
      text: 'All done.',
      endedAt: NOW
    })
  })

  it('reads error_max_turns and error_max_budget_usd as capped, never as a failure', () => {
    for (const subtype of ['error_max_turns', 'error_max_budget_usd']) {
      expect(resultTurnOutcome({ subtype }, NOW)).toEqual({
        kind: 'capped',
        detail: subtype,
        endedAt: NOW
      })
    }
  })

  it('reads error_during_execution as errored', () => {
    expect(resultTurnOutcome({ subtype: 'error_during_execution' }, NOW)).toEqual({
      kind: 'errored',
      detail: 'error_during_execution',
      endedAt: NOW
    })
  })

  it('reads any other error subtype as errored too, carrying it verbatim as detail', () => {
    // error_max_structured_output_retries today, and whatever a future SDK
    // adds — see SDKResultError's own union in the installed sdk.d.ts.
    expect(resultTurnOutcome({ subtype: 'error_max_structured_output_retries' }, NOW)).toEqual({
      kind: 'errored',
      detail: 'error_max_structured_output_retries',
      endedAt: NOW
    })
  })

  it('never reads a capped or errored turn as carrying text, since SDKResultError has none', () => {
    // Checked against the installed SDK's own sdk.d.ts: SDKResultError
    // declares no `result` field at all, on any subtype — so `text` staying
    // absent here is not a choice this function makes, it is the shape the
    // SDK itself hands over.
    expect(resultTurnOutcome({ subtype: 'error_max_turns' }, NOW).text).toBeUndefined()
  })

  it('bounds a long result to the wire’s ordinary ceiling, and marks it truncated', () => {
    const long = 'x'.repeat(MAX_DWARF_TEXT_CHARS + 10)
    const outcome = resultTurnOutcome({ subtype: 'success', result: long }, NOW)
    expect(outcome.text).toHaveLength(MAX_DWARF_TEXT_CHARS)
    expect(outcome.truncated).toBe(true)
  })

  it('omits truncated for a result well within the ceiling', () => {
    const outcome = resultTurnOutcome({ subtype: 'success', result: 'short' }, NOW)
    expect('truncated' in outcome).toBe(false)
  })
})
