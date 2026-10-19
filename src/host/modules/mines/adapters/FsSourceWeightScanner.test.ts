// L3 (17 §1.3): the real adapter runs the same conformance suite as FakeSourceWeightScanner, over
// a small tree in a fresh temporary folder per case, walked by its worker.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe } from 'vitest'
import type { FolderPath } from '../../../kernel/domain/values'
import { runSourceWeightScannerContract } from '../testing/sourceWeightScanner.contract'
import { FsSourceWeightScanner } from './FsSourceWeightScanner'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('FsSourceWeightScanner', () => {
  runSourceWeightScannerContract('FsSourceWeightScanner over a temporary folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dwarfai-weight-'))
    roots.push(root)
    return {
      scanner: new FsSourceWeightScanner(),
      root,
      at: (...segments) => join(root, ...segments) as FolderPath,
      write: async (relative, bytes) => {
        const path = join(root, ...relative.split('/'))
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, `${relative}\n`.padEnd(bytes, 'x'))
      }
    }
  })
})
