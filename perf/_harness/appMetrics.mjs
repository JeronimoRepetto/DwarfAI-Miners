/**
 * One CPU sample from Electron's `app.getAppMetrics()` (ISSUE-297; `17` §1.11): each `ProcessMetric`'s
 * `cpu.percentCPUUsage` is that process's CPU since the previous call, as a percentage of one core, on every OS.
 *
 * - `renderer` is the measured window's own process, found by its OS process id (`webContents.getOSProcessId()`).
 * - `app` is the sum over every process the metrics list: the browser (Electron main), the GPU and utility processes
 *   and every renderer, hidden ones included. The DwarfAI Host is its own detached process (ADR-002 D1), outside
 *   Electron's metrics, so it is not in this sum.
 *
 * A renderer missing from the metrics throws: a zero would be recorded as evidence of an idle window that was never
 * measured.
 */
export function rendererAndAppCpu(metrics, rendererPid) {
  const renderer = metrics.find((metric) => metric.pid === rendererPid)
  if (renderer === undefined) {
    throw new Error(`the measured renderer (pid ${rendererPid}) is not in the app metrics`)
  }
  const app = metrics.reduce((sum, metric) => sum + metric.cpu.percentCPUUsage, 0)
  return { renderer: renderer.cpu.percentCPUUsage, app }
}
