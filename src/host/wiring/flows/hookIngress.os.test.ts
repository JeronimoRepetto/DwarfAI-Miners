// layer: L8
// The hook ingress the Host starts at boot step 6 (16 §8.2; ADR-016 items 2–3; 13 FM-038;
// ISSUE-140), on this OS's real network stack (17 §1.8): the asking flow's Host
// (testing/askingHost.ts, composed as host/main.ts composes it) with a real 127.0.0.1 listener, and
// Claude Code's hook requests sent over loopback HTTP as its hook command sends them. Runs only in
// `pnpm test:os`, on Windows, macOS and Linux alike. Every connection goes to this machine.
import { afterEach, describe, expect, it } from 'vitest'
import type { SourceWeightScanner } from '../../modules/mines'
import { INGRESS_TOKEN_HEADER } from '../../transport/ingress/httpIngress'
import { post } from '../../transport/ingress/testing/ingressHarness'
import {
  askOf,
  CALL,
  cleanUp,
  observedClaude as observedAskingClaude,
  permissionRequest
} from './testing/askingHost'

afterEach(cleanUp)

/** A fixed source weight: the mine's tier is not what this flow proves (testing/askingHost.ts). */
const fixedWeight: SourceWeightScanner = { measure: () => Promise.resolve({ bytes: 2_048 }) }

/** The observed-Claude Host whose boot step 6 listens on a real 127.0.0.1 port. */
function observedClaude() {
  return observedAskingClaude({ scanner: fixedWeight, listen: true, database: 'migrated-here' })
}

describe('the hook ingress started at boot step 6 (ISSUE-140)', () => {
  it('[ADR-016, ADR-010] boot step 6 listens on 127.0.0.1 on the persisted port and a Claude Code hook request over loopback HTTP opens one ask', async () => {
    const { w, h, ui, notifier, token, dwarfId } = await observedClaude()
    const port = h.ingressPort()
    expect(port).not.toBeNull()

    const answer = await post(port ?? 0, {
      headers: { [INGRESS_TOKEN_HEADER]: token, 'content-type': 'application/json' },
      body: JSON.stringify(permissionRequest(w))
    })
    await h.settle(ui, notifier)

    expect(answer.status).toBe(204)
    expect(askOf(h, dwarfId)).toMatchObject({
      dwarfId,
      kind: 'permission',
      providerRequestId: CALL,
      state: 'open'
    })
    expect(h.crew.crew.queries.get(dwarfId)?.status).toBe('asking')
  })

  it('[ADR-016] a hook request over loopback HTTP with a token that is not the active one is refused 401 and opens no ask', async () => {
    const { w, h, ui, notifier, token, dwarfId } = await observedClaude()
    const wrong = token.replace(/^./, (first) => (first === '0' ? '1' : '0'))

    const answer = await post(h.ingressPort() ?? 0, {
      headers: { [INGRESS_TOKEN_HEADER]: wrong, 'content-type': 'application/json' },
      body: JSON.stringify(permissionRequest(w))
    })
    await h.settle(ui, notifier)

    expect(answer.status).toBe(401)
    expect(askOf(h, dwarfId)).toBeNull()
  })

  it('[ADR-002, ADR-016] Stop everything and quit closes the hook ingress: its port refuses the next request', async () => {
    const { w, h, token } = await observedClaude()
    const port = h.ingressPort() ?? 0

    await h.stopEverything()

    await expect(
      post(port, {
        headers: { [INGRESS_TOKEN_HEADER]: token, 'content-type': 'application/json' },
        body: JSON.stringify(permissionRequest(w))
      })
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })
})
