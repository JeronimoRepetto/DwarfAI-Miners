// L8 Windows (17 §1.8): `currentUserSid` of the native helper, built (`pnpm build:native`) and
// loaded in this process, against what Windows' own `whoami /user` of System32 prints, which is the
// read the Host names its endpoints with (nodeEndpointEnv.ts). The relay reads the SID natively so it
// starts no process (owner-approved 2026-10-15, ISSUE-200; ADR-013 item 3).
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createQueryRunner } from '../../process/NodeProcessControl'
import { windowsSystemTool } from '../../process/probe/types'
import { createNativeUserSid } from './nativeUserSid'

const PREBUILDS = fileURLToPath(new URL('../../../../../prebuilds', import.meta.url))

describe.runIf(process.platform === 'win32')('the native user SID on Windows', () => {
  it('[ADR-013] the native read answers the same SID as whoami /user, with no process started', async () => {
    const out = await createQueryRunner()(
      windowsSystemTool('whoami.exe', process.env),
      ['/user', '/fo', 'csv', '/nh'],
      { timeoutMs: 10_000 }
    )
    if (!out.ok) throw new Error(`whoami failed: ${out.cause}`)
    const expected = /"(S-1-\d+(?:-\d+)+)"\s*$/m.exec(out.stdout)?.[1]

    expect(createNativeUserSid({ prebuildsDir: PREBUILDS })()).toEqual({
      ok: true,
      value: expected
    })
  })
})
