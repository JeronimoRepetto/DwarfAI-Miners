// The spawn gate on disk (ADR-002 D3): `<hostDataDir>/run/spawn.gate`, in a `0700` folder, `0600`.
//
// - create: the content is written to a private temporary file first, then hard-linked to the gate
//   path; a link fails when the path exists, so the gate appears with its whole content in one
//   step and no reader ever sees a half-written gate. Where the volume has no hard links, the gate
//   is created with an exclusive open instead (still exclusive; its content follows at once).
// - removeIf: the gate is renamed aside (atomic), and removed only if the renamed file holds the
//   expected content; otherwise it was another UI's newer gate and is put back with a link, unless a
//   third gate appeared meanwhile.
import { randomUUID } from 'node:crypto'
import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { GateFiles } from './ports'

/** Errors with which a volume refuses hard links (FAT, exFAT, some network shares). */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV', 'EINVAL'])

export class NodeGateFiles implements GateFiles {
  constructor(private readonly path: string) {}

  async create(content: string): Promise<'created' | 'exists'> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temp = this.sibling('tmp')
    await writeFile(temp, content, { mode: 0o600, flag: 'wx' })
    try {
      await link(temp, this.path)
      return 'created'
    } catch (error) {
      if (codeOf(error) === 'EEXIST') return 'exists'
      if (!NO_HARD_LINKS.has(codeOf(error))) throw error
      return this.createExclusive(content)
    } finally {
      await rm(temp, { force: true })
    }
  }

  async read(): Promise<string | null> {
    try {
      return await readFile(this.path, 'utf8')
    } catch (error) {
      if (codeOf(error) === 'ENOENT') return null
      throw error
    }
  }

  async removeIf(content: string): Promise<boolean> {
    const aside = this.sibling('stale')
    try {
      await rename(this.path, aside)
    } catch (error) {
      // Gone already, or held open by another UI's read for a moment (Windows): not removed.
      if (['ENOENT', 'EPERM', 'EBUSY', 'EACCES'].includes(codeOf(error))) return false
      throw error
    }
    try {
      if ((await readFile(aside, 'utf8')) === content) return true
      await link(aside, this.path).catch(() => {})
      return false
    } finally {
      await rm(aside, { force: true })
    }
  }

  private async createExclusive(content: string): Promise<'created' | 'exists'> {
    try {
      await writeFile(this.path, content, { mode: 0o600, flag: 'wx' })
      return 'created'
    } catch (error) {
      if (codeOf(error) === 'EEXIST') return 'exists'
      throw error
    }
  }

  private sibling(kind: 'tmp' | 'stale'): string {
    return `${this.path}.${randomUUID()}.${kind}`
  }
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : ''
}
