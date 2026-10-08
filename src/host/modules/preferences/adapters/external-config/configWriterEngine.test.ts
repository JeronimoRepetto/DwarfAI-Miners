import { describe } from 'vitest'
import { FakeFs } from '../../../../kernel/fakes/FakeFs'
import type { FileSystemSubject } from '../../../../kernel/testing/fileSystem.contract'
import {
  engineWorld,
  runConfigWriterEngineContract,
  runExternalConfigWriterContract
} from '../../testing/externalConfigWriter.contract'
import { syntheticLegacyEntry } from '../../testing/syntheticConfigTarget'

// L3 (17 §1.3): the config writer engine with the synthetic target over FakeFs and a copy of the
// template database; `configWriterEngine.disk.test.ts` runs the same suites over NodeFs.
function memory(): FileSystemSubject {
  const fs = new FakeFs()
  return {
    fs,
    pathOf: (...segments) => ['/home/j', ...segments].join('/'),
    seed: async (path, content) => fs.addFile(path, content)
  }
}

describe('ConfigWriterEngine over FakeFs', () => {
  runConfigWriterEngineContract(memory)

  runExternalConfigWriterContract(async () => {
    const w = await engineWorld(memory())
    return {
      writer: w.writer,
      target: 'opencode-plugin',
      lock: (locked) => w.fs.lock(w.path, locked),
      plantLegacy: () => w.seed(`x=1\n${syntheticLegacyEntry('old-token')}\n`)
    }
  })
})
