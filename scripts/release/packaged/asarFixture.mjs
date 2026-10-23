// Test support for the packaged checks: writes an asar archive the way @electron/asar lays it out (an 8-byte size
// pickle holding the header pickle's length, the header pickle holding the JSON string, then the file data), so a
// check reads a fixture the way it reads electron-builder's `app.asar`. Not a check: the runner discovers only
// `p<nn>-<name>.packaged.mjs`.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** The bytes of an archive holding `files` (`{ 'a/b.txt': 'content' }`); a `null` content is an unpacked entry. */
export function asarBytes(files) {
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
  return Buffer.concat([sizePickle, headerPickle, ...chunks])
}

/** Writes the archive of `files` at `file`, making its folder. */
export function writeAsar(file, files) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, asarBytes(files))
}
