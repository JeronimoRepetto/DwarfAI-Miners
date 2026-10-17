// The LaunchAdvisor double (16 §4.5 `FakeLaunchAdvisor`; 16 §2.8): scripted picks and fallbacks,
// one per `suggest`, in call order. It runs `runLaunchAdvisorContract` like the real bridge
// (later: ISSUE-182). Each call is recorded with its prompt, mine and signal; a call with no script
// is a test defect and rejects. A `hang` script never answers until its signal aborts, when it
// answers the `timeout` fallback as the router does (16 §6.5). Never imported by production code (R14).
import type { JevFallbackReason } from '../../../kernel/domain/sharedContracts'
import type { MineId, ProviderId, Result } from '../../../kernel/domain/values'
import type { JevSuggestionView } from '../../jev'
import type { AbortableLaunchAdvisor, LaunchAdviceOptions } from '../ports/launchAdvisor'

type Answer = Result<JevSuggestionView, 'jev-unreachable' | 'jev-could-not-choose'>

/** What the next `suggest` meets. */
export type LaunchAdviceScript =
  | { kind: 'pick'; providerId: ProviderId; model?: string; effort?: string }
  | {
      kind: 'fallback'
      reason: JevFallbackReason
      /** The configured default the fallback suggestion carries (`effort-ceiling`, OQ-38 B). */
      default?: { providerId: ProviderId; model?: string; effort?: string }
    }
  | { kind: 'error'; error: 'jev-unreachable' | 'jev-could-not-choose' }
  | { kind: 'hang' }

export interface RecordedAdvice {
  prompt: string
  mineId: MineId
  signal: AbortSignal | undefined
}

function answered(parts: {
  providerId: ProviderId
  model?: string
  effort?: string
}): JevSuggestionView {
  return {
    providerId: parts.providerId,
    ...(parts.model === undefined ? {} : { model: parts.model }),
    ...(parts.effort === undefined ? {} : { effort: parts.effort }),
    confidence: {},
    truncated: false,
    parts: {
      providerId: 'answered',
      ...(parts.model === undefined ? {} : { model: 'answered' }),
      ...(parts.effort === undefined ? {} : { effort: 'answered' })
    }
  }
}

function fellBack(
  reason: JevFallbackReason,
  fallbackDefault?: { providerId: ProviderId; model?: string; effort?: string }
): JevSuggestionView {
  if (fallbackDefault === undefined) {
    return { confidence: {}, truncated: false, parts: {}, fallback: reason }
  }
  const view = answered(fallbackDefault)
  return {
    ...view,
    parts: {
      providerId: 'safe-default',
      ...(view.model === undefined ? {} : { model: 'safe-default' }),
      ...(view.effort === undefined ? {} : { effort: 'safe-default' })
    },
    fallback: reason
  }
}

export class FakeLaunchAdvisor implements AbortableLaunchAdvisor {
  /** Every call, in call order. */
  readonly calls: RecordedAdvice[] = []
  private readonly scripts: LaunchAdviceScript[] = []

  /** What the next unscripted `suggest` meets. */
  arrange(script: LaunchAdviceScript): void {
    this.scripts.push(script)
  }

  suggest(prompt: string, mineId: MineId, opts?: LaunchAdviceOptions): Promise<Answer> {
    this.calls.push({ prompt, mineId, signal: opts?.signal })
    const script = this.scripts.shift()
    if (script === undefined) {
      return Promise.reject(new Error('FakeLaunchAdvisor: suggest was called with no script'))
    }
    switch (script.kind) {
      case 'pick':
        return Promise.resolve({ ok: true, value: answered(script) })
      case 'fallback':
        return Promise.resolve({ ok: true, value: fellBack(script.reason, script.default) })
      case 'error':
        return Promise.resolve({ ok: false, error: script.error })
      case 'hang':
        return new Promise((resolve) => {
          opts?.signal?.addEventListener(
            'abort',
            () => resolve({ ok: true, value: fellBack('timeout') }),
            { once: true }
          )
        })
    }
  }
}
