// L8 OS lane (17 §1.8; 18 C-17, T-35; ADR-019 item 9): `FsAttachmentReader` over the real
// `NodeAttachmentProbe`, on the real disk of each OS. A symlink whose target leaves its folder is
// refused while one inside it is accepted by its real path; a device and a FIFO are refused without
// being opened (a FIFO with no writer would block an open forever, so a refusal that comes back at
// all proves nothing opened it); on Windows a UNC share, the device namespace and a named pipe are
// refused before the disk is asked. Runs only in `pnpm test:os`.
//
// TC-169-02.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { createQueryRunner } from '../../../../platform/process/NodeProcessControl'
import { FsAttachmentReader } from './FsAttachmentReader'
import { NodeAttachmentProbe } from './NodeAttachmentProbe'

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dwarfai-169-os-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const reader = (): FsAttachmentReader =>
  new FsAttachmentReader({ platform: process.platform, probe: new NodeAttachmentProbe() })

/** A folder the person picks from, a secret outside it, and two links: one out, one in. */
function links(dir: string) {
  const picked = join(dir, 'picked')
  mkdirSync(join(picked, 'sub'), { recursive: true })
  const secret = join(dir, 'secret.txt')
  writeFileSync(secret, 'outside the folder')
  const inside = join(picked, 'sub', 'real.txt')
  writeFileSync(inside, 'inside')
  const escape = join(picked, 'escape.txt')
  const near = join(picked, 'near.txt')
  symlinkSync(secret, escape, 'file')
  symlinkSync(inside, near, 'file')
  return { escape, near, inside }
}

describe.runIf(process.platform === 'linux' || process.platform === 'darwin')(
  'FsAttachmentReader on a POSIX disk',
  () => {
    it('[ADR-019] a symlink leaving its folder, a device, a FIFO and on Windows a UNC path are refused', async () => {
      const dir = root()
      const { escape, near, inside } = links(dir)
      const fifo = join(dir, 'pipe')
      // The FIFO is made by the platform's one query runner (R17: no child_process here).
      expect(await createQueryRunner()('mkfifo', [fifo], { timeoutMs: 5_000 })).toMatchObject({
        ok: true
      })

      expect(await reader().describe(escape)).toStrictEqual({ refused: 'unreadable' })
      expect(await reader().describe(near)).toStrictEqual({
        path: near,
        attachment: { path: realpathSync.native(inside), name: 'near.txt', kind: 'file', bytes: 6 }
      })
      expect(await reader().describe('/dev/null')).toStrictEqual({ refused: 'not-a-file' })
      expect(await reader().describe(fifo)).toStrictEqual({ refused: 'not-a-file' })
    })
  }
)

describe.runIf(process.platform === 'win32')('FsAttachmentReader on a Windows disk', () => {
  it('[ADR-019] a symlink leaving its folder, a device, a FIFO and on Windows a UNC path are refused', async () => {
    const dir = root()
    const { escape, near, inside } = links(dir)
    const share = `\\\\localhost\\${realpathSync.native(dir).replace(/^([A-Za-z]):/, '$1$')}\\picked\\sub\\real.txt`

    expect(await reader().describe(escape)).toStrictEqual({ refused: 'unreadable' })
    expect(await reader().describe(near)).toStrictEqual({
      path: near,
      attachment: { path: realpathSync.native(inside), name: 'near.txt', kind: 'file', bytes: 6 }
    })
    // The device namespace and a named pipe (the Windows FIFO), and a UNC share: never asked.
    expect(await reader().describe('\\\\.\\NUL')).toStrictEqual({ refused: 'unreadable' })
    expect(await reader().describe('\\\\.\\pipe\\dwarfai-169')).toStrictEqual({
      refused: 'unreadable'
    })
    expect(await reader().describe(share)).toStrictEqual({ refused: 'unreadable' })
  })
})
