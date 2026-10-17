// L3 (17 §1.3): `FsAttachmentReader` over the real `NodeAttachmentProbe` runs the same
// runAttachmentReaderContract as `FakeAttachmentReader`, in a per-test temp folder (the 300 MB
// files are sparse: `truncate` sets their size, no byte is written). The per-OS path rules
// (18 C-17, T-35; ADR-019 item 9) are then proven for every platform against a scripted probe,
// so a Windows rule is checked on every OS; their real-disk half is FsAttachmentReader.os.test.ts.
//
// TC-169-01, TC-169-02 (the rules).
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runAttachmentReaderContract } from '../../testing/attachmentReader.contract'
import {
  FsAttachmentReader,
  type AttachmentEntry,
  type AttachmentFileProbe
} from './FsAttachmentReader'
import { NodeAttachmentProbe } from './NodeAttachmentProbe'

describe('FsAttachmentReader', () => {
  runAttachmentReaderContract('FsAttachmentReader over a temp folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'dwarfai-169-attach-'))
    const denied: string[] = []
    return {
      reader: new FsAttachmentReader({
        platform: process.platform,
        probe: new NodeAttachmentProbe()
      }),
      file: async (name, bytes) => {
        const path = join(root, name)
        writeFileSync(path, '')
        truncateSync(path, bytes)
        return path
      },
      directory: async (name) => {
        const path = join(root, name)
        mkdirSync(path)
        return path
      },
      missing: (name) => join(root, name),
      unreadable: async (name) => {
        // Windows has no POSIX mode to deny a read, and root reads everything.
        if (process.platform === 'win32' || process.getuid?.() === 0) return null
        const path = join(root, name)
        writeFileSync(path, 'secret')
        chmodSync(path, 0o000)
        denied.push(path)
        return path
      },
      real: async (path) => realpathSync.native(path),
      dispose: () => {
        for (const path of denied) chmodSync(path, 0o600)
        rmSync(root, { recursive: true, force: true })
      }
    }
  })
})

/** A disk the test writes: each path's own entry (links not followed) and its real path. */
class ScriptedProbe implements AttachmentFileProbe {
  readonly asked: string[] = []
  private readonly entries = new Map<string, AttachmentEntry>()
  private readonly reals = new Map<string, string>()
  private readonly denied = new Set<string>()

  file(path: string, bytes: number): this {
    this.entries.set(path, { kind: 'file', bytes })
    this.reals.set(path, path)
    return this
  }

  folder(path: string): this {
    this.entries.set(path, { kind: 'directory', bytes: 0 })
    this.reals.set(path, path)
    return this
  }

  other(path: string): this {
    this.entries.set(path, { kind: 'other', bytes: 0 })
    this.reals.set(path, path)
    return this
  }

  link(path: string, target: string): this {
    this.entries.set(path, { kind: 'symlink', bytes: 0 })
    this.reals.set(path, this.reals.get(target) ?? target)
    return this
  }

  /** A path the OS resolves elsewhere with no link of its own (a mapped drive, a short name). */
  resolvesTo(path: string, real: string): this {
    this.entries.set(path, { kind: 'file', bytes: 1 })
    this.reals.set(path, real)
    return this
  }

  deny(path: string): this {
    this.denied.add(path)
    return this
  }

  async realpath(path: string): Promise<string | null> {
    this.asked.push(`realpath ${path}`)
    return this.reals.get(path) ?? null
  }

  async entry(path: string): Promise<AttachmentEntry | null> {
    this.asked.push(`entry ${path}`)
    return this.entries.get(path) ?? null
  }

  async readable(path: string): Promise<boolean> {
    this.asked.push(`readable ${path}`)
    return !this.denied.has(path)
  }
}

describe('FsAttachmentReader path rules (18 C-17, T-35)', () => {
  it('[ADR-019] on Windows a UNC or device-namespace path is unreadable and the disk is never asked', async () => {
    const probe = new ScriptedProbe()
    const reader = new FsAttachmentReader({ platform: 'win32', probe })

    for (const path of [
      '\\\\server\\share\\notes.txt',
      '//server/share/notes.txt',
      '\\\\?\\C:\\work\\notes.txt',
      '\\\\.\\pipe\\dwarfai',
      '\\\\.\\PhysicalDrive0'
    ]) {
      expect(await reader.describe(path), path).toStrictEqual({ refused: 'unreadable' })
    }
    expect(probe.asked).toEqual([])
  })

  it('[ADR-019] on Windows a path whose real path is a UNC path is unreadable and never checked further', async () => {
    const probe = new ScriptedProbe()
      .folder('Z:\\')
      .resolvesTo('Z:\\notes.txt', '\\\\server\\share\\notes.txt')
    const reader = new FsAttachmentReader({ platform: 'win32', probe })

    expect(await reader.describe('Z:\\notes.txt')).toStrictEqual({ refused: 'unreadable' })
    // Nothing is asked of the share itself: not its entry, not whether it can be read.
    expect(probe.asked).toEqual(['entry Z:\\notes.txt', 'realpath Z:\\notes.txt'])
  })

  it('[ADR-019] a symlink whose target leaves its folder is unreadable, one inside it is described by its real path', async () => {
    for (const [platform, folder, outside] of [
      ['linux', '/home/p/picked', '/home/p/.ssh/id_ed25519'],
      ['darwin', '/Users/p/picked', '/etc/master.passwd'],
      ['win32', 'C:\\Users\\p\\picked', 'C:\\Users\\p\\AppData\\secret.txt']
    ] as const) {
      const sep = platform === 'win32' ? '\\' : '/'
      const inside = `${folder}${sep}sub${sep}real.txt`
      const probe = new ScriptedProbe()
        .folder(folder)
        .file(outside, 10)
        .file(inside, 7)
        .link(`${folder}${sep}escape.txt`, outside)
        .link(`${folder}${sep}near.txt`, inside)
      const reader = new FsAttachmentReader({ platform, probe })

      expect(await reader.describe(`${folder}${sep}escape.txt`), platform).toStrictEqual({
        refused: 'unreadable'
      })
      expect(probe.asked, platform).not.toContain(`readable ${outside}`)
      expect(await reader.describe(`${folder}${sep}near.txt`), platform).toStrictEqual({
        path: `${folder}${sep}near.txt`,
        attachment: { path: inside, name: 'near.txt', kind: 'file', bytes: 7 }
      })
    }
  })

  it('[ADR-019] on Windows the folder check ignores case, as the volume does', async () => {
    const probe = new ScriptedProbe()
      .folder('C:\\Users\\p\\Picked')
      .file('c:\\users\\P\\picked\\real.txt', 4)
      .link('C:\\Users\\p\\Picked\\near.txt', 'c:\\users\\P\\picked\\real.txt')
    const reader = new FsAttachmentReader({ platform: 'win32', probe })

    expect(await reader.describe('C:\\Users\\p\\Picked\\near.txt')).toMatchObject({
      attachment: { path: 'c:\\users\\P\\picked\\real.txt', bytes: 4 }
    })
  })

  it('[ADR-019] a FIFO, a device or a socket is not-a-file and is never opened', async () => {
    const probe = new ScriptedProbe().folder('/dev').other('/dev/null').other('/tmp/fifo')
    const reader = new FsAttachmentReader({ platform: 'linux', probe })

    expect(await reader.describe('/dev/null')).toStrictEqual({ refused: 'not-a-file' })
    expect(await reader.describe('/tmp/fifo')).toStrictEqual({ refused: 'not-a-file' })
    expect(probe.asked.filter((call) => call.startsWith('readable'))).toEqual([])
  })

  it('[ADR-019] a regular file the Host may not open is unreadable', async () => {
    const probe = new ScriptedProbe().file('/home/p/locked.txt', 5).deny('/home/p/locked.txt')
    const reader = new FsAttachmentReader({ platform: 'linux', probe })

    expect(await reader.describe('/home/p/locked.txt')).toStrictEqual({ refused: 'unreadable' })
  })
})
