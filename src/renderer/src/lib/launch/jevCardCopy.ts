/*
 * The Add panel's Jev card (#635, MESSAGE-QUESTIONS 15; decision log, Jev card from the decision):
 * the eyebrow, the one paragraph naming Jev's pick, and the tooltip behind it. Every word comes
 * from what a Jev decision carries (JevRouteLaunchResult) — it has no reason and no fallback
 * supplier, so neither is said. The sentences are the ones the #509 card spoke, moved here from
 * AddPanel.vue whole; the card only draws them.
 */
import type { JevModelFallbackReason, JevRouteModelPart, ModelTier } from '../../types'
import type { JevDecision } from './launchState'

/** The eyebrow over the pick: the design's words, auto-accept deciding which (copy.md). */
export function jevCardEyebrow(autoAccept: boolean): string {
  return autoAccept ? 'JEV · ACCEPTED AUTOMATICALLY' : 'JEV SUGGESTS'
}

/**
 * Jev's pick as the paragraph names it, "<Supplier> · <model> · <effort>", leaving out a part the
 * decision lacks rather than drawing a placeholder for it. The full stop after it is the card's,
 * outside the bold.
 */
export function jevPickText(pick: {
  supplier: string
  model: string | null
  effort?: string
}): string {
  const parts = [pick.supplier]
  if (pick.model !== null) parts.push(pick.model)
  if (pick.effort !== undefined) parts.push(pick.effort)
  return parts.join(' · ')
}

/**
 * The tier in words (jev-routing-profiles T4) — `ModelTier`'s own kebab-case wire values are
 * never shown as-is. `'special-purpose'` is exhaustive against the type only: a routing decision
 * never lands on it (see `ModelTier`'s own comment in contracts.ts).
 */
const TIER_LABELS: Record<ModelTier, string> = {
  'fast-cheap': 'fast & cheap',
  balanced: 'balanced',
  frontier: 'frontier',
  'long-context': 'long context',
  'special-purpose': 'special purpose'
}

/**
 * Fixed English words for every way the model step's own second request (#608) fell back to the
 * local cost/profile choice instead of a winner — exhaustive over the union on purpose, so a
 * reason added to the wire fails typecheck here rather than rendering silently as nothing. The
 * first nine are the Jev fallback reasons' wording, mid-sentence; `'no-live-model'` predates
 * #608: no launchable, catalogued model existed at any tier step, so there was never a candidate.
 */
const MODEL_FALLBACK_REASONS: Record<JevModelFallbackReason, string> = {
  'no-key': 'no TypeSafe key is set',
  'no-launchable-provider': 'no launchable provider to choose from',
  unreachable: 'Jev could not be reached',
  timeout: 'Jev took too long',
  'rate-limited': 'Jev is rate-limited right now',
  unauthorized: 'TypeSafe rejected the API key',
  'low-confidence': 'Jev was not confident enough',
  'invalid-response': "Jev's answer could not be used",
  'budget-exceeded': "the prompt and catalogue do not fit Jev's request budget",
  'no-live-model': 'no live model exists for this provider and tier'
}

/**
 * The model step's own sentence (#608) — apart from the chosen/unsure lists on purpose, because
 * `'only-candidate'` is neither Jev's pick nor a safe default (it was the only option), so it
 * needs a third shape rather than being forced into "chose" or "unsure about".
 */
function modelSentence(model: JevRouteModelPart): string {
  if (model.applied === 'answered') {
    // `probability` is always present when answered (contracts.ts); `?? 0` is belt-and-braces
    // for a state the wire's own type rules out, never a stand-in for "no answer" (#608).
    const fit = Math.round((model.probability ?? 0) * 100)
    let sentence = `Jev picked the model (${fit}% fit).`
    if (model.choiceProbability !== undefined) {
      sentence += ` Tie broken by Jev's ranking (${Math.round(model.choiceProbability * 100)}%).`
    }
    return sentence
  }
  if (model.applied === 'only-candidate') {
    return 'Only one model fits that tier, so no second question was asked.'
  }
  const reason =
    model.reason === undefined ? 'an unknown reason' : MODEL_FALLBACK_REASONS[model.reason]
  return `Jev could not pick the model (${reason}); the closest local choice was used.`
}

/**
 * Which parts Jev itself answered, and which fell to a safe value instead (jev-routing-profiles
 * T4), then how the model was picked. Confidence is always Jev's own raw number, even for a part
 * that fell back, so the line can say how close it was. Whether a safe value was the person's
 * configured default or the cheapest launchable provider is not on the wire (`applied` only says
 * 'safe-default'), so this says "the safe value" rather than guessing "your default".
 */
function partsSentence(decision: JevDecision, supplier: string): string {
  const tierPct = Math.round(decision.parts.tier.confidence * 100)
  const providerPct = Math.round(decision.parts.provider.confidence * 100)
  const tier = TIER_LABELS[decision.tier]

  const chosen: string[] = []
  if (decision.parts.tier.applied === 'answered') chosen.push(`the ${tier} tier (${tierPct}% sure)`)
  if (decision.parts.provider.applied === 'answered') {
    chosen.push(`${supplier} (${providerPct}% sure)`)
  }

  const unsureNames: string[] = []
  const unsureValues: string[] = []
  if (decision.parts.tier.applied === 'safe-default') {
    unsureNames.push(`the tier (${tierPct}%)`)
    unsureValues.push(tier)
  }
  if (decision.parts.provider.applied === 'safe-default') {
    unsureNames.push(`the provider (${providerPct}%)`)
    unsureValues.push(supplier)
  }

  const sentences: string[] = []
  if (chosen.length > 0) sentences.push(`Jev chose ${chosen.join(' and ')}.`)
  if (unsureNames.length > 0) {
    const plural = unsureValues.length > 1
    sentences.push(
      `Jev was unsure about ${unsureNames.join(' and ')}; the safe value${plural ? 's' : ''} ${unsureValues.join(' and ')} ${plural ? 'were' : 'was'} used.`
    )
  }
  sentences.push(modelSentence(decision.parts.model))
  return sentences.join(' ')
}

/**
 * The pick's tooltip, one sentence per line, in the design's order: the parts, Jev's least
 * certain answer when a part was answered, then each flag the decision carries. `confidence` is
 * `undefined` (never `0`) when nothing was answered (#608), and then there is no figure to give.
 * The parts line is always there, so the tooltip always has something to add.
 */
export function jevCardTip(decision: JevDecision, supplier: string): string[] {
  const lines = [partsSentence(decision, supplier)]
  if (decision.confidence !== undefined) {
    lines.push(`Jev's least certain answer was ${Math.round(decision.confidence * 100)}%.`)
  }
  if (decision.parts.trivial.value) lines.push('Treated as a trivial prompt.')
  if (decision.parts.largeContext.value) lines.push('Large-context model preferred.')
  if (decision.truncated)
    lines.push('The prompt sent to Jev was trimmed to fit its request budget.')
  return lines
}
