// layer: L2
// The LaunchAdvisor double passes the same contract as the real bridge (16 §2.8; 17 §1.3).
import { describe, expect, it } from 'vitest'
import type { MineId } from '../../../kernel/domain/values'
import { FakeLaunchAdvisor } from './FakeLaunchAdvisor'
import { runLaunchAdvisorContract } from './launchAdvisor.contract'

runLaunchAdvisorContract('FakeLaunchAdvisor', () => {
  const advisor = new FakeLaunchAdvisor()
  return {
    advisor,
    arrange: (scenario) => {
      switch (scenario.kind) {
        case 'picked':
          advisor.arrange({ ...scenario, kind: 'pick' })
          return
        case 'effort-ceiling':
          advisor.arrange({
            kind: 'fallback',
            reason: 'effort-ceiling',
            ...(scenario.default === undefined ? {} : { default: scenario.default })
          })
          return
        case 'not-configured':
          advisor.arrange({ kind: 'fallback', reason: 'no-key' })
          return
        case 'error':
          advisor.arrange(scenario)
      }
    }
  }
})

describe('FakeLaunchAdvisor', () => {
  const MINE = '00000000-0000-7000-8000-0000000164a2' as MineId

  it('[S5.14] a hanging call answers the timeout fallback once its signal aborts', async () => {
    const advisor = new FakeLaunchAdvisor()
    advisor.arrange({ kind: 'hang' })
    const controller = new AbortController()
    const pending = advisor.suggest('Dig', MINE, { signal: controller.signal })
    controller.abort()
    expect(await pending).toMatchObject({ ok: true, value: { fallback: 'timeout' } })
    expect(advisor.calls).toEqual([{ prompt: 'Dig', mineId: MINE, signal: controller.signal }])
  })

  it('[S5.10] a call with no script is a test defect', async () => {
    await expect(new FakeLaunchAdvisor().suggest('Dig', MINE)).rejects.toThrow(/no script/)
  })
})
