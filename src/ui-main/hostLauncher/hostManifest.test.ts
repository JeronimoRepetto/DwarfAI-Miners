// The build manifest of the app directory the Host's versioned copy is made from (ADR-002 D5:
// `host-manifest.json`, file list + SHA-256; lead decision 2026-09-30 in ISSUE-031). L3-style over a
// temporary directory: the functions exist to read real files.
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildManifest,
  HOST_MANIFEST_FORMAT,
  parseManifest,
  serializeManifest,
  verifyManifest
} from './hostManifest'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** An app directory: an executable, a resources folder and a nested file. */
function appDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dwarfai-031-manifest-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'app.exe'), 'executable bytes')
  mkdirSync(join(dir, 'resources', 'app'), { recursive: true })
  writeFileSync(join(dir, 'resources', 'app.asar'), 'archive bytes')
  writeFileSync(join(dir, 'resources', 'app', 'main.js'), 'entry')
  return dir
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

describe('host-manifest.json (ADR-002 D5)', () => {
  it('[ADR-002] the manifest lists every file of the directory, by relative path with / separators, with its size and SHA-256, sorted by path', async () => {
    const dir = appDir()

    const manifest = await buildManifest(dir)

    expect(manifest).toEqual({
      format: HOST_MANIFEST_FORMAT,
      entries: [
        { path: 'app.exe', kind: 'file', size: 16, sha256: sha256('executable bytes') },
        { path: 'resources/app.asar', kind: 'file', size: 13, sha256: sha256('archive bytes') },
        { path: 'resources/app/main.js', kind: 'file', size: 5, sha256: sha256('entry') }
      ]
    })
  })

  it('[ADR-002] a path given as excluded is left out, so a manifest stored inside the directory never lists itself', async () => {
    const dir = appDir()
    writeFileSync(join(dir, 'resources', 'host-manifest.json'), '{}')

    const manifest = await buildManifest(dir, { exclude: ['resources/host-manifest.json'] })

    expect(manifest.entries.map((entry) => entry.path)).toEqual([
      'app.exe',
      'resources/app.asar',
      'resources/app/main.js'
    ])
  })

  it('[ADR-002, FM-129] verification accepts an identical directory and refuses a changed, a missing or an extra file', async () => {
    const dir = appDir()
    const manifest = await buildManifest(dir)
    expect(await verifyManifest(dir, manifest)).toEqual({ ok: true })

    writeFileSync(join(dir, 'resources', 'app.asar'), 'archive byteZ')
    expect(await verifyManifest(dir, manifest)).toEqual({ ok: false, reason: 'mismatch' })
    writeFileSync(join(dir, 'resources', 'app.asar'), 'archive bytes')

    rmSync(join(dir, 'app.exe'))
    expect(await verifyManifest(dir, manifest)).toEqual({ ok: false, reason: 'mismatch' })
    writeFileSync(join(dir, 'app.exe'), 'executable bytes')

    writeFileSync(join(dir, 'planted.dll'), 'extra')
    expect(await verifyManifest(dir, manifest)).toEqual({ ok: false, reason: 'mismatch' })
  })

  it('[ADR-002] a serialized manifest parses back to itself; a manifest of another format, a path that leaves the directory or a malformed hash is refused', async () => {
    const manifest = await buildManifest(appDir())
    expect(parseManifest(serializeManifest(manifest))).toEqual({ ok: true, value: manifest })

    const file = { path: 'a', kind: 'file', size: 1, sha256: sha256('a') }
    const refused = [
      'not json',
      JSON.stringify({ format: 2, entries: [] }),
      JSON.stringify({ format: 1, entries: [{ ...file, path: '../outside' }] }),
      JSON.stringify({ format: 1, entries: [{ ...file, path: '/abs' }] }),
      JSON.stringify({ format: 1, entries: [{ ...file, path: 'C:\\abs' }] }),
      JSON.stringify({ format: 1, entries: [{ ...file, sha256: 'XYZ' }] }),
      JSON.stringify({ format: 1, entries: [{ ...file, size: -1 }] }),
      JSON.stringify({ format: 1, entries: [{ ...file, extra: true }] })
    ]
    for (const text of refused) expect(parseManifest(text), text).toEqual({ ok: false })
  })
})
