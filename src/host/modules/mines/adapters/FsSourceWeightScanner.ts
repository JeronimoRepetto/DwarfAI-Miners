/// <reference types="electron-vite/node" />
// The SourceWeightScanner adapter (16 §4.1 row `SourceWeightScanner`, 05 §3.1): FsSourceWeightScanner
// ← src/main/tier/tierService.ts. Each `measure` walks the folder in its own worker thread (HR O2),
// so a large tree never stalls the Host's event loop (ask answers, RPCs). The worker is its own
// module, `sourceWeight/scanWorker.ts`, loaded through electron-vite's `?modulePath` import: the
// Host build emits it as a chunk beside `out/host/main.js` (packaged, inside `app.asar` with it),
// and vitest resolves it to the source file (`vitest.config.ts`).
//
// Abort (S3.15): the signal sets a shared flag the walk reads before each directory, the call
// resolves at once with `{ unenterable: 'aborted' }`, and the worker is terminated. A root the
// worker cannot list resolves `{ unenterable }` with the reason (`not-found`, `access-denied`,
// `busy`, `io`); a worker that fails or exits without an answer resolves
// `{ unenterable: 'scan-failed' }`. It never rejects. Read-only: it never writes in the folder.
import { Worker } from 'node:worker_threads'
import type { FolderPath } from '../../../kernel/domain/values'
import type { AbortedMeasurement, SourceWeightScanner } from '../ports/sourceWeightScanner'
import type { ScanWorkerData } from './sourceWeight/scanWorker'
import scanWorkerPath from './sourceWeight/scanWorker?modulePath'
import {
  SOURCE_WALK_RULES,
  type SourceWalkOutcome,
  type SourceWalkRules
} from './sourceWeight/sourceWalk'

const ABORTED: AbortedMeasurement = { unenterable: 'aborted' }
const SCAN_FAILED: SourceWalkOutcome = { unenterable: 'scan-failed' }

export interface FsSourceWeightScannerOptions {
  /** The walk's rules; the measured ones by default. */
  readonly rules?: SourceWalkRules
}

export class FsSourceWeightScanner implements SourceWeightScanner {
  private readonly rules: SourceWalkRules

  constructor(options: FsSourceWeightScannerOptions = {}) {
    this.rules = options.rules ?? SOURCE_WALK_RULES
  }

  measure(path: FolderPath, signal: AbortSignal): Promise<SourceWalkOutcome> {
    if (signal.aborted) return Promise.resolve(ABORTED)
    return new Promise((resolve) => {
      const abortFlag = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
      const workerData: ScanWorkerData = { root: path, rules: this.rules, abortFlag }
      const worker = new Worker(scanWorkerPath, { workerData })
      let settled = false
      const settle = (outcome: SourceWalkOutcome): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve(outcome)
        void worker.terminate()
      }
      const onAbort = (): void => {
        Atomics.store(new Int32Array(abortFlag), 0, 1)
        settle(ABORTED)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      worker.once('message', (outcome: SourceWalkOutcome) => settle(outcome))
      worker.once('error', () => settle(SCAN_FAILED))
      worker.once('exit', () => settle(SCAN_FAILED))
    })
  }
}
