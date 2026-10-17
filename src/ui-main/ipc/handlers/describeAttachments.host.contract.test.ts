// layer: L6
// L6 (17 §1.6): A-25 `describeDwarfAttachments` / `dwarf:attachments:describe` (14 §2.1 KEEP, `host`, owner
// conversation; `string[]` → `DwarfAttachmentPick[]`, eA as `[]` + per-item `refusal`; ADR-019 item 9; 14 §8 I-10) as
// its `host` handler serves it, over a faked HostClient: main validates the renderer's paths against the registry's
// request and relays `conversation.describeAttachments` (B-M28) with exactly `{ paths }`; the Host re-validates every
// path and answers one pick per path, handed back unchanged. A KEEP row answers its legacy failure shape (14 §1.5): a
// malformed payload, a path the B-M28 params would refuse and a Host call error all answer `[]`; nothing is guessed and
// nothing malformed reaches the Host. Every answer is checked against the registry's response schema.
import { describe, expect, it } from 'vitest'
import {
  CHANNELS,
  WIRE_PATH_MAX_CHARS,
  type HostMethod,
  type HostParams,
  type HostResult,
  type IpcError
} from '@dwarfai/contracts'
import { HostCallError } from '../../host-client/HostClient'
import type { HostClient } from '../../window/ports/hostClient'
import { createDescribeAttachmentsRow, DESCRIBE_ATTACHMENTS } from './describeAttachments.host'

const IMAGE = 'C:/work/north-seam.png'
const FOLDER = 'C:/work/maps'

const PICKS = [
  { path: IMAGE, attachment: { path: IMAGE, name: 'north-seam.png', kind: 'image', bytes: 2048 } },
  { path: FOLDER, refusal: 'directory' }
]

/** The HostClient `call` the row uses: records each call and answers `answer`, or refuses. */
class FakeDescribeHost implements Pick<HostClient, 'call'> {
  readonly calls: Array<{ method: string; params: unknown }> = []
  answer: unknown = PICKS
  refusal: IpcError | null = null

  call<M extends HostMethod>(method: M, params: HostParams[M]): Promise<HostResult[M]> {
    this.calls.push({ method, params })
    if (this.refusal !== null) return Promise.reject(new HostCallError(this.refusal))
    return Promise.resolve(this.answer) as Promise<HostResult[M]>
  }
}

describe('A-25 describeDwarfAttachments, host handler (14 §2.1)', () => {
  it('[ADR-019] A-25 validates the paths in main and relays conversation.describeAttachments, one pick per path', async () => {
    const host = new FakeDescribeHost()
    const row = createDescribeAttachmentsRow(host)
    const response = CHANNELS[DESCRIBE_ATTACHMENTS].response

    expect(response.parse(await row.serve(DESCRIBE_ATTACHMENTS, [IMAGE, FOLDER]))).toEqual(PICKS)
    expect(host.calls).toEqual([
      { method: 'conversation.describeAttachments', params: { paths: [IMAGE, FOLDER] } }
    ])
  })

  it('[ADR-019, NFR-SEC-12] a malformed payload or a path the Host params refuse answers [] and never reaches the Host', async () => {
    const host = new FakeDescribeHost()
    const row = createDescribeAttachmentsRow(host)
    const response = CHANNELS[DESCRIBE_ATTACHMENTS].response

    for (const payload of [
      IMAGE,
      [IMAGE, 7],
      { paths: [IMAGE] },
      [IMAGE, 'x'.repeat(WIRE_PATH_MAX_CHARS + 1)],
      undefined
    ]) {
      expect(
        response.parse(await row.serve(DESCRIBE_ATTACHMENTS, payload)),
        typeof payload
      ).toEqual([])
    }
    expect(host.calls).toEqual([])
  })

  it('[ADR-019] a Host call error answers [], never a throw, and any other channel is refused', async () => {
    const host = new FakeDescribeHost()
    const row = createDescribeAttachmentsRow(host)
    const response = CHANNELS[DESCRIBE_ATTACHMENTS].response

    host.refusal = { code: 'HOST_NOT_READY', message: 'starting', retryable: true }
    expect(response.parse(await row.serve(DESCRIBE_ATTACHMENTS, [IMAGE]))).toEqual([])
    expect(await row.serve('dwarf:sendText', [IMAGE])).toMatchObject({
      ok: false,
      error: { code: 'METHOD_NOT_FOUND' }
    })
    expect(host.calls).toHaveLength(1)
  })
})
