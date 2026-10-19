// The scan worker of FsSourceWeightScanner (HR O2): one walk per worker thread, so a large tree
// never stalls the Host's event loop. It receives `ScanWorkerData`, walks the folder over node:fs
// and posts one `SourceWalkOutcome` back; a walk that throws posts `{ unenterable: 'scan-failed' }`.
// The abort is a shared flag the walk reads before each directory; the adapter also terminates the
// thread once it has answered.
//
// Loaded with electron-vite's `?modulePath` import: the Host build bundles this file as its own
// chunk beside `out/host/main.js`. Under vitest, `vitest.config.ts` answers the same import with
// this file's path and Node runs it with type stripping, which is why its relative imports name
// their `.ts` file and why it and what it imports use erasable syntax only.
import { parentPort, workerData } from 'node:worker_threads'
import { nodeWalkIo } from './nodeWalkIo.ts'
import { sumSourceWeight, type SourceWalkOutcome, type SourceWalkRules } from './sourceWalk.ts'

/** What the adapter hands the worker. */
export interface ScanWorkerData {
  readonly root: string
  readonly rules: SourceWalkRules
  /** One Int32: 1 once the measurement is aborted. */
  readonly abortFlag: SharedArrayBuffer
}

const data = workerData as ScanWorkerData
const flag = new Int32Array(data.abortFlag)
const failed: SourceWalkOutcome = { unenterable: 'scan-failed' }

sumSourceWeight(data.root, data.rules, nodeWalkIo, () => Atomics.load(flag, 0) === 1).then(
  (outcome) => parentPort?.postMessage(outcome),
  () => parentPort?.postMessage(failed)
)
