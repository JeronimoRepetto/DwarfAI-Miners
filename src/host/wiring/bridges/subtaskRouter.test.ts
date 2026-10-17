// layer: L2
// L2 (17 §1.2): the `SubtaskRouter` bridge (16 §4.8 row `SubtaskRouter`, §6.4 subtask column;
// ADR-028 D2) over a recording `JevAdvisor` written inline (R15: the jev module's own doubles stay
// inside it).
import { describe, expect, it } from 'vitest'
import type { Result } from '../../kernel/domain/values'
import type { JevAdvisor, JevSuggestionView } from '../../modules/jev'
import { createSubtaskRouter } from './subtaskRouter'

type Answer = Result<
  JevSuggestionView,
  'jev-unreachable' | 'jev-could-not-choose' | 'not-configured'
>

const PICK: JevSuggestionView = {
  providerId: 'claude' as JevSuggestionView['providerId'],
  model: 'sonnet',
  effort: 'medium',
  confidence: { providerId: 0.9 },
  truncated: false,
  parts: { providerId: 'answered', model: 'answered', effort: 'answered' }
}

function advisor(answer: Answer) {
  const requests: Parameters<JevAdvisor['suggest']>[0][] = []
  const jev: JevAdvisor = {
    suggest(req) {
      requests.push(req)
      return Promise.resolve(answer)
    }
  }
  return { jev, requests }
}

function fellBack(reason: NonNullable<JevSuggestionView['fallback']>): JevSuggestionView {
  return { confidence: {}, truncated: false, parts: {}, fallback: reason }
}

describe('SubtaskRouter bridge (16 §4.8, §6.4)', () => {
  it("[S8.03, INV-88] a subtask is asked of Jev with purpose subtask, its task as the prompt and its context apart, and Jev's pick is answered as given", async () => {
    const { jev, requests } = advisor({ ok: true, value: PICK })
    const router = createSubtaskRouter({ jev })

    const answer = await router.route('Map the old shafts', 'The seam floods.')
    const bare = await router.route('Map the old shafts')

    expect(answer).toStrictEqual({ ok: true, value: PICK })
    expect(bare).toStrictEqual({ ok: true, value: PICK })
    expect(requests).toStrictEqual([
      { purpose: 'subtask', prompt: 'Map the old shafts', context: 'The seam floods.' },
      { purpose: 'subtask', prompt: 'Map the old shafts' }
    ])
  })

  it('[S8.04] jev-unreachable is answered as jev-unreachable', async () => {
    const router = createSubtaskRouter(advisor({ ok: false, error: 'jev-unreachable' }))

    expect(await router.route('task')).toStrictEqual({ ok: false, error: 'jev-unreachable' })
  })

  it('[S8.05] not-configured and jev-could-not-choose are answered as jev-could-not-choose', async () => {
    for (const error of ['not-configured', 'jev-could-not-choose'] as const) {
      const router = createSubtaskRouter(advisor({ ok: false, error }))

      expect(await router.route('task')).toStrictEqual({
        ok: false,
        error: 'jev-could-not-choose'
      })
    }
  })

  it('[S8.05, US-DLG-005.AC05, INV-86] a fallback suggestion is never a subtask pick: effort-ceiling fails as jev-could-not-choose', async () => {
    const cases = [
      ['effort-ceiling', 'jev-could-not-choose'],
      ['low-confidence', 'jev-could-not-choose'],
      ['no-launchable-provider', 'jev-could-not-choose'],
      ['timeout', 'jev-unreachable'],
      ['invalid-response', 'jev-unreachable']
    ] as const
    for (const [reason, error] of cases) {
      const router = createSubtaskRouter(advisor({ ok: true, value: fellBack(reason) }))

      expect(await router.route('task')).toStrictEqual({ ok: false, error })
    }
  })
})
