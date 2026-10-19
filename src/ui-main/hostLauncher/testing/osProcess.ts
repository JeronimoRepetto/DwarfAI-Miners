// Helpers for OS-lane tests (17 §1.8) that run launcher code in processes of their own, the way two UI processes
// would: `bundleEntry` builds an entry that imports the repository's own TypeScript into one ES module (the vite
// SSR build versionedCopyInElectron.os.test.ts uses), and `NodeScript` runs it with this Node and reads its output
// line by line. Never imported by production code (R14); it lives under hostLauncher/ because that is the UI path
// allowed to start a process (R17).
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

/** Builds `source` (an entry that may import repository files by absolute path) into `<outDir>/<name>.mjs`. */
export async function bundleEntry(source: string, outDir: string, name: string): Promise<string> {
  mkdirSync(outDir, { recursive: true })
  const entry = path.join(outDir, `${name}.entry.ts`)
  writeFileSync(entry, source)
  await build({
    configFile: false,
    logLevel: 'silent',
    resolve: {
      alias: { '@dwarfai/contracts': path.join(REPO_ROOT, 'src', 'contracts', 'index.ts') }
    },
    ssr: { noExternal: true },
    build: {
      ssr: entry,
      outDir,
      emptyOutDir: false,
      minify: false,
      target: 'node22',
      rollupOptions: { output: { format: 'es', entryFileNames: `${name}.mjs` } }
    }
  })
  return path.join(outDir, `${name}.mjs`)
}

/** An absolute import specifier for a repository file, usable in a bundled entry on every OS. */
export function repoImport(...segments: string[]): string {
  return JSON.stringify(
    path
      .join(REPO_ROOT, ...segments)
      .split(path.sep)
      .join('/')
  )
}

/** One bundled script run with this Node; its stdout read as lines. */
export class NodeScript {
  readonly lines: string[] = []
  readonly exited: Promise<number | null>
  private readonly child: ChildProcess
  private readonly waiters: Array<() => void> = []

  constructor(script: string, args: readonly string[]) {
    this.child = spawn(process.execPath, [script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false
    })
    let partial = ''
    this.child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      partial += chunk
      const parts = partial.split(/\r?\n/)
      partial = parts.pop() ?? ''
      this.lines.push(...parts.filter((line) => line !== ''))
      for (const wake of this.waiters.splice(0)) wake()
    })
    this.child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      this.lines.push(`stderr: ${chunk.trim()}`)
      for (const wake of this.waiters.splice(0)) wake()
    })
    this.exited = new Promise((resolve) => {
      this.child.once('exit', (code) => {
        for (const wake of this.waiters.splice(0)) wake()
        resolve(code)
      })
      this.child.once('error', () => resolve(null))
    })
  }

  get pid(): number {
    return this.child.pid ?? -1
  }

  get running(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null
  }

  /** Resolves with the first line `accept` takes, or rejects after `timeoutMs` or once the script exited without it. */
  async line(accept: (line: string) => boolean, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = this.lines.find(accept)
      if (found !== undefined) return found
      if (!this.running)
        throw new Error(`the script exited without the line: ${this.lines.join(' | ')}`)
      const left = deadline - Date.now()
      if (left <= 0) throw new Error(`no such line in ${timeoutMs} ms: ${this.lines.join(' | ')}`)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left)
        this.waiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }

  /** Ends the script at once (a crash: nothing of its own runs) and waits for its exit. */
  async kill(): Promise<void> {
    if (this.running) this.child.kill('SIGKILL')
    await this.exited
  }
}
