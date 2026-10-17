// layer: L2
// The `LaunchAdvisor` bridge (05 §4; 16 §4.5, §6.4, O-16-06; ADR-020 item 2; ISSUE-182): a normal
// "Let Jev choose" launch asks jev's `JevAdvisor.suggest` with `purpose: 'launch'`, passing the
// launch's abort signal (16 §6.5). Jev's answer comes back unchanged, except `not-configured`,
// which is reported as the `no-key` fallback so the launch can name it (S5.15). Doubles only.
import { describe, expect, it } from 'vitest'
import type { MineId, ProviderId } from '../../kernel/domain/values'
import type { AbortableJevAdvisor, JevSuggestionView } from '../../modules/jev'
import { createLaunchAdvisor } from './launchAdvisor'

const MINE = '00000000-0000-7000-8000-0000000182f1' as MineId

const PICK: JevSuggestionView = {
  providerId: 'claude' as ProviderId,
  model: 'opus',
  confidence: {},
  truncated: false,
  parts: {}
}

function jev(answer: Awaited<ReturnType<AbortableJevAdvisor['suggest']>>) {
  const asked: unknown[] = []
  const advisor: AbortableJevAdvisor = {
    suggest: async (req, opts) => {
      asked.push({ req, signal: opts?.signal })
      return answer
    }
  }
  return { advisor, asked }
}

describe('LaunchAdvisor bridge', () => {
  it('[ADR-028] a launch asks Jev with purpose launch and the launch abort signal, and gets its pick unchanged', async () => {
    const { advisor, asked } = jev({ ok: true, value: PICK })
    const signal = new AbortController().signal

    const answer = await createLaunchAdvisor({ advisor }).suggest('Survey the seam', MINE, {
      signal
    })

    expect(answer).toEqual({ ok: true, value: PICK })
    expect(asked).toEqual([{ req: { prompt: 'Survey the seam', purpose: 'launch' }, signal }])
  })

  it('[ADR-020, S5.15] a not-configured Jev is reported as the no-key fallback, with no provider', async () => {
    const { advisor } = jev({ ok: false, error: 'not-configured' })

    const answer = await createLaunchAdvisor({ advisor }).suggest('Survey the seam', MINE)

    expect(answer.ok).toBe(true)
    expect(answer.ok && answer.value.fallback).toBe('no-key')
    expect(answer.ok && answer.value.providerId).toBeUndefined()
  })

  it('[ADR-020, S5.14] the two Jev launch causes come back as the advisor errors they are', async () => {
    for (const error of ['jev-unreachable', 'jev-could-not-choose'] as const) {
      const { advisor } = jev({ ok: false, error })
      expect(await createLaunchAdvisor({ advisor }).suggest('Survey', MINE)).toEqual({
        ok: false,
        error
      })
    }
  })
})
