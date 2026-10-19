import { describe, expect, it } from 'vitest'
import { runFileSystemContract, runFileSystemFaultContract } from '../testing/fileSystem.contract'
import { FakeFs } from './FakeFs'

describe('FakeFs', () => {
  const makeSubject = (): {
    fs: FakeFs
    pathOf: (...segments: string[]) => string
    seed: (path: string, content: string) => Promise<void>
    scriptFault: FakeFs['scriptFault']
  } => {
    const fs = new FakeFs()
    return {
      fs,
      pathOf: (...segments) => ['/fake-root', ...segments].join('/'),
      seed: async (path, content) => fs.addFile(path, content),
      scriptFault: (path, fault) => fs.scriptFault(path, fault)
    }
  }

  runFileSystemContract(makeSubject)
  runFileSystemFaultContract(makeSubject)

  it('[CH-11] a crash scripted part-way through an in-place write leaves only the bytes that landed', async () => {
    const fs = new FakeFs()
    const target = '/fake-root/tool/settings.ini'
    fs.addFile(target, 'the previous content')
    fs.scriptInPlaceCrash(target, 4)

    await expect(fs.writeFileInPlace(target, 'next content')).rejects.toThrow(
      'FakeFs: simulated crash'
    )
    const partial = await fs.readFile(target)
    expect(partial.ok && Buffer.from(partial.value).toString('utf8')).toBe('next')

    // One crash only: the next in-place write lands whole.
    await expect(fs.writeFileInPlace(target, 'next content')).resolves.toEqual({
      ok: true,
      value: undefined
    })
    const whole = await fs.readFile(target)
    expect(whole.ok && Buffer.from(whole.value).toString('utf8')).toBe('next content')
  })
})
