// L8 OS lane (17 §1.8; ADR-002 D3): `run/host.identity` written by the Node run-file writer carries
// mode 0600 in a 0700 run folder on POSIX. Windows has no file modes (the file inherits the run
// folder's ACL, SP-05), so the case runs on macOS and Linux only.
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HOST_IDENTITY_FILE } from '@dwarfai/contracts'
import { FakeProcessControl } from '../../kernel/fakes/FakeProcessControl'
import { HostIdentityFile } from './hostIdentityFile'
import { NodeRunFileWriter } from './nodeRunFileWriter'

describe.runIf(process.platform !== 'win32')('run/host.identity on POSIX (ADR-002 D3)', () => {
  it('[ADR-002] host.identity is 0600 on POSIX', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dwarfai-031-identity-'))
    try {
      const runDir = join(root, 'run')
      const processes = new FakeProcessControl()
      processes.script(4242, { pid: 4242, processStartTimeMs: 1_000, bootId: 'boot-1' })
      const file = new HostIdentityFile({
        runDir,
        writer: new NodeRunFileWriter(),
        processes,
        pid: 4242,
        epoch: 'epoch-1'
      })

      expect(await file.publish()).toBe('written')

      expect(statSync(join(runDir, HOST_IDENTITY_FILE)).mode & 0o777).toBe(0o600)
      expect(statSync(runDir).mode & 0o777).toBe(0o700)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
