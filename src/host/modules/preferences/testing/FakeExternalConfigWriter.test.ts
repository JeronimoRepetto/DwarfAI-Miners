import { describe, expect, it } from 'vitest'
import { FakeExternalConfigWriter } from '../ports/fakes/FakeExternalConfigWriter'
import type { ChannelToken } from '../ports/externalConfigWriter'
import { runExternalConfigWriterContract } from './externalConfigWriter.contract'

// The double runs the same port-level suite as the config writer engine (17 §1.3; 16 §7.5).
describe('FakeExternalConfigWriter', () => {
  runExternalConfigWriterContract(() => {
    const writer = new FakeExternalConfigWriter()
    return {
      writer,
      target: 'claude-hooks',
      lock: (locked) => writer.lock('claude-hooks', locked),
      plantLegacy: () => writer.plantLegacy('claude-hooks')
    }
  })

  it('[S14.04] a scripted install outcome is returned once, and nothing is installed', async () => {
    const writer = new FakeExternalConfigWriter()
    writer.scriptInstall('opencode-plugin', 'concurrent-modification')

    expect(await writer.install('opencode-plugin', 't' as ChannelToken, 'add-panel')).toStrictEqual(
      {
        ok: false,
        error: 'concurrent-modification'
      }
    )
    expect(writer.installed('opencode-plugin')).toBe(false)
    expect(writer.installs).toStrictEqual([{ target: 'opencode-plugin', origin: 'add-panel' }])

    expect((await writer.install('opencode-plugin', 't' as ChannelToken, 'add-panel')).ok).toBe(
      true
    )
    expect(writer.installed('opencode-plugin')).toBe(true)
  })
})
