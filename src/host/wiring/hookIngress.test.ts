// layer: L1
// L1 (17 §1.1): boot step 6's hook-ingress half (wiring/hookIngress.ts; 16 §8.2; 13 FM-038). A
// listener that cannot be bound is logged and never fails the boot: the Host never exits on its
// own (ADR-002 D1, D7), and observation keeps seeing changes by polling. The real listener is
// flows/hookIngress.os.test.ts's (L8).
import { describe, expect, it } from 'vitest'
import { RecordingDiagnosticsLog } from '../kernel/fakes/RecordingDiagnosticsLog'
import { startHookIngressAtBoot } from './hookIngress'

describe('startHookIngressAtBoot', () => {
  it('[FM-038, ADR-016] a hook ingress that cannot bind is logged as ingress.port failed and the step goes on', async () => {
    const log = new RecordingDiagnosticsLog()
    const failing = {
      start: () => Promise.reject(new Error('the ingress port could not be bound /home/j'))
    }

    await expect(startHookIngressAtBoot(failing, log)).resolves.toBeUndefined()

    expect(log.byEvent('ingress.port')).toEqual([
      expect.objectContaining({ level: 'warn', subsystem: 'transport', outcome: 'failed' })
    ])
    expect(JSON.stringify(log.byEvent('ingress.port'))).not.toContain('/home/j')
  })

  it('[ADR-016] a hook ingress that binds logs nothing of its own', async () => {
    const log = new RecordingDiagnosticsLog()

    await startHookIngressAtBoot({ start: () => Promise.resolve(41_234) }, log)

    expect(log.byEvent('ingress.port')).toEqual([])
  })
})

describe("boot step 6 and the Host's own Claude hook entry (07 S14.10)", () => {
  it("[S14.10, ADR-016] once the ingress is bound, the Host's own hook entry follows the bound port before the step ends", async () => {
    const order: string[] = []
    const ingress = {
      start: () => {
        order.push('bound')
        return Promise.resolve(41_235)
      }
    }

    await startHookIngressAtBoot(ingress, new RecordingDiagnosticsLog(), () => {
      order.push('followed')
      return Promise.resolve()
    })

    expect(order).toStrictEqual(['bound', 'followed'])
  })

  it('[S14.10, FM-038] an ingress that cannot bind has no port for the entry to follow: nothing is rewritten', async () => {
    const followed: string[] = []

    await startHookIngressAtBoot(
      { start: () => Promise.reject(new Error('no port')) },
      new RecordingDiagnosticsLog(),
      () => {
        followed.push('followed')
        return Promise.resolve()
      }
    )

    expect(followed).toStrictEqual([])
  })

  it('[S14.10, ADR-002] a rewrite that throws is logged as config.write failed, never with its text, and the step goes on', async () => {
    const log = new RecordingDiagnosticsLog()

    await expect(
      startHookIngressAtBoot({ start: () => Promise.resolve(41_235) }, log, () =>
        Promise.reject(new Error('settings.json at /home/j could not be read'))
      )
    ).resolves.toBeUndefined()

    expect(log.byEvent('config.write')).toEqual([
      expect.objectContaining({ level: 'warn', subsystem: 'claude-hooks', outcome: 'failed' })
    ])
    expect(JSON.stringify(log.entries)).not.toContain('/home/j')
  })
})
