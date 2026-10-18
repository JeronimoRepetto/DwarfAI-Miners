// `runLaunchAdvisorContract` (16 §4.5 `LaunchAdvisor`, §2.8; 17 §1.3): the one suite the double
// (`FakeLaunchAdvisor`) and the real bridge → jev (later: ISSUE-182) both pass, so a launch test
// that composes the double proves what the bridge does. The subject arranges what Jev did, in jev's
// own terms; the suite checks what launching reads (16 §4.5, §6.4): a pick names its provider and
// no fallback; `effort-ceiling` is never an error (ADR-028 D2, OQ-38 B) and carries the configured
// default when there is one; `not-configured` arrives as the `no-key` fallback (16 §13 O-16-06);
// the errors are the two Jev causes only. Never imported by production code (R14).
import { describe, expect, it } from 'vitest'
import type { MineId, ProviderId } from '../../../kernel/domain/values'
import type { AbortableLaunchAdvisor } from '../ports/launchAdvisor'

/** What Jev did for the next `suggest`, as the subject arranges it. */
export type LaunchAdviceScenario =
  | { kind: 'picked'; providerId: ProviderId; model?: string; effort?: string }
  | { kind: 'effort-ceiling'; default?: { providerId: ProviderId; model?: string } }
  | { kind: 'not-configured' } // JevAdvisor's `not-configured`: no Jev key stored
  | { kind: 'error'; error: 'jev-unreachable' | 'jev-could-not-choose' }

export interface LaunchAdvisorSubject {
  advisor: AbortableLaunchAdvisor
  arrange(scenario: LaunchAdviceScenario): void
}

const MINE = '00000000-0000-7000-8000-0000000164a1' as MineId
const PROVIDER = 'contract' as ProviderId
const PROMPT = 'Shore up the east gallery'

export function runLaunchAdvisorContract(
  name: string,
  makeSubject: () => LaunchAdvisorSubject
): void {
  describe(`LaunchAdvisor contract: ${name}`, () => {
    it('[S5.12] a pick answers the provider, model and effort with no fallback', async () => {
      const subject = makeSubject()
      subject.arrange({ kind: 'picked', providerId: PROVIDER, model: 'm-1', effort: 'low' })
      const result = await subject.advisor.suggest(PROMPT, MINE)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).toMatchObject({ providerId: PROVIDER, model: 'm-1', effort: 'low' })
      expect(result.value.fallback).toBeUndefined()
    })

    it('[S5.13, ADR-028] an effort-ceiling fallback is never an error and carries the configured default', async () => {
      const subject = makeSubject()
      subject.arrange({ kind: 'effort-ceiling', default: { providerId: PROVIDER, model: 'm-1' } })
      const result = await subject.advisor.suggest(PROMPT, MINE)
      expect(result).toMatchObject({
        ok: true,
        value: { fallback: 'effort-ceiling', providerId: PROVIDER, model: 'm-1' }
      })
    })

    it('[S5.15, ADR-028] an effort-ceiling fallback with no configured default names no provider', async () => {
      const subject = makeSubject()
      subject.arrange({ kind: 'effort-ceiling' })
      const result = await subject.advisor.suggest(PROMPT, MINE)
      expect(result).toMatchObject({ ok: true, value: { fallback: 'effort-ceiling' } })
      if (result.ok) expect(result.value.providerId).toBeUndefined()
    })

    it('[ADR-020] no Jev key stored arrives as the no-key fallback', async () => {
      const subject = makeSubject()
      subject.arrange({ kind: 'not-configured' })
      const result = await subject.advisor.suggest(PROMPT, MINE)
      expect(result).toMatchObject({ ok: true, value: { fallback: 'no-key' } })
      if (result.ok) expect(result.value.providerId).toBeUndefined()
    })

    it('[S5.14, S5.15] the errors are the two Jev launch causes', async () => {
      for (const error of ['jev-unreachable', 'jev-could-not-choose'] as const) {
        const subject = makeSubject()
        subject.arrange({ kind: 'error', error })
        expect(await subject.advisor.suggest(PROMPT, MINE)).toEqual({ ok: false, error })
      }
    })
  })
}
