import { describe, expect, it } from 'vitest'
import {
  eventIdOf,
  parseRolloutLine,
  rolloutKey
} from '../../../src/host/modules/observation/adapters/codex/parse.ts'
import { readItemEvent } from '../../../src/host/modules/suppliers/adapters/drivers/codex-app-server/items.ts'
import { replyItems, userItems } from './codexItems.mjs'

const THREAD = '0190f6a2-1111-7222-8333-944455556666'
const TURN = '0190f6a2-aaaa-7bbb-8ccc-ddddeeeeffff'

/**
 * The key each path gives one message: the live stream's (`codex:codex:<threadId>:<itemId>`, the driver's 15 §4.4 key
 * over `readItemEvent`) and the rollout's (`rolloutKey` over `eventIdOf` of the written line). Equal keys insert once
 * (INV-60), so the person's line and the reply show once in the chat.
 */
function keysOf(pair) {
  const live = readItemEvent({ threadId: THREAD, turnId: TURN, item: pair.live })
  const text = JSON.stringify({
    timestamp: '2026-10-23T12:00:00.000Z',
    type: 'response_item',
    payload: pair.rollout
  })
  const record = parseRolloutLine(text)
  return {
    live: `codex:codex:${live.threadId}:${live.id}`,
    rollout: rolloutKey('codex', THREAD, eventIdOf(record, text, 0))
  }
}

describe('the Codex demo stub’s two paths for one message', () => {
  it('writes the person’s line to the rollout under the live userMessage item’s id', () => {
    const keys = keysOf(userItems('Rework the shift roster.'))
    expect(keys.rollout).toBe(keys.live)
  })

  it('writes the reply to the rollout under the live agentMessage item’s id', () => {
    const keys = keysOf(replyItems('The roster is reworked.'))
    expect(keys.rollout).toBe(keys.live)
  })

  it('gives each message an id of its own', () => {
    expect(replyItems('One.').live.id).not.toBe(replyItems('Two.').live.id)
    expect(userItems('One.').live.id).not.toBe(replyItems('One.').live.id)
  })
})
