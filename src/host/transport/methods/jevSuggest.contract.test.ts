// layer: L6
// L6 (17 §1.6): B-M38 `jev.suggest` (14 §2.3, §3.4 `JevSuggestParams`/`JevSuggestResult`, frozen) on
// the Host dispatcher: the strict params schema (ADR-019), the `ui`-only role (ADR-003), the
// names-only log (14 §1.10) and the lead decision of ISSUE-192: a new call from the same connection
// aborts that connection's previous in-flight call (16 §6.5, INV-87). The advisor is an inline
// double (R15): what it answers is the jev module's rule (jevAdvisor.test.ts); the abort, the
// purpose and what reaches the advisor are this method's.
//
// TC-192-03, TC-192-04 (the transport half).
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import {
  HOST_METHOD_SCHEMAS,
  jevSuggestResultSchema,
  type HostMethods,
  type JevSuggestParams,
  type JevSuggestResult
} from '@dwarfai/contracts'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import type { AbortableJevAdvisor, JevSuggestionView } from '../../modules/jev'
import type { ChannelRole } from '../roles'
import { Dispatcher } from '../dispatcher'
import { registerJevSuggest } from './jevSuggest'

const MINE = '01920000-0000-7000-a000-0000000001a1'
const PICK: JevSuggestionView = {
  providerId: 'claude',
  model: 'sonnet',
  tier: 'balanced',
  confidence: { providerId: 0.9 },
  truncated: false,
  parts: { providerId: 'answered', model: 'answered', tier: 'answered' }
}

type SuggestCall = {
  req: Parameters<AbortableJevAdvisor['suggest']>[0]
  signal: AbortSignal | undefined
}

/**
 * The advisor double: a prompt starting with "slow" waits until its signal fires and then answers
 * as the real advisor does for an aborted call (no suggestion); any other answers the pick.
 */
function advisorDouble() {
  const calls: SuggestCall[] = []
  const advisor: Pick<AbortableJevAdvisor, 'suggest'> = {
    suggest(req, opts) {
      calls.push({ req, signal: opts?.signal })
      if (!req.prompt.startsWith('slow')) return Promise.resolve({ ok: true, value: PICK })
      return new Promise((resolve) => {
        opts?.signal?.addEventListener('abort', () =>
          resolve({ ok: false, error: 'jev-unreachable' })
        )
      })
    }
  }
  return { calls, advisor }
}

function served() {
  const clock = new FakeClock()
  const log = new RecordingDiagnosticsLog()
  const dispatcher = new Dispatcher({
    log,
    clock,
    scheduler: new FakeScheduler(clock),
    state: () => 'ready'
  })
  const double = advisorDouble()
  registerJevSuggest(dispatcher, { advisor: double.advisor })
  let next = 0
  const call = (params: unknown, clientId = 'ui-1', role: ChannelRole = 'ui') =>
    dispatcher.dispatch(
      { id: `req-${String(++next)}`, method: 'jev.suggest', params },
      {
        role,
        clientId
      }
    )
  return { call, log, ...double }
}

describe('jev.suggest (B-M38)', () => {
  it('[US-LAUNCH-003.AC07, INV-87] a new jev.suggest from the same connection aborts the previous one, which answers no suggestion, and the new prompt is asked', async () => {
    const { call, calls } = served()

    const first = call({ prompt: 'slow: fix the login form', mineId: MINE })
    const other = call({ prompt: 'slow: another window', mineId: MINE }, 'ui-2')
    await Promise.resolve()
    const second = call({ prompt: 'fix the login form and its tests', mineId: MINE })

    expect(await first).toStrictEqual({
      type: 'res',
      id: 'req-1',
      ok: true,
      result: { ok: false, error: 'jev-unreachable' }
    })
    const res = await second
    expect(res).toStrictEqual({
      type: 'res',
      id: 'req-3',
      ok: true,
      result: { ok: true, value: PICK }
    })
    expect(res.ok && jevSuggestResultSchema.safeParse(res.result).success).toBe(true)
    expect(calls.map((c) => c.req.prompt)).toStrictEqual([
      'slow: fix the login form',
      'slow: another window',
      'fix the login form and its tests'
    ])
    expect(calls.map((c) => c.signal?.aborted)).toStrictEqual([true, false, false])
    // Another connection's call is its own: it is still waiting, not aborted.
    let otherSettled = false
    void other.then(() => {
      otherSettled = true
    })
    await Promise.resolve()
    expect(otherSettled).toBe(false)
  })

  it('[ADR-003] jev.suggest from a notifier gets FORBIDDEN; invalid params get INVALID_PARAMS; the prompt never reaches a log record', async () => {
    const PROMPT = 'refactor the canary-billing module for Watcher of seals'
    const { call, calls, log } = served()

    const notifier = await call({ prompt: PROMPT, mineId: MINE }, 'n-1', 'notifier')
    expect(notifier.ok ? 'ok' : notifier.error.code).toBe('FORBIDDEN')
    for (const params of [
      { prompt: PROMPT },
      { mineId: MINE },
      { prompt: 7, mineId: MINE },
      { prompt: PROMPT, mineId: 'not-a-mine-id' },
      { prompt: PROMPT, mineId: MINE, purpose: 'subtask' },
      null
    ]) {
      const res = await call(params)
      expect(res.ok ? 'ok' : res.error.code, JSON.stringify(params)).toBe('INVALID_PARAMS')
    }
    expect(calls).toStrictEqual([])

    const ok = await call({ prompt: PROMPT, mineId: MINE })
    expect(ok.ok).toBe(true)
    // C-26: only the prompt reaches the advisor, for a launch; the mine id stays in the Host.
    expect(calls.map((c) => c.req)).toStrictEqual([{ prompt: PROMPT, purpose: 'launch' }])
    expect(log.entries.length).toBeGreaterThan(0)
    const logged = JSON.stringify([...log.entries, ...log.refused])
    expect(logged).not.toContain(PROMPT)
    expect(logged).not.toContain('canary-billing')
  })

  it('[ADR-019] the zod-inferred jev.suggest params and result equal the 14 section 3.4 types', () => {
    const schemas: Readonly<Record<string, { params: z.ZodTypeAny; result: z.ZodTypeAny }>> =
      HOST_METHOD_SCHEMAS
    expect(schemas['jev.suggest'], 'B-M38 has no contract schemas').toBeDefined()

    expectTypeOf<HostMethods['jev.suggest']['params']>().toEqualTypeOf<JevSuggestParams>()
    expectTypeOf<HostMethods['jev.suggest']['result']>().toEqualTypeOf<JevSuggestResult>()
    expectTypeOf<
      z.infer<(typeof HOST_METHOD_SCHEMAS)['jev.suggest']['params']>
    >().toEqualTypeOf<JevSuggestParams>()
    expectTypeOf<
      z.infer<(typeof HOST_METHOD_SCHEMAS)['jev.suggest']['result']>
    >().toEqualTypeOf<JevSuggestResult>()
  })
})
