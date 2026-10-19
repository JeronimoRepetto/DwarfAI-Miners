// The double runs the same conformance suite as FsSourceWeightScanner (16 §2.8, 17 §1.3), over a
// tree planted in a FakeFs under a synthetic root (privacy-guard), on every host.
import { describe } from 'vitest'
import type { FolderPath } from '../../../kernel/domain/values'
import { FakeFs } from '../../../kernel/fakes/FakeFs'
import { FakeSourceWeightScanner } from '../ports/fakes/FakeSourceWeightScanner'
import { runSourceWeightScannerContract } from './sourceWeightScanner.contract'

const ROOT = 'C:\\work\\mine'

describe('FakeSourceWeightScanner', () => {
  runSourceWeightScannerContract('FakeSourceWeightScanner over FakeFs', async () => {
    const fs = new FakeFs()
    await fs.makeDir(ROOT)
    const scanner = new FakeSourceWeightScanner(fs)
    return {
      scanner,
      root: ROOT,
      at: (...segments) => [ROOT, ...segments].join('\\') as FolderPath,
      write: async (relative, bytes) =>
        fs.addFile([ROOT, ...relative.split('/')].join('\\'), `${relative}\n`.padEnd(bytes, 'x')),
      hold: () => scanner.hold()
    }
  })
})
