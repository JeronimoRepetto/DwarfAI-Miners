// A minimal reader of Electron's asar archives and of the asar integrity records an app carries (ADR-019 item 5;
// spikes S-019-2 and S-008-1). Reads the bytes it is given; no dependency.
//
// Layout of `app.asar`: an 8-byte size pickle (uint32 4, uint32 header pickle size), the header pickle (uint32 payload
// size, uint32 string length, the header JSON, padded to 4 bytes), then the file data. A file entry holds `size` and a
// string `offset` from the start of the data, or `unpacked: true` when it lives in `app.asar.unpacked/`. Electron's
// asar integrity hashes the header JSON string with SHA-256: on macOS the hash sits in Info.plist
// (`ElectronAsarIntegrity`), on Windows electron-builder embeds it in the executable as a JSON resource.
import { createHash } from 'node:crypto'

/** The parsed header of an archive: its JSON string, the parsed tree and where the file data starts. */
export function parseAsarHeader(buffer) {
  if (buffer.length < 16 || buffer.readUInt32LE(0) !== 4) throw new Error('not an asar archive')
  const headerPickleSize = buffer.readUInt32LE(4)
  const stringLength = buffer.readUInt32LE(12)
  const headerString = buffer.subarray(16, 16 + stringLength).toString('utf8')
  return {
    headerString,
    header: JSON.parse(headerString),
    dataOffset: 8 + headerPickleSize
  }
}

/** The bytes needed to parse the header, from the first 16 bytes of an archive. */
export function asarHeaderLength(first16) {
  return 8 + first16.readUInt32LE(4)
}

/** The SHA-256 (hex) of the header JSON string, as Electron's asar integrity computes it. */
export function asarHeaderSha256(headerString) {
  return createHash('sha256').update(headerString).digest('hex')
}

/** Every file of the tree: `{ path, size, offset, unpacked }`, with `/` separators. */
export function listAsarFiles(header) {
  const out = []
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const filePath = prefix === '' ? name : `${prefix}/${name}`
      if (entry.files) walk(entry, filePath)
      else if (!entry.link) {
        out.push({
          path: filePath,
          size: entry.size,
          offset: entry.offset === undefined ? null : Number(entry.offset),
          unpacked: entry.unpacked === true
        })
      }
    }
  }
  walk(header, '')
  return out
}

/** The content of a packed (not unpacked) file of an archive held whole in `buffer`. */
export function readAsarFile(buffer, parsed, filePath) {
  const file = listAsarFiles(parsed.header).find((entry) => entry.path === filePath)
  if (!file || file.unpacked || file.offset === null) throw new Error(`${filePath} is not packed`)
  const start = parsed.dataOffset + file.offset
  return buffer.subarray(start, start + file.size)
}

const PACKAGE_MANIFEST = /(^|\/)node_modules\/(@[^/]+\/)?[^/@][^/]*\/package\.json$/

/** The paths that are a package's own manifest under `node_modules/` (nested ones included). */
export function bundledPackageJsons(paths) {
  return paths.filter((filePath) => PACKAGE_MANIFEST.test(filePath))
}

/** The asar integrity records electron-builder embeds in a Windows executable, or null when it holds none. */
export function findWindowsAsarIntegrity(exe) {
  const marker = Buffer.from('"alg":"SHA256"')
  const at = exe.indexOf(marker)
  if (at === -1) return null
  const start = exe.lastIndexOf(Buffer.from('[{'), at)
  const end = exe.indexOf(Buffer.from('}]'), at)
  if (start === -1 || end === -1 || at - start > 4096 || end - at > 4096) return null
  try {
    return JSON.parse(exe.subarray(start, end + 2).toString('utf8'))
  } catch {
    return null
  }
}

/** The `ElectronAsarIntegrity` entries of a macOS Info.plist (XML), or null when it has none. */
export function readMacAsarIntegrity(plistText) {
  const block = plistText.match(
    /<key>ElectronAsarIntegrity<\/key>\s*<dict>([\s\S]*?<\/dict>)\s*<\/dict>/
  )
  if (!block) return null
  const records = []
  const entry =
    /<key>([^<]+)<\/key>\s*<dict>\s*<key>algorithm<\/key>\s*<string>([^<]+)<\/string>\s*<key>hash<\/key>\s*<string>([^<]+)<\/string>\s*<\/dict>/g
  for (const match of block[1].matchAll(entry)) {
    records.push({ file: match[1], alg: match[2], value: match[3] })
  }
  return records.length > 0 ? records : null
}
