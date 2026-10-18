// L6: A-13 `activateDwarf`, the split row (14 §2.1, §3.8; ADR-031 items 1–5; ADR-019), over a HostClient `call` double
// and the native actions double. Every answer is checked against the channel's strict() response schema (14 §1.4).
import { describe, expect, it } from 'vitest'
import {
  CHANNELS,
  type ConsoleTarget,
  type HostMethod,
  type HostParams,
  type HostResult,
  type IpcError
} from '@dwarfai/contracts'
import { HostCallError } from '../../host-client/HostClient'
import type { HostClient } from '../../window/ports/hostClient'
import { FakeNativeActions } from '../../window/ports/fakes/FakeNativeActions'
import { ACTIVATE_DWARF, createActivateDwarfRow } from './activateDwarf'

const DWARF = '01920000-0000-7000-a000-000000000170'
const TOKEN_FILE = '/data/run/viewers/01920000-0000-7000-9000-00000000c0de.token'
const COMMAND = {
  program: '/app/dwarfai',
  args: ['/app/out/host/dwarfai-viewer.js', TOKEN_FILE],
  cwd: '/data'
}
const LOG: ConsoleTarget = { mode: 'log', command: COMMAND, credentialFile: TOKEN_FILE }
const FOCUS: ConsoleTarget = { ...LOG, mode: 'focus-terminal', focus: { pid: 4242, startTime: 70 } }
const RESPONSE = CHANNELS[ACTIVATE_DWARF].response

/** The HostClient `call` the row uses: records each call and answers `target`, or refuses. */
class FakeConsoleHost implements Pick<HostClient, 'call'> {
  readonly calls: Array<{ method: string; params: unknown }> = []
  refusal: IpcError | null = null
  constructor(public target: ConsoleTarget = LOG) {}

  call<M extends HostMethod>(method: M, params: HostParams[M]): Promise<HostResult[M]> {
    this.calls.push({ method, params })
    if (this.refusal !== null) return Promise.reject(new HostCallError(this.refusal))
    return Promise.resolve(this.target) as Promise<HostResult[M]>
  }
}

/** A native actions double whose console raise answers per mode. */
function consoles(answer: Partial<Record<ConsoleTarget['mode'], 'raised' | 'failed'>>) {
  const actions = new FakeNativeActions()
  const raise = actions.raiseConsole.bind(actions)
  actions.raiseConsole = async (t) => {
    await raise(t)
    return answer[t.mode] ?? 'failed'
  }
  return actions
}

async function serve(host: FakeConsoleHost, actions: FakeNativeActions, payload: unknown) {
  const row = createActivateDwarfRow({ client: host, consoles: actions })
  return RESPONSE.parse(await row.serve(ACTIVATE_DWARF, payload))
}

describe('A-13 activateDwarf, split row (14 §2.1, §3.8)', () => {
  it('[US-MSG-007.AC03] opening the console answers the renderer with no toast and no confirmation', async () => {
    for (const purpose of ['open-console', 'jump-to-terminal'] as const) {
      const host = new FakeConsoleHost(LOG)
      const actions = consoles({ log: 'raised' })

      const result = await serve(host, actions, { dwarfId: DWARF, purpose })

      // The answer is the console outcome alone: nothing for the renderer to toast or confirm.
      expect(result).toEqual({ ok: true, value: { outcome: 'opened', mode: 'log' } })
      expect(host.calls).toEqual([
        { method: 'conversation.resolveConsole', params: { dwarfId: DWARF } }
      ])
      expect(actions.consoles).toEqual([LOG])
    }
  })

  it('[US-MSG-007.AC02] Jump to terminal resolves and opens the console and calls no asking method', async () => {
    const host = new FakeConsoleHost(FOCUS)
    const actions = consoles({ 'focus-terminal': 'raised' })

    expect(await serve(host, actions, { dwarfId: DWARF, purpose: 'jump-to-terminal' })).toEqual({
      ok: true,
      value: { outcome: 'raised', mode: 'focus-terminal' }
    })
    expect(host.calls.map((c) => c.method)).toEqual(['conversation.resolveConsole'])
  })

  it('[US-MSG-007.AC01, ADR-031] a focus that cannot raise the window falls back to the log view of the same target', async () => {
    const host = new FakeConsoleHost(FOCUS)
    const actions = consoles({ 'focus-terminal': 'failed', log: 'raised' })

    expect(await serve(host, actions, { dwarfId: DWARF, purpose: 'open-console' })).toEqual({
      ok: true,
      value: { outcome: 'opened', mode: 'log' }
    })
    expect(actions.consoles).toEqual([
      FOCUS,
      { mode: 'log', command: COMMAND, credentialFile: TOKEN_FILE }
    ])
  })

  it('[FM-054] a console that cannot be opened answers failed with its mode, and no toast', async () => {
    const log = await serve(new FakeConsoleHost(LOG), consoles({}), {
      dwarfId: DWARF,
      purpose: 'open-console'
    })
    const focusOnly = await serve(
      new FakeConsoleHost({ mode: 'focus-terminal', focus: { pid: 1, startTime: 1 } }),
      consoles({}),
      { dwarfId: DWARF, purpose: 'open-console' }
    )
    const both = await serve(new FakeConsoleHost(FOCUS), consoles({}), {
      dwarfId: DWARF,
      purpose: 'open-console'
    })

    expect(log).toEqual({ ok: true, value: { outcome: 'failed', mode: 'log' } })
    expect(focusOnly).toEqual({ ok: true, value: { outcome: 'failed', mode: 'focus-terminal' } })
    expect(both).toEqual({ ok: true, value: { outcome: 'failed', mode: 'log' } })
  })

  it('[ADR-019] activateDwarf params are strict', async () => {
    const host = new FakeConsoleHost()
    const actions = consoles({ log: 'raised' })

    for (const payload of [
      { dwarfId: DWARF, purpose: 'open-console', extra: 1 },
      { dwarfId: DWARF, purpose: 'answer' },
      { dwarfId: 'not-a-dwarf', purpose: 'open-console' },
      { dwarfId: DWARF },
      DWARF,
      null
    ]) {
      const result = await serve(host, actions, payload)
      expect(result.ok ? 'ok' : result.error.code, JSON.stringify(payload)).toBe('INVALID_PARAMS')
    }
    expect(host.calls).toEqual([])
    expect(actions.consoles).toEqual([])
  })

  it('[ADR-019] a Host refusal is the result error, and nothing is executed', async () => {
    const host = new FakeConsoleHost()
    host.refusal = { code: 'HOST_UNAVAILABLE', message: 'the Host is unavailable', retryable: true }
    const actions = consoles({ log: 'raised' })

    expect(await serve(host, actions, { dwarfId: DWARF, purpose: 'open-console' })).toEqual({
      ok: false,
      error: host.refusal
    })
    expect(actions.consoles).toEqual([])
  })
})
