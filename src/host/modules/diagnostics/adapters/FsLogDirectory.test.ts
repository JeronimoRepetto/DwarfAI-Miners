import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe } from 'vitest'
import { runLogDirectoryContract } from '../testing/logDirectory.contract'
import { FsLogDirectory } from './FsLogDirectory'

describe('FsLogDirectory', () => {
  // A fresh temporary root per test, removed afterwards (17 §1.3).
  const roots: string[] = []
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  runLogDirectoryContract(async () => {
    const root = await mkdtemp(join(tmpdir(), 'dwarfai-logdir-'))
    roots.push(root)
    return {
      directoryAt: (path) => new FsLogDirectory(path),
      pathOf: (...segments) => join(root, ...segments),
      seed: async (path, content) => {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, content)
      }
    }
  })
})
