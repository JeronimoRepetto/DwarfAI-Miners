// Spike S-019-1 (ADR-019 item 1; spike register S-019-1): the minimal `contextBridge` facade a sandboxed renderer
// gets when the found tree's preload does not load under `sandbox: true`. `sandboxedPreload.e2e.ts` compiles this file
// to CommonJS at test time (a sandboxed preload runs as a plain script: no ES modules, and `require` reaches only
// `electron` and a few Node polyfills) and loads it into a test window. It exposes exactly what the question needs:
// one `ipcRenderer.invoke` round trip, the path of a dropped `File` through `webUtils.getPathForFile`, and whether the
// renderer really is sandboxed. The generated facade is later: ISSUE-045.

import { contextBridge, ipcRenderer, webUtils } from 'electron'

/** The channel the test registers in the main process for the round trip. */
const PING_CHANNEL = 's0191:ping'

contextBridge.exposeInMainWorld('spike', {
  /** Whether this renderer runs sandboxed, as Electron reports it to the preload. */
  sandboxed: process.sandboxed === true,
  /** Whether the preload could reach Node's full `require` (it must not under the sandbox). */
  fullNodeRequire: (() => {
    try {
      // The probe is the CommonJS `require` itself: a sandboxed preload's one only reaches `electron` and polyfills.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return typeof require('node:fs').readFileSync === 'function'
    } catch {
      return false
    }
  })(),
  ping: (value: string): Promise<string> => ipcRenderer.invoke(PING_CHANNEL, value),
  pathForFile: (file: File): string => webUtils.getPathForFile(file)
})
