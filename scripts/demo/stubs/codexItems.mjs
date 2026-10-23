import { randomUUID } from 'node:crypto'

/**
 * One message of a Codex turn as both paths carry it, under ONE id, as real Codex writes it: the live app-server item
 * (`item/started`, `item/completed`) and the rollout's `response_item`. The Host keys both `codex:codex:<threadId>:<id>`
 * (the driver's 15 §4.4 key; `observation/adapters/codex/parse.ts` `rolloutKey` over `eventIdOf`), so the message is
 * stored once (INV-60) and shows once in the chat. `codexItems.test.mjs` checks it with the Host's own readers.
 */

/** The person's line: the live `userMessage` item and its rollout line. */
export function userItems(text) {
  const id = randomUUID()
  return {
    live: {
      type: 'userMessage',
      id,
      clientId: null,
      content: [{ type: 'text', text, text_elements: [] }]
    },
    rollout: { type: 'message', id, role: 'user', content: [{ type: 'input_text', text }] }
  }
}

/** The reply: the live `agentMessage` item and its rollout line. */
export function replyItems(reply) {
  const id = randomUUID()
  return {
    live: {
      type: 'agentMessage',
      id,
      text: reply,
      phase: 'final_answer',
      memoryCitation: null,
      delivery: null,
      questions: null
    },
    rollout: {
      type: 'message',
      id,
      role: 'assistant',
      content: [{ type: 'output_text', text: reply }],
      phase: 'final_answer'
    }
  }
}
