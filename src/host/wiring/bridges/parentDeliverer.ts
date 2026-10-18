// The `ParentDeliverer` bridge (16 §4.8 rows `ParentDeliverer` and the bridges row; ADR-013 item 6;
// 11 F6 step 7; UC-017 "Turn-input handoff"; ISSUE-205): delegation → conversation
// `deliverInvisibly`, for the turn-input handoff only (a driver that needs the result pushed). The
// text arrives marked by delegation (the marker names the delegation, 18 T-25) and goes through
// unchanged; the answer comes back as given and delegation records it on `Delegation.handoff`.
// One push per call, never retried (ADR-013 O-13b): a push that throws is `failed`. Nothing here
// logs or keeps the text (NFR-SEC-12).
import type { ConversationDeliverCommand } from '../../modules/conversation'
import type { ParentDeliverer } from '../../modules/delegation'

export interface ParentDelivererDeps {
  /** Conversation's `deliverInvisibly`, built with its send routes (`Conversation.sending`). */
  conversation: Pick<ConversationDeliverCommand, 'deliverInvisibly'>
}

export function createParentDeliverer(deps: ParentDelivererDeps): ParentDeliverer {
  return {
    async deliver(parent, text) {
      try {
        return await deps.conversation.deliverInvisibly(parent, text)
      } catch {
        return { ok: false, error: 'failed' }
      }
    }
  }
}
