// L1 cases of the Codex acp Deny mapping (15 §2.7 ACP row, §4.5; HR A2, D4) over the adapter's own
// option sets (cxacp@bf37821 test data, Apache-2.0, copied with attribution into
// fixtures/codex/acp/0.157.x-synthetic/) and hand-written ones.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { codexPermissionReply, type CodexPermissionOption } from './denyMapping'

const FIXTURES = new URL(
  '../../../../../../../fixtures/codex/acp/0.157.x-synthetic/',
  import.meta.url
)

function optionsOf(name: string): CodexPermissionOption[] {
  const call = JSON.parse(readFileSync(fileURLToPath(new URL(name, FIXTURES)), 'utf8')) as {
    args: [{ options: CodexPermissionOption[] }]
  }
  return call.args[0].options
}

const decided = (optionId: string, kind: string, decision?: string): CodexPermissionOption => ({
  optionId,
  kind,
  ...(decision === undefined ? {} : { _meta: { codex: { decision } } })
})

describe('the Codex acp Deny mapping', () => {
  it('[C-07] Deny sends the native decline when _meta.codex.decision is offered, else reject_once', () => {
    // The adapter's own command and file-change sets: reject_once carries decision decline.
    for (const file of [
      'cxacp-approval-command-allow-once.json',
      'cxacp-approval-file-change.json'
    ]) {
      expect(codexPermissionReply(optionsOf(file), 'deny')).toEqual({
        kind: 'select',
        optionId: 'reject_once'
      })
    }
    // A set whose first reject_once is cancel (deny and interrupt, HR D4): decline is preferred.
    const both = [
      decided('allow', 'allow_once', 'accept'),
      decided('cancel', 'reject_once', 'cancel'),
      decided('decline', 'reject_once', 'decline')
    ]
    expect(codexPermissionReply(both, 'deny')).toEqual({ kind: 'select', optionId: 'decline' })
    // No decline offered (the permissions request answers rejectPermissions): reject_once.
    expect(
      codexPermissionReply(optionsOf('cxacp-approval-permissions-request.json'), 'deny')
    ).toEqual({ kind: 'select', optionId: 'reject_permissions' })
    // A decline that is not a reject_once is never sent for a Deny (only the kind is the contract).
    expect(
      codexPermissionReply(
        [decided('odd', 'allow_always', 'decline'), decided('no', 'reject_once', 'cancel')],
        'deny'
      )
    ).toEqual({ kind: 'select', optionId: 'no' })
    // Neither: a JSON-RPC error (fail closed, HR A3).
    expect(codexPermissionReply([decided('allow', 'allow_once', 'accept')], 'deny')).toEqual({
      kind: 'error'
    })
  })

  it('[C-06] Allow sends allow_once by optionId and never allow_always', () => {
    expect(
      codexPermissionReply(optionsOf('cxacp-approval-command-allow-once.json'), 'allow')
    ).toEqual({ kind: 'select', optionId: 'allow_once' })
    expect(
      codexPermissionReply(optionsOf('cxacp-approval-permissions-request.json'), 'allow')
    ).toEqual({ kind: 'select', optionId: 'allow_permissions_turn' })
    expect(codexPermissionReply([decided('always', 'allow_always')], 'allow')).toEqual({
      kind: 'refuse'
    })
  })
})
