// layer: L7
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  asarHeaderSha256,
  bundledPackageJsons,
  findWindowsAsarIntegrity,
  listAsarFiles,
  parseAsarHeader,
  readAsarFile,
  readMacAsarIntegrity
} from './asar.mjs'

/** An archive in the asar layout: a size pickle, the header pickle (JSON string, 4-byte aligned), then the data. */
function archive(files) {
  const tree = { files: {} }
  const chunks = []
  let offset = 0
  for (const [filePath, content] of Object.entries(files)) {
    const parts = filePath.split('/')
    let node = tree
    for (const dir of parts.slice(0, -1)) node = node.files[dir] ??= { files: {} }
    if (content === null) {
      node.files[parts.at(-1)] = { size: 3, unpacked: true }
      continue
    }
    const data = Buffer.from(content)
    node.files[parts.at(-1)] = { size: data.length, offset: String(offset) }
    chunks.push(data)
    offset += data.length
  }
  const json = Buffer.from(JSON.stringify(tree))
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4)
  json.copy(padded)
  const headerPickle = Buffer.alloc(8 + padded.length)
  headerPickle.writeUInt32LE(4 + padded.length, 0)
  headerPickle.writeUInt32LE(json.length, 4)
  padded.copy(headerPickle, 8)
  const sizePickle = Buffer.alloc(8)
  sizePickle.writeUInt32LE(4, 0)
  sizePickle.writeUInt32LE(headerPickle.length, 4)
  return { buffer: Buffer.concat([sizePickle, headerPickle, ...chunks]), json: json.toString() }
}

describe('asar reader (ADR-019 item 5; S-019-2, S-008-1)', () => {
  const { buffer, json } = archive({
    'package.json': '{"name":"app"}',
    'node_modules/zod/package.json': '{"name":"zod","version":"4.1.0"}',
    'node_modules/@scope/lib/package.json': '{"name":"@scope/lib","version":"1.0.0"}',
    'node_modules/@scope/lib/node_modules/inner/package.json': '{"name":"inner"}',
    'node_modules/zod/lib/package.json': '{"type":"module"}',
    'node_modules/native/package.json': null
  })

  it('[S-019-2] parses the header and hashes its JSON string the way Electron asar integrity does', () => {
    const header = parseAsarHeader(buffer)
    expect(header.headerString).toBe(json)
    expect(asarHeaderSha256(header.headerString)).toBe(
      createHash('sha256').update(json).digest('hex')
    )
  })

  it('[S-008-1] lists every file with its unpacked flag and reads a packed file', () => {
    const header = parseAsarHeader(buffer)
    const files = listAsarFiles(header.header)
    expect(files.map((file) => file.path)).toContain('node_modules/zod/package.json')
    expect(files.find((file) => file.path === 'node_modules/native/package.json')?.unpacked).toBe(
      true
    )
    expect(readAsarFile(buffer, header, 'node_modules/zod/package.json').toString()).toBe(
      '{"name":"zod","version":"4.1.0"}'
    )
  })

  it('[S-008-1] keeps the package manifests of node_modules, nested ones included, and skips inner package.json files', () => {
    const paths = listAsarFiles(parseAsarHeader(buffer).header).map((file) => file.path)
    expect(bundledPackageJsons(paths).sort()).toEqual([
      'node_modules/@scope/lib/node_modules/inner/package.json',
      'node_modules/@scope/lib/package.json',
      'node_modules/native/package.json',
      'node_modules/zod/package.json'
    ])
  })

  it('[S-019-2] finds the integrity record electron-builder embeds in a Windows executable', () => {
    const record = '[{"file":"resources\\\\app.asar","alg":"SHA256","value":"abc123"}]'
    const exe = Buffer.concat([
      Buffer.from('MZ\0\0junk'),
      Buffer.from(record),
      Buffer.from('\0more')
    ])
    expect(findWindowsAsarIntegrity(exe)).toEqual([
      { file: 'resources\\app.asar', alg: 'SHA256', value: 'abc123' }
    ])
    expect(findWindowsAsarIntegrity(Buffer.from('MZ nothing'))).toBeNull()
  })

  it('[S-019-2] reads the ElectronAsarIntegrity entry of a macOS Info.plist', () => {
    const plist = `<plist><dict><key>CFBundleName</key><string>App</string>
      <key>ElectronAsarIntegrity</key><dict><key>Resources/app.asar</key><dict>
      <key>algorithm</key><string>SHA256</string><key>hash</key><string>def456</string></dict></dict></dict></plist>`
    expect(readMacAsarIntegrity(plist)).toEqual([
      { file: 'Resources/app.asar', alg: 'SHA256', value: 'def456' }
    ])
    expect(readMacAsarIntegrity('<plist><dict></dict></plist>')).toBeNull()
  })
})
