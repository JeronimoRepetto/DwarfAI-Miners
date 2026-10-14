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
