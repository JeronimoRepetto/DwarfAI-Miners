// `FakeConsoleResolver` (16 §4.6 table, 16 §2.8): the double of `ConsoleResolver`, passing the same
// contract as `HostConsoleResolver` (consoleResolver.contract.ts). It answers fixed targets from a
// table of sessions, issues one recorded token per target (never placed in it) and records each call.
import type { DwarfId } from '../../../../kernel/domain/values'
import type { ConsoleResolver, ConsoleTarget } from '../../ports/consoleResolver'

export interface FakeConsoleSession {
  owned: boolean
  process: { pid: number; startTime: number } | null
}

export class FakeConsoleResolver implements ConsoleResolver {
  readonly asked: DwarfId[] = []
  readonly issuedTokens: string[] = []

  constructor(private readonly sessions: ReadonlyMap<DwarfId, FakeConsoleSession> = new Map()) {}

  targetFor(dwarfId: DwarfId): Promise<ConsoleTarget> {
    this.asked.push(dwarfId)
    const n = this.issuedTokens.length + 1
    this.issuedTokens.push(n.toString(16).padStart(64, 'f'))
    const credentialFile = `/fake-data/run/viewers/view-${n}.token`
    const command = {
      program: '/fake-app/dwarfai',
      args: ['/fake-app/out/host/dwarfai-viewer.js', credentialFile],
      cwd: '/fake-data'
    }
    const session = this.sessions.get(dwarfId)
    if (session !== undefined && !session.owned && session.process !== null) {
      return Promise.resolve({
        mode: 'focus-terminal',
        focus: { ...session.process },
        command,
        credentialFile
      })
    }
    return Promise.resolve({ mode: 'log', command, credentialFile })
  }
}
