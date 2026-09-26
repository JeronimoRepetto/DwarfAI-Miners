import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  AMBIENCE_SRC,
  CREW_SFX_SRC,
  DWARF_VOICE_SRC,
  MUSIC_TRACK_SRC,
  UI_SFX_SRC
} from './audioAssets'

/**
 * The bytes of every sound the app ships, rather than the table that names
 * them (#637).
 *
 * Eight effects once shipped carrying a third-party copyright tag in their ID3
 * header, and nothing in the build could see it: an import resolves a file, it
 * does not read one. These read the files themselves, so a sound delivered
 * with somebody else's copyright notice in it fails here instead of reaching
 * an installer.
 *
 * It reads the real repository on purpose — the committed assets ARE the
 * subject, exactly as `dwarfSheets.test.ts` reads the PNG headers it pins.
 */

/** The repository root; an asset import resolves to a root-relative path. */
const REPO_ROOT = new URL('../../../../../', import.meta.url)
const ASSETS_DIR = fileURLToPath(new URL('../../assets/', import.meta.url))
const AUDIO_EXTENSIONS = /\.(mp3|ogg|wav|flac|m4a|aac|opus)$/i

/** Every audio file under the renderer's assets, as a root-relative path. */
function audioOnDisk(): string[] {
  const entries = readdirSync(ASSETS_DIR, { recursive: true, encoding: 'utf8' })
  return entries
    .filter((entry) => AUDIO_EXTENSIONS.test(entry))
    .map((entry) => `/src/renderer/src/assets/${entry.replaceAll('\\', '/')}`)
    .sort()
}

/** Every sound the inventory imports, as the same root-relative path. */
function audioImported(): string[] {
  const crew = Object.values(CREW_SFX_SRC).flatMap((byCue) =>
    Object.values(byCue).flatMap((variants) => [...(variants ?? [])])
  )
  const all = [
    ...MUSIC_TRACK_SRC,
    ...Object.values(AMBIENCE_SRC),
    ...Object.values(DWARF_VOICE_SRC),
    ...Object.values(UI_SFX_SRC),
    ...crew
  ]
  return [...new Set(all)].sort()
}

function syncsafe(bytes: Buffer, at: number): number {
  return (
    ((bytes[at]! & 0x7f) << 21) |
    ((bytes[at + 1]! & 0x7f) << 14) |
    ((bytes[at + 2]! & 0x7f) << 7) |
    (bytes[at + 3]! & 0x7f)
  )
}

/**
 * The frame ids of every ID3v2 tag at the head of an mp3 — enough of the
 * format to list what is there, and no more. v2.3 and v2.4 differ only in how
 * a frame's size is written; an extended header is skipped rather than read.
 */
function id3FrameIds(bytes: Buffer): string[] {
  const ids: string[] = []
  let offset = 0
  while (bytes.length - offset >= 10 && bytes.toString('latin1', offset, offset + 3) === 'ID3') {
    const version = bytes[offset + 3]!
    const end = offset + 10 + syncsafe(bytes, offset + 6)
    let at = offset + 10
    if ((bytes[offset + 5]! & 0x40) !== 0) {
      at += version === 4 ? syncsafe(bytes, at) : bytes.readUInt32BE(at) + 4
    }
    while (at + 10 <= end) {
      const id = bytes.toString('latin1', at, at + 4)
      // Padding, or the end of what this tag holds.
      if (!/^[A-Z0-9]{4}$/.test(id)) break
      ids.push(id)
      const size = version === 4 ? syncsafe(bytes, at + 4) : bytes.readUInt32BE(at + 4)
      at += 10 + size
    }
    offset = end
  }
  return ids
}

/**
 * Whether an Ogg file's comment header names a copyright holder. The Vorbis
 * comment packet sits in the first pages, so its head is enough to read.
 */
function oggDeclaresCopyright(bytes: Buffer): boolean {
  return /COPYRIGHT=/i.test(bytes.subarray(0, 64 * 1024).toString('latin1'))
}

describe('the audio the app bundles (#637)', () => {
  it('has something to check', () => {
    // A path that stopped resolving would make every check below vacuous.
    expect(audioOnDisk().length).toBeGreaterThan(0)
  })

  it('ships every sound on disk, and nothing on disk that nothing plays', () => {
    // A file left behind unimported is still in the repository and still
    // redistributed with every clone, which is how a retired recording outlives
    // the decision that retired it.
    expect(audioOnDisk()).toEqual(audioImported())
  })

  it('carries no copyright frame in any mp3', () => {
    const tagged = audioOnDisk()
      .filter((path) => path.endsWith('.mp3'))
      .filter((path) => {
        const ids = id3FrameIds(readFileSync(fileURLToPath(new URL(`.${path}`, REPO_ROOT))))
        return ids.includes('TCOP') || ids.includes('WCOP')
      })
    expect(tagged).toEqual([])
  })

  it('carries no copyright comment in any ogg', () => {
    const tagged = audioOnDisk()
      .filter((path) => path.endsWith('.ogg'))
      .filter((path) =>
        oggDeclaresCopyright(readFileSync(fileURLToPath(new URL(`.${path}`, REPO_ROOT))))
      )
    expect(tagged).toEqual([])
  })
})
