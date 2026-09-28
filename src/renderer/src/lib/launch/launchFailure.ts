/*
 * The Add panel's launch-failure notice (#635), `organisms/add-panel` in the design: what each of
 * the five causes says, and which way out it offers (decision log, Five launch-failure causes, Jev
 * cause of a failed launch, Stopped at once on a held session; MESSAGE-QUESTIONS 14, 16 and 17).
 * Which cause a failure is belongs to the launch model (launchState, `LaunchFailure`).
 */
import { providerLabel } from '../dwarf/dwarfTip'
import { OTHER_CHOICE, type LaunchChoice, type LaunchFailure } from './launchState'
import type { JevFallbackReason } from '../../types'

/*
 * The app's own words for each fallback reason (#509), which the Jev fallback line has always
 * said and "Jev could not choose" opens with. Display text only: the wire carries the reason.
 */
const JEV_FALLBACK_REASONS: Record<JevFallbackReason, string> = {
  'no-key': 'No TypeSafe key is set',
  'no-launchable-provider': 'No launchable provider to choose from',
  unreachable: 'Jev could not be reached',
  timeout: 'Jev took too long',
  'rate-limited': 'Jev is rate-limited right now',
  unauthorized: 'TypeSafe rejected the API key',
  'low-confidence': 'Jev was not confident enough',
  'invalid-response': "Jev's answer could not be used",
  'budget-exceeded': "The prompt and catalogue do not fit Jev's request budget"
}

/** A reason in those words, low confidence with its figure when the answer carried one. */
export function jevFallbackReasonWords(reason: JevFallbackReason, confidence?: number): string {
  const words = JEV_FALLBACK_REASONS[reason]
  return reason === 'low-confidence' && confidence !== undefined
    ? `${words} (${Math.round(confidence * 100)}%)`
    : words
}

export interface LaunchFailureNotice {
  /** The cause, said as what happened. */
  title: string
  /** What to do about it. */
  text: string
  /** Every cause a retry can change; not "Jev could not choose". */
  retry: boolean
  /** The two Jev causes, unless there is no launchable provider to pick from. */
  pickManually: boolean
}

/*
 * Who failed, as the notice names it (screens/launch.md): the chip's own label — which with Jev on
 * is Jev's pick, since the pick is what the chips hold — "The custom command" for Other…, and
 * "The supplier" when no supplier was chosen at all.
 */
function supplierName(choice: LaunchChoice | null): string {
  if (choice === null) return 'The supplier'
  return choice === OTHER_CHOICE ? 'The custom command' : providerLabel(choice)
}

const PICK_YOURSELF = 'Pick the supplier and model yourself.'

/** What the notice says for a failure, and which of its actions it offers (copy.md, Add a dwarf). */
export function launchFailureNotice(failure: LaunchFailure): LaunchFailureNotice {
  switch (failure.cause) {
    case 'not-installed':
      return {
        title: `${supplierName(failure.choice)} is not installed`,
        text: 'Its command-line tool was not found on this computer. Install it, then retry.',
        retry: true,
        pickManually: false
      }
    case 'exited-at-once':
      return {
        title: `${supplierName(failure.choice)} stopped as soon as it started`,
        text: 'The command ran and exited at once. Run it once in a terminal to see why, then retry.',
        retry: true,
        pickManually: false
      }
    case 'could-not-start':
      return {
        title: `${supplierName(failure.choice)} could not be started`,
        text: 'Its command was found but would not start. Run it once in a terminal to see why, then retry.',
        retry: true,
        pickManually: false
      }
    case 'jev-unreachable':
      return {
        title: 'Jev could not be reached',
        text: 'Retry, or pick the supplier and model yourself.',
        retry: true,
        pickManually: true
      }
    case 'jev-could-not-choose': {
      // With no launchable provider there is nothing to pick, so the reason stands alone and the
      // notice offers nothing (design lead copy fix, 2026-09-28).
      const nothingToPick = failure.reason === 'no-launchable-provider'
      const reason = jevFallbackReasonWords(failure.reason, failure.confidence)
      return {
        title: 'Jev could not choose',
        text: nothingToPick ? `${reason}.` : `${reason}. ${PICK_YOURSELF}`,
        retry: false,
        pickManually: !nothingToPick
      }
    }
  }
}
