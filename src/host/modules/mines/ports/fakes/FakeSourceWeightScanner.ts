// The SourceWeightScanner double (16 §4.1 row `SourceWeightScanner`, 16 §2.8): walks a FakeFs in
// process, honours the signal per directory and resolves promptly on abort, and answers a root it
// cannot list with `{ unenterable }` and the FakeFs error. `hold` suspends every walk before it
// reads, so a test can abort a walk mid-scan (S3.15). Every call is kept in `calls`.
//
// Ports are type-only (R2), so this double carries its own small rules instead of importing the
// adapter's: the measured skip directories and a subset of the source-ish extensions, enough for
// the suites that use it; the shared `runSourceWeightScannerContract` keeps the two in step. It
// counts every source-ish file whole: the adapter's bundle, generated-name and duplicate
// exclusions are its own (`sourceWalk.test.ts`). Never imported by production code (R14).
import type { FolderPath } from '../../../../kernel/domain/values'
import type { FakeFs } from '../../../../kernel/fakes/FakeFs'
import type { AbortedMeasurement, SourceWeightScanner } from '../sourceWeightScanner'

type Measurement = { bytes: number } | { unenterable: string }

const ABORTED: AbortedMeasurement = { unenterable: 'aborted' }

/** The adapter's measured skip list (`tierService.ts` `SKIP_DIRS`). */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  '.venv',
  'target',
  'release',
  'build'
])

/** A subset of the adapter's source-ish extensions. */
const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  'c',
  'cpp',
  'cs',
  'css',
  'go',
  'html',
  'java',
  'js',
  'jsx',
  'kt',
  'py',
  'rb',
  'rs',
  'ts',
  'tsx',
  'vue'
])

export class FakeSourceWeightScanner implements SourceWeightScanner {
  /** Every `measure` call, in call order. */
  readonly calls: { path: FolderPath; signal: AbortSignal }[] = []
  private gate: Promise<void> | null = null

  constructor(private readonly fs: FakeFs) {}

  /** Suspends every walk (running or new) before its next read, until the returned function runs. */
  hold(): () => void {
    let open = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    this.gate = gate
    return () => {
      if (this.gate === gate) this.gate = null
      open()
    }
  }

  measure(path: FolderPath, signal: AbortSignal): Promise<Measurement> {
    this.calls.push({ path, signal })
    if (signal.aborted) return Promise.resolve(ABORTED)
    return new Promise((resolve) => {
      const onAbort = (): void => resolve(ABORTED)
      signal.addEventListener('abort', onAbort, { once: true })
      void this.walk(path, signal).then((result) => {
        signal.removeEventListener('abort', onAbort)
        resolve(result)
      })
    })
  }

  private async walk(root: string, signal: AbortSignal): Promise<Measurement> {
    let bytes = 0
    const queue = [root]
    for (let dir = queue.shift(); dir !== undefined; dir = queue.shift()) {
      while (this.gate !== null) await this.gate
      if (signal.aborted) return ABORTED
      const listed = await this.fs.listDirWithSizes(dir)
      if (!listed.ok) {
        if (dir === root) return { unenterable: listed.error }
        continue
      }
      for (const entry of listed.value) {
        if (entry.isDirectory) {
          if (!SKIP_DIRS.has(entry.name)) queue.push(`${dir}\\${entry.name}`)
        } else if (isSourceFile(entry.name)) {
          bytes += entry.size
        }
      }
    }
    return { bytes }
  }
}

function isSourceFile(name: string): boolean {
  const dotAt = name.lastIndexOf('.')
  return dotAt > 0 && SOURCE_EXTENSIONS.has(name.slice(dotAt + 1).toLowerCase())
}
