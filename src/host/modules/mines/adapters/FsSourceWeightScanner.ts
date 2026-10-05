// The SourceWeightScanner adapter (16 §4.1 row `SourceWeightScanner`, 05 §3.1): FsSourceWeightScanner
// ← src/main/tier/tierService.ts. Each `measure` walks the folder in its own worker thread (HR O2),
// so a large tree never stalls the Host's event loop (ask answers, RPCs). The worker is an eval
// worker built from the walk's own source text, as the HR O2 reference does to escape the asar
// archive: it needs no separate bundle entry and no file on disk, and it carries the walk's rules
// as `workerData`.
//
// Abort (S3.15): the signal sets a shared flag the walk reads before each directory, the call
// resolves at once with `{ unenterable: 'aborted' }`, and the worker is terminated. A root the
// worker cannot list resolves `{ unenterable }` with the reason (`not-found`, `access-denied`,
// `busy`, `io`); a worker that fails or exits without an answer resolves
// `{ unenterable: 'scan-failed' }`. It never rejects. Read-only: it never writes in the folder.
import type * as NodeCrypto from 'node:crypto'
import type * as NodeFs from 'node:fs/promises'
import type * as NodePath from 'node:path'
import { Worker } from 'node:worker_threads'
import type { FolderPath } from '../../../kernel/domain/values'
import type { AbortedMeasurement, SourceWeightScanner } from '../ports/sourceWeightScanner'
import {
  SOURCE_WALK_RULES,
  sumSourceWeight,
  type SourceWalkIo,
  type SourceWalkOutcome,
  type SourceWalkRules
} from './sourceWeight/sourceWalk'

const ABORTED: AbortedMeasurement = { unenterable: 'aborted' }
const SCAN_FAILED: SourceWalkOutcome = { unenterable: 'scan-failed' }

/**
 * The walk's io over node:fs, built inside the worker. SELF-CONTAINED like `sumSourceWeight`: it
 * reads only its parameters, because the worker is built from its source text.
 */
export function createNodeWalkIo(
  fs: typeof NodeFs,
  crypto: typeof NodeCrypto,
  path: typeof NodePath
): SourceWalkIo {
  const reasonOf = (error: unknown): string => {
    const code = (error as { code?: unknown } | null)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'not-found'
    if (code === 'EACCES' || code === 'EPERM') return 'access-denied'
    if (code === 'EBUSY') return 'busy'
    return 'io'
  }
  return {
    list: async (dir) => {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true })
        return {
          ok: true,
          value: entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
        }
      } catch (error) {
        return { ok: false, error: reasonOf(error) }
      }
    },
    size: async (file) => {
      try {
        return (await fs.stat(file)).size
      } catch {
        return null
      }
    },
    fingerprint: async (file, size, sampleBytes) => {
      const hash = crypto.createHash('sha1')
      try {
        const handle = await fs.open(file, 'r')
        try {
          const sample = new Uint8Array(Math.min(size, sampleBytes))
          const { bytesRead } = await handle.read(sample, 0, sample.byteLength, 0)
          hash.update(sample.subarray(0, bytesRead))
        } finally {
          await handle.close()
        }
      } catch {
        // An unreadable file keeps a key of its own: it is never taken for a copy.
        hash.update(file)
      }
      return `${size}:${hash.digest('hex')}`
    },
    join: (dir, name) => path.join(dir, name)
  }
}

/** The worker's whole program: the io, the walk, and one answer posted back. */
const WORKER_SOURCE = [
  `'use strict';`,
  `const { parentPort, workerData } = require('node:worker_threads');`,
  `const io = (${createNodeWalkIo.toString()})(require('node:fs/promises'), require('node:crypto'), require('node:path'));`,
  `const flag = new Int32Array(workerData.abortFlag);`,
  `(${sumSourceWeight.toString()})(workerData.root, workerData.rules, io, () => Atomics.load(flag, 0) === 1)`,
  `  .then((outcome) => parentPort.postMessage(outcome), () => parentPort.postMessage(${JSON.stringify(SCAN_FAILED)}));`
].join('\n')

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
      const worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { root: path, rules: this.rules, abortFlag }
      })
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
