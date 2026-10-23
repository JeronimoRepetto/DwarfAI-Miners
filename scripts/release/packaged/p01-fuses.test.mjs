// layer: L7
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FUSE_SENTINEL } from './fuses.mjs'
import check, { id } from './p01-fuses.packaged.mjs'

// Wire order: RunAsNode, EnableCookieEncryption, EnableNodeOptionsEnvironmentVariable, EnableNodeCliInspectArguments,
// EnableEmbeddedAsarIntegrityValidation, OnlyLoadAppFromAsar, LoadBrowserProcessSpecificV8Snapshot,
// GrantFileProtocolExtraPrivileges, and Electron 44's ninth fuse ('1' enabled, '0' disabled).
const FUSED = '110011000'
const STOCK = '101100000'

/** A fake Electron binary holding the fuse wire `states`, `copies` times (two for a universal macOS binary). */
function binaryWith(states, copies = 1) {
  const wire = Buffer.concat([
    Buffer.from(FUSE_SENTINEL, 'latin1'),
    Buffer.from([1, states.length]),
    Buffer.from(states, 'latin1')
  ])
  return Buffer.concat([
    Buffer.from('binary head'),
    ...Array.from({ length: copies }, () => wire),
    Buffer.from('tail')
  ])
}

let root

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'dwarfai-p01-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function put(relative, bytes) {
  const file = path.join(root, ...relative.split('/'))
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, bytes)
}

const MAC_FRAMEWORK =
  'DwarfAI-Miners.app/Contents/Frameworks/Electron Framework.framework/Electron Framework'

/** The packed apps electron-builder leaves in `release/` on each OS, every binary carrying `wires[os]`. */
async function packedApps(wires = {}) {
  const { win = FUSED, linux = FUSED, mac = FUSED } = wires
  await put('win-unpacked/DwarfAI-Miners.exe', binaryWith(win))
  await put('win-unpacked/ffmpeg.dll', Buffer.from('no wire'))
  await put('linux-unpacked/dwarfai-miners', binaryWith(linux))
  await put('linux-unpacked/chrome-sandbox', Buffer.from('no wire'))
  await put('linux-unpacked/libffmpeg.so', binaryWith(STOCK))
  await put(`mac-arm64/${MAC_FRAMEWORK}`, binaryWith(mac))
  await put(`mac/${MAC_FRAMEWORK}`, binaryWith(mac, 2))
}

describe('P-01 fuse read-back (ADR-019 item 5; 20 §2.3)', () => {
  it('[ADR-019, S-019-2] passes when the fuses of every packed app equal its target recorded set, and names the known limits', async () => {
    await packedApps()
    const result = await check({ artifactDir: root })
    expect(id).toBe('P-01')
    expect(result.ok, result.detail).toBe(true)
    expect(result.detail).toMatch(/^4 packed apps/)
    for (const where of [
      'win-unpacked/DwarfAI-Miners.exe',
      'linux-unpacked/dwarfai-miners',
      `mac-arm64/${MAC_FRAMEWORK}`,
      `mac/${MAC_FRAMEWORK}`
    ]) {
      expect(result.detail).toContain(where)
    }
    // A shared library holding a wire beside the Linux executable is not a packed app's binary.
    expect(result.detail).not.toContain('libffmpeg.so')
    expect(result.detail).toMatch(/known limit linux: EnableEmbeddedAsarIntegrityValidation/)
  })

  it('[ADR-019, S-019-2] a target whose fuses did not flip fails, naming the app, each fuse and its expected and actual state', async () => {
    await packedApps({ win: STOCK })
    const result = await check({ artifactDir: root })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain(
      'win-unpacked/DwarfAI-Miners.exe (win32): EnableCookieEncryption expected enabled, found disabled'
    )
    for (const fuse of [
      'EnableNodeOptionsEnvironmentVariable expected disabled, found enabled',
      'EnableNodeCliInspectArguments expected disabled, found enabled',
      'EnableEmbeddedAsarIntegrityValidation expected enabled, found disabled',
      'OnlyLoadAppFromAsar expected enabled, found disabled'
    ]) {
      expect(result.detail).toContain(fuse)
    }
    expect(result.detail).not.toContain('linux-unpacked')
  })

  it('[ADR-019] a packed app with RunAsNode turned off fails, since the Host runs the app executable as Node', async () => {
    await packedApps({ linux: '010011000' })
    const result = await check({ artifactDir: root })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain(
      'linux-unpacked/dwarfai-miners (linux): RunAsNode expected enabled, found disabled'
    )
  })

  it('[S-019-2] an app with no fuse wire, a universal binary whose slices disagree, or no packed app at all fails', async () => {
    await put('win-unpacked/DwarfAI-Miners.exe', Buffer.from('no wire here'))
    const noWire = await check({ artifactDir: root })
    expect(noWire.ok).toBe(false)
    expect(noWire.detail).toContain('win-unpacked: no Electron binary with a fuse wire')

    await rm(path.join(root, 'win-unpacked'), { recursive: true })
    const universal = Buffer.concat([binaryWith(FUSED), binaryWith(STOCK)])
    await put(`mac-universal/${MAC_FRAMEWORK}`, universal)
    const disagree = await check({ artifactDir: root })
    expect(disagree.ok).toBe(false)
    expect(disagree.detail).toContain(`mac-universal/${MAC_FRAMEWORK} (darwin): slices disagree`)

    await rm(path.join(root, 'mac-universal'), { recursive: true })
    const empty = await check({ artifactDir: root })
    expect(empty).toEqual({ ok: false, detail: `no packed app in ${root}` })
  })
})
