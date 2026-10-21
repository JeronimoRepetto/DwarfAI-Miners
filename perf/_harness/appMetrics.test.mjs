// layer: L7
import { describe, expect, it } from 'vitest'
import { rendererAndAppCpu } from './appMetrics.mjs'

/**
 * L7 check of how a perf case reads one CPU sample from Electron's `app.getAppMetrics()` (ISSUE-297; `17` §1.11):
 * the renderer it measures, by its OS process id, and the whole app, every process the metrics list.
 */

/** One `ProcessMetric` as Electron reports it, reduced to what the sample reads. */
const metric = (pid, type, percentCPUUsage) => ({ pid, type, cpu: { percentCPUUsage } })

describe('a CPU sample from the app metrics (17 §1.11)', () => {
  it('[NFR-PERF-04, NFR-OBS-03] the sample is the measured renderer’s CPU and the sum over every process of the app', () => {
    const metrics = [
      metric(100, 'Browser', 1.25),
      metric(101, 'GPU', 0.5),
      metric(102, 'Tab', 0.75),
      metric(103, 'Tab', 0.25),
      metric(104, 'Utility', 0)
    ]

    expect(rendererAndAppCpu(metrics, 103)).toEqual({ renderer: 0.25, app: 2.75 })
  })

  it('[NFR-OBS-03] a renderer missing from the metrics fails the sample rather than recording a zero', () => {
    expect(() => rendererAndAppCpu([metric(100, 'Browser', 1)], 103)).toThrow(
      'the measured renderer (pid 103) is not in the app metrics'
    )
  })
})
