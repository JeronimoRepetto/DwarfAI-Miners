// A child-process double for the spawners' own tests: the streams of a real ChildProcess (stdin
// collected, stdout and stderr writable by the test) and its events, with no process behind it.
// Never imported by production code (R14).
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { SpawnProcess } from '../windows'

export class FakeChildProcess extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  pid: number | undefined = 4242
  exitCode: number | null = null
  killed = false
  unrefs = 0
  private written = ''

  constructor() {
    super()
    this.stdin.on('data', (chunk: Buffer) => {
      this.written += chunk.toString('utf8')
    })
  }

  /** Everything written to stdin so far. */
  get stdinText(): string {
    return this.written
  }

  /** Prints `line` on stdout, as the launcher step would. */
  print(line: string): void {
    this.stdout.write(`${line}\n`)
  }

  /** Ends the process with `code`: its streams close, then `exit` and `close` fire. */
  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code
    this.stdout.end()
    this.stderr.end()
    this.emit('exit', code, signal)
    this.emit('close', code, signal)
  }

  kill(): boolean {
    this.killed = true
    this.finish(null, 'SIGTERM')
    return true
  }

  unref(): void {
    this.unrefs += 1
  }
}

export interface SpawnCall {
  file: string
  args: readonly string[]
  options: SpawnOptions
  child: FakeChildProcess
}

/** A SpawnProcess that records each call and hands the test the child it returned. */
export class RecordingSpawnProcess {
  readonly calls: SpawnCall[] = []
  /** Runs right after each spawn, e.g. to make the child print or emit `spawn`. */
  onSpawn: (child: FakeChildProcess) => void = () => {}

  readonly spawn: SpawnProcess = (file, args, options) => {
    const child = new FakeChildProcess()
    this.calls.push({ file, args, options, child })
    queueMicrotask(() => this.onSpawn(child))
    return child as unknown as ChildProcess
  }
}
