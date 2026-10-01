import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSteps } from './build-win-pipe.mjs'

// L1: the commands that build the Host's owner-only pipe helper. The built binary itself is checked
// in the Windows OS lane (nativeOwnerOnlyPipe.os.test.ts: no VC++ runtime import).

const options = {
  headersDir: path.join('h', 'include'),
  defFile: path.join('h', 'def', 'node_api.def'),
  workDir: 'w',
  outFile: path.join('prebuilds', 'win32-x64', 'dwarfai_win_pipe.node')
}

describe('build-win-pipe', () => {
  it('[ADR-003] the helper links the static C runtime and no VC++ redistributable', () => {
    const [, compile] = buildSteps({ arch: 'x64', ...options })

    expect(compile?.args).toContain('/MT')
    expect(compile?.args.some((arg) => /^\/MDd?$/.test(arg))).toBe(false)
  })

  it('[ADR-003] the import library names node.exe and the link delays it, so the binary also loads in Electron', () => {
    const [lib, , link] = buildSteps({ arch: 'x64', ...options })

    expect(lib?.args).toContain(`/def:${options.defFile}`)
    expect(link?.args).toContain('/DELAYLOAD:node.exe')
    expect(link?.args).toContain('delayimp.lib')
  })

  it('[ADR-003] x64 and arm64 build for their own machine type', () => {
    const x64 = buildSteps({ arch: 'x64', ...options })
    const arm64 = buildSteps({ arch: 'arm64', ...options })

    expect(x64[0]?.args).toContain('/machine:X64')
    expect(x64[2]?.args).toContain('/MACHINE:X64')
    expect(arm64[0]?.args).toContain('/machine:ARM64')
    expect(arm64[2]?.args).toContain('/MACHINE:ARM64')
    // CET shadow stacks exist on x64 only.
    expect(x64[2]?.args).toContain('/CETCOMPAT')
    expect(arm64[2]?.args).not.toContain('/CETCOMPAT')
    expect(() => buildSteps({ arch: 'ia32', ...options })).toThrow('unsupported architecture: ia32')
  })
})
