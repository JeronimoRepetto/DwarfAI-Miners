// L6: B-M29 `conversation.resolveConsole` at the Host dispatcher (14 §2.3; ADR-031 items 1–4;
// ADR-003 item 12), over the ConsoleResolver double. Every answer is checked against its strict()
// contract schema (14 §1.4).
import { describe, expect, it } from 'vitest'
import { HOST_METHOD_SCHEMAS } from '@dwarfai/contracts'
import type { DwarfId } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import type { ConsoleTarget, ResolveConsole } from '../../modules/conversation'
import { Dispatcher } from '../dispatcher'
import { registerConversationResolveConsole } from './conversationResolveConsole'

const LAUNCHED = '01920000-0000-7000-9000-0000000000a1' as DwarfId
const OBSERVED = '01920000-0000-7000-9000-0000000000a2' as DwarfId
const SCHEMA = HOST_METHOD_SCHEMAS['conversation.resolveConsole']

function served() {
  const log = new RecordingDiagnosticsLog()
  const clock = new FakeClock()
  const dispatcher = new Dispatcher({
    log,
    clock,
    scheduler: new FakeScheduler(clock),
    state: () => 'ready'
  })
  const asked: DwarfId[] = []
  // A ConsoleResolver-backed use case in miniature: the observed dwarf focuses, every other gets log.
  const conversation: ResolveConsole = {
    resolveConsole: (dwarfId) => {
      asked.push(dwarfId)
      const credentialFile = '/data/run/viewers/00000000-0000-7000-8000-000000000001.token'
      const command = {
        program: '/app/dwarfai',
        args: ['/app/out/host/dwarfai-viewer.js', credentialFile],
        cwd: '/data'
      }
      const target: ConsoleTarget =
        dwarfId === OBSERVED
          ? { mode: 'focus-terminal', focus: { pid: 7, startTime: 70 }, command, credentialFile }
          : { mode: 'log', command, credentialFile }
      return Promise.resolve(target)
    }
  }
  registerConversationResolveConsole(dispatcher, { conversation })
  const call = (role: 'ui' | 'notifier' | 'viewer', params: unknown) =>
    dispatcher.dispatch(
      { id: 'r-1', method: 'conversation.resolveConsole', params },
      { role, clientId: 'c-1', ...(role === 'viewer' ? { dwarfId: LAUNCHED } : {}) }
    )
  return { call, asked, log }
}

describe('conversation.resolveConsole over the dispatcher (B-M29)', () => {
  it('[US-MSG-007.AC06, ADR-031] a ui client gets the log view of a launched dwarf, schema-valid', async () => {
    const { call } = served()
    const res = await call('ui', { dwarfId: LAUNCHED })

    if (!res.ok) throw new Error(`refused: ${res.error.code}`)
    const target = SCHEMA.result.parse(res.result)
    expect(target.mode).toBe('log')
    expect(target.command?.args.at(-1)).toBe(target.credentialFile)
  })

  it('[US-MSG-007.AC01, ADR-031] an observed dwarf resolves to focus-terminal with its process and the log fallback', async () => {
    const { call } = served()
    const res = await call('ui', { dwarfId: OBSERVED })

    if (!res.ok) throw new Error(`refused: ${res.error.code}`)
    const target = SCHEMA.result.parse(res.result)
    expect(target.mode).toBe('focus-terminal')
    expect(target.focus).toEqual({ pid: 7, startTime: 70 })
    expect(target.credentialFile).toBeDefined()
  })

  it('[ADR-003, FM-035] a viewer or a notifier gets FORBIDDEN and no token is issued', async () => {
    const { call, asked } = served()

    for (const role of ['viewer', 'notifier'] as const) {
      const res = await call(role, { dwarfId: LAUNCHED })
      expect(res.ok ? 'ok' : res.error.code).toBe('FORBIDDEN')
    }
    expect(asked).toEqual([])
  })

  it('[ADR-019] resolveConsole params are strict: an unknown field or a dwarf id that is not one is INVALID_PARAMS', async () => {
    const { call, asked } = served()

    for (const params of [{ dwarfId: LAUNCHED, extra: 1 }, { dwarfId: 'not-a-dwarf' }, {}]) {
      const res = await call('ui', params)
      expect(res.ok ? 'ok' : res.error.code).toBe('INVALID_PARAMS')
    }
    expect(asked).toEqual([])
  })

  it('[ADR-017, ADR-019] the result schema refuses a target with an env map or any field ADR-031 does not name', () => {
    const base = {
      mode: 'log',
      command: { program: '/a', args: ['/b', '/c'], cwd: '/' },
      credentialFile: '/c'
    }
    expect(SCHEMA.result.safeParse(base).success).toBe(true)
    expect(SCHEMA.result.safeParse({ ...base, token: 'ab' }).success).toBe(false)
    expect(
      SCHEMA.result.safeParse({ ...base, command: { ...base.command, env: { X: '1' } } }).success
    ).toBe(false)
  })
})
