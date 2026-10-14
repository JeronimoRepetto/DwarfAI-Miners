import type { AskRecord, PermissionPayload, QuestionPayload } from '@dwarfai/contracts'
import type { Dwarf, DwarfPermissionRequest, DwarfQuestion } from '../../types'

/*
 * THE ASK THE MESSAGE PANEL DRAWS (ISSUE-138, the read half; 14 §6.4 row `useDwarfQuestion`; ADR-033 item 3).
 *
 * The panel draws its dwarf's front card of the dual-source ask read model, in the card components' own shape (they
 * are transplanted unchanged, EPIC-16):
 * - A Host ask (an `AskRecord`, ADR-010 item 5) keyed by its AskId. Its card channel is `'held'`: the card channel says
 *   where the ask is answered, and a Host ask is answered in the app, through the broker (ADR-010 item 1), whatever its
 *   provider channel; `'held'` also gives "Other thing…" the ordinary-message route ADR-010 item 2 asks for. Each
 *   question step is one question of the card, single-choice, its options by label. An ask with no answer channel
 *   (`channel: 'none'`) draws no card (ADR-010 item 3, ADR-011 item 4).
 * - Else the legacy card, by its `legacy:` id, in today's shape.
 * - Else the board's own asks exactly as the panel drew them before the read model existed: a permission ahead of a
 *   question. That covers a window whose read model is not started and a board whose ids are outside the relay's
 *   namespace, so today's legacy asks draw as they always did.
 */

/** The front card of the dual-source ask read model (`useDwarfQuestion().frontAsk`), as this reads it. */
export type FrontCard =
  | { source: 'host'; ask: AskRecord }
  | { source: 'legacy'; kind: 'permission'; permission: DwarfPermissionRequest }
  | { source: 'legacy'; kind: 'question'; question: DwarfQuestion }

/** The ask card the panel draws, in the card components' own shape; `at` is the step a question opens on. */
export type ShownAsk =
  | { kind: 'permission'; askId: string; permission: DwarfPermissionRequest }
  | { kind: 'question'; askId: string; at: number; question: DwarfQuestion }

export function shownAskOf(
  front: FrontCard | undefined,
  board: Partial<Pick<Dwarf, 'pendingPermission' | 'pendingQuestion'>>
): ShownAsk | null {
  if (front?.source === 'host') return hostAskCard(front.ask)
  if (front?.source === 'legacy') {
    return front.kind === 'permission'
      ? permissionCard(front.permission)
      : questionCard(front.question, 0)
  }
  if (board.pendingPermission !== undefined) return permissionCard(board.pendingPermission)
  if (board.pendingQuestion !== undefined) return questionCard(board.pendingQuestion, 0)
  return null
}

function permissionCard(permission: DwarfPermissionRequest): ShownAsk {
  return { kind: 'permission', askId: permission.toolUseId, permission }
}

function questionCard(question: DwarfQuestion, at: number): ShownAsk {
  return { kind: 'question', askId: question.toolUseId, at, question }
}

function hostAskCard(ask: AskRecord): ShownAsk | null {
  if (ask.channel === 'none') return null
  const askedAt = new Date(ask.openedAt).toISOString()
  if (ask.kind === 'permission' && isPermissionPayload(ask.payload)) {
    return permissionCard({
      toolUseId: ask.id,
      toolName: ask.payload.toolName,
      input: ask.payload.requestText,
      channel: 'held',
      askedAt
    })
  }
  if (ask.kind === 'question' && !isPermissionPayload(ask.payload)) {
    return questionCard(
      {
        toolUseId: ask.id,
        channel: 'held',
        askedAt,
        questions: ask.payload.steps.map((step) => ({
          question: step.text,
          multiSelect: false,
          options: step.options.map((label) => ({ label }))
        }))
      },
      ask.currentStep
    )
  }
  return null
}

function isPermissionPayload(
  payload: QuestionPayload | PermissionPayload
): payload is PermissionPayload {
  return 'toolName' in payload
}
