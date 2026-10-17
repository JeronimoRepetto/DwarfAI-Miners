import { describe } from 'vitest'
import { FakeFs } from '../../../kernel/fakes/FakeFs'
import { runAttachmentReaderContract } from './attachmentReader.contract'
import { FakeAttachmentReader } from './FakeAttachmentReader'

// The double runs the same contract as FsAttachmentReader (17 §1.3), over FakeFs paths.
describe('FakeAttachmentReader', () => {
  runAttachmentReaderContract('FakeAttachmentReader over FakeFs', () => {
    const fs = new FakeFs()
    const reader = new FakeAttachmentReader(fs)
    const ROOT = '/picked'
    return {
      reader,
      file: async (name, bytes) => {
        const path = `${ROOT}/${name}`
        fs.addFile(path, '')
        reader.declareSize(path, bytes)
        return path
      },
      directory: async (name) => {
        const path = `${ROOT}/${name}`
        await fs.makeDir(path)
        return path
      },
      missing: (name) => `${ROOT}/${name}`,
      unreadable: async (name) => {
        const path = `${ROOT}/${name}`
        fs.addFile(path, 'secret')
        fs.scriptFault(path, 'EACCES')
        return path
      },
      real: async (path) => path,
      dispose: () => undefined
    }
  })
})
