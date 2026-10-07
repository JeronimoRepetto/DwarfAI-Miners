// layer: L6
// L6 (17 §1.6): A-19 `getMineHistory` (14 §2.1 CHANGE, §3.6 `MineHistoryView`, §3.8; ADR-019 items
// 7, 8) as its `host` handler serves it, over a faked HostClient: main validates the renderer's
// `mineId` string against the registry's request and relays `conversation.mineHistory` (B-M27) with
// `{ mineId }`; every answer is checked against the registry's response schema (14 §1.4).
//
// TC-104-02 (the A-19 half: the answer is IpcResult<MineHistoryView>).
import { describe, expect, it } from 'vitest'
import {
  CHANNELS,
  type HostMethod,
  type HostParams,
  type HostResult,
  type IpcError,
  type MineHistoryView
} from '@dwarfai/contracts'
import { HostCallError } from '../../host-client/HostClient'
import type { HostClient } from '../../window/ports/hostClient'
import { createGetMineHistoryRow, GET_MINE_HISTORY } from './getMineHistory.host'

const MINE = '01920000-0000-7000-9000-0000000000f1'
const DWARF = '01920000-0000-7000-9000-00000000000a'
const MESSAGE = '01920000-0000-7000-a000-000000000001'

const HISTORY: MineHistoryView = {
  mineId: MINE,
  speakers: [
    {
      dwarfId: DWARF,
      displayName: 'Dáin',
      // Amended: each speaker carries its rank and provider (owner amendment F, 2026-10-07).
      rank: 'foreman',
      providerId: 'claude',
      departed: true,
      messages: [
        {
          id: MESSAGE,
          dwarfId: DWARF,
          role: 'person',
          text: 'are the tests green?',
          attachments: [],
          delivery: {
            messageId: MESSAGE,
            dwarfId: DWARF,
            kind: 'message',
            phase: 'failed',
            failure: { kind: 'session-closed' },
            attempts: 1,
            phaseAt: 1_002
          },
          providerTime: null,
          createdAt: 1_001
        }
      ]
    }
  ]
} as unknown as MineHistoryView

/** The HostClient `call` the row uses: records each call and answers the history, or refuses. */
class FakeHistoryHost implements Pick<HostClient, 'call'> {
  readonly calls: Array<{ method: string; params: unknown }> = []
  refusal: IpcError | null = null

  call<M extends HostMethod>(method: M, params: HostParams[M]): Promise<HostResult[M]> {
    this.calls.push({ method, params })
    if (this.refusal !== null) return Promise.reject(new HostCallError(this.refusal))
    return Promise.resolve(HISTORY as HostResult[M])
  }
}

describe('A-19 getMineHistory, host handler (14 §2.1, §3.6)', () => {
  it('[ADR-019] A-19 relays conversation.mineHistory and answers IpcResult<MineHistoryView>; a non-string mineId is refused in main', async () => {
    const host = new FakeHistoryHost()
    const row = createGetMineHistoryRow(host)
    const response = CHANNELS[GET_MINE_HISTORY].response

    // A valid mineId is relayed as the B-M27 params, and the history comes back as IpcResult<MineHistoryView>.
    const answer = await row.serve(GET_MINE_HISTORY, MINE)
    expect(host.calls).toEqual([{ method: 'conversation.mineHistory', params: { mineId: MINE } }])
    expect(response.parse(answer)).toEqual({ ok: true, value: HISTORY })

    // A non-string or malformed mineId is refused in main and never reaches the Host.
    const relayed = host.calls.length
    for (const invalid of [7, { mineId: MINE }, 'mine-one', '', null, undefined]) {
      const refused = await row.serve(GET_MINE_HISTORY, invalid)
      expect(response.parse(refused), JSON.stringify(invalid)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_PARAMS' }
      })
    }
    expect(host.calls).toHaveLength(relayed)

    // A Host call error is the result's error branch (14 §1.5), never a throw into the renderer.
    host.refusal = { code: 'HOST_NOT_READY', message: 'the Host is starting', retryable: true }
    expect(await row.serve(GET_MINE_HISTORY, MINE)).toEqual({ ok: false, error: host.refusal })
    host.refusal = null
    expect(await row.serve('dwarf:feed:page', { dwarfId: DWARF })).toMatchObject({
      ok: false,
      error: { code: 'METHOD_NOT_FOUND' }
    })
    expect(host.calls).toHaveLength(relayed + 1)
  })
})
