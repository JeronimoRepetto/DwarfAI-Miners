// A `ProcessControl` double for the observed-session key relay (16 §2.8; 17 §2.2 `Recording<Port>`
// family): the kernel `FakeProcessControl`, whose spawned tools (PowerShell, ps, tmux, osascript)
// answer from a script once their stdin ends, recording what each was handed on stdin and the
// order of probes, spawns and kills. It never starts or signals a real process.
import type { ProcessIdentity } from '../../../../../kernel/domain/processIdentity'
import type { PassThrough } from 'node:stream'
import { FakeProcessControl } from '../../../../../kernel/fakes/FakeProcessControl'
import type { SpawnSpec, SpawnedProcess } from '../../../../../kernel/ports/processControl'

/** What one spawned tool answers: its exit code and stdout, or `hang` to never exit. */
export type ToolAnswer = { code: number; stdout?: string } | 'hang'

export class ScriptedConsoleTools extends FakeProcessControl {
  /** What each spawned pid was handed on stdin. */
  readonly stdinOf = new Map<number, string>()
  /** `probe <pid>`, `spawn <args>` and `killTree <pid> <group>`, in order. */
  readonly events: string[] = []
  /** Every identity killTree was asked to end. */
  readonly ended: ProcessIdentity[] = []

  constructor(private readonly answer: (spec: SpawnSpec) => ToolAnswer = () => ({ code: 0 })) {
    super({ firstPid: 9_000 })
  }

  override spawn(spec: SpawnSpec): SpawnedProcess {
    this.events.push(`spawn ${spec.args.join(' ')}`)
    const child = super.spawn(spec)
    void child.identity.then(({ pid }) => {
      let input = ''
      child.stdin?.on('data', (chunk: Buffer) => (input += chunk.toString('utf8')))
      // The readable side ends once every written chunk was read.
      child.stdin?.on('end', () => {
        this.stdinOf.set(pid, input)
        const answer = this.answer(spec)
        if (answer === 'hang') return
        // The fake's pipes are PassThrough streams: the tool's output is written to their far side.
        ;(child.stdout as PassThrough | null)?.end(answer.stdout ?? '')
        ;(child.stderr as PassThrough | null)?.end()
        this.exit(pid, { code: answer.code, signal: null })
      })
    })
    return child
  }

  override probe(pid: number): Promise<ProcessIdentity | 'absent' | 'unknown'> {
    this.events.push(`probe ${pid}`)
    return super.probe(pid)
  }

  override killTree(
    target: ProcessIdentity,
    opts: { graceMs: number; group: 'owned' | 'foreign' }
  ): Promise<{ kind: 'ended' }> {
    this.ended.push(target)
    this.events.push(`killTree ${target.pid} ${opts.group}`)
    this.exit(target.pid, { code: null, signal: 'SIGKILL' })
    return Promise.resolve({ kind: 'ended' })
  }
}
