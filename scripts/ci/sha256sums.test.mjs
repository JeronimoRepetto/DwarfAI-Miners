// layer: L7
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  formatSha256Sums,
  parseSha256Sums,
  SUMS_FILE,
  verifySha256Sums,
  writeSha256Sums
} from './sha256sums.mjs'

// The checksum file of an internal build (.github/workflows/internal-build.yml): the packaging leg writes it next to
// its installers, and scripts/ci/fetch-internal-build.mjs verifies the downloaded artifact against it before it
// deletes the artifact from GitHub (20 §3.2 `SHA256SUMS`).

const sha = (text) => createHash('sha256').update(text).digest('hex')

let dir
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sha256sums-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('SHA256SUMS', () => {
  it('[ADR-027] formats one "<hash>  <name>" line per file, sorted by name, in the sha256sum text format', () => {
    expect(
      formatSha256Sums([
        { name: 'b.deb', hash: sha('b') },
        { name: 'a.AppImage', hash: sha('a') }
      ])
    ).toBe(`${sha('a')}  a.AppImage\n${sha('b')}  b.deb\n`)
  })

  it('[ADR-027] parses what it formats, accepts the binary-mode marker and reports a malformed line', () => {
    const text = `${sha('a')}  a.exe\r\n${sha('b')} *b.exe\nnot a checksum line\n\n`
    const parsed = parseSha256Sums(text)
    expect(parsed.entries).toEqual([
      { name: 'a.exe', hash: sha('a') },
      { name: 'b.exe', hash: sha('b') }
    ])
    expect(parsed.problems).toEqual(['line 3 is not "<sha256>  <file name>"'])
  })

  it('[ADR-027] writes the sums of the top-level files with the given suffixes only, never itself or a folder', () => {
    writeFileSync(path.join(dir, 'DwarfAI-Miners-Setup-1.0.0-x64.exe'), 'setup')
    writeFileSync(path.join(dir, 'DwarfAI-Miners-Setup-1.0.0-x64.exe.blockmap'), 'map')
    writeFileSync(path.join(dir, 'latest.yml'), 'yml')
    mkdirSync(path.join(dir, 'win-unpacked.exe'))
    const written = writeSha256Sums(dir, ['.exe'])
    expect(written).toEqual([{ name: 'DwarfAI-Miners-Setup-1.0.0-x64.exe', hash: sha('setup') }])
    expect(readFileSync(path.join(dir, SUMS_FILE), 'utf8')).toBe(
      `${sha('setup')}  DwarfAI-Miners-Setup-1.0.0-x64.exe\n`
    )
  })

  it('[ADR-027] refuses to write an empty SHA256SUMS when no file has the given suffixes', () => {
    writeFileSync(path.join(dir, 'latest.yml'), 'yml')
    expect(() => writeSha256Sums(dir, ['.dmg', '.zip'])).toThrow(/no file ending in \.dmg, \.zip/)
  })

  it('[ADR-027] verifies a folder whose files all match their listed sums', () => {
    writeFileSync(path.join(dir, 'a.dmg'), 'a')
    writeFileSync(path.join(dir, SUMS_FILE), `${sha('a')}  a.dmg\n`)
    expect(verifySha256Sums(dir)).toEqual({ ok: true, verified: ['a.dmg'], problems: [] })
  })

  it('[ADR-027] fails a changed file, a listed file that is missing, an unlisted file and a missing or empty SHA256SUMS', () => {
    writeFileSync(path.join(dir, 'a.dmg'), 'tampered')
    writeFileSync(path.join(dir, 'extra.zip'), 'x')
    writeFileSync(path.join(dir, SUMS_FILE), `${sha('a')}  a.dmg\n${sha('b')}  b.zip\n`)
    const result = verifySha256Sums(dir)
    expect(result.ok).toBe(false)
    expect(result.verified).toEqual([])
    expect(result.problems).toEqual([
      'a.dmg: checksum mismatch',
      'b.zip: listed but missing',
      'extra.zip: not listed in SHA256SUMS'
    ])

    rmSync(path.join(dir, SUMS_FILE))
    expect(verifySha256Sums(dir).problems).toEqual(['SHA256SUMS is missing'])
    writeFileSync(path.join(dir, SUMS_FILE), '\n')
    expect(verifySha256Sums(dir).problems).toContain('SHA256SUMS lists no file')
  })

  it('[ADR-027] refuses a listed name that leaves the folder', () => {
    writeFileSync(path.join(dir, SUMS_FILE), `${sha('a')}  ../a.dmg\n`)
    const result = verifySha256Sums(dir)
    expect(result.ok).toBe(false)
    expect(result.problems).toContain('../a.dmg: not a plain file name')
  })
})
