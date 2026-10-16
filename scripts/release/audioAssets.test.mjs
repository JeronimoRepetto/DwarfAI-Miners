// layer: L7
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ATTENTION_CUES,
  checkAttentionLevels,
  checkAudioAssets,
  checkCueDurations,
  maxMomentaryLoudness,
  mp3DurationSeconds,
  readUiSfxInventory,
  readWavPcm,
  scanAudioReferences
} from './audioAssets.mjs'

/**
 * The static check of the bundled sounds (`02` NFR-TIM-14, NFR-SND-06, NFR-SND-09; DS `docs/sound.md` "Principles",
 * "Mapping onto the engine"; ISSUE-272). Fixture clips are built here byte by byte (MP3 frame headers, PCM WAV), so
 * no binary fixture is committed; the shipped cues are read from the repository itself.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

let dir
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'audio-assets-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** An MPEG-1 Layer III stream at 128 kbit/s, 44.1 kHz (417-byte frames of 1152 samples) behind an ID3v2 tag. */
function mp3(seconds, { xing = true } = {}) {
  const frames = Math.ceil((seconds * 44100) / 1152)
  const frame = (marker) => {
    const bytes = Buffer.alloc(417)
    bytes.set([0xff, 0xfb, 0x90, 0x00])
    if (marker) bytes.write(marker, 36, 'latin1')
    return bytes
  }
  const id3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
  return Buffer.concat([
    id3,
    ...(xing ? [frame('Xing')] : []),
    ...Array.from({ length: frames }, () => frame())
  ])
}

/** A mono 16-bit PCM WAV of a sine at the given frequency and peak amplitude. */
function wav({ seconds, amplitude, frequency = 997, sampleRate = 48000 }) {
  const count = Math.round(seconds * sampleRate)
  const data = Buffer.alloc(count * 2)
  for (let i = 0; i < count; i++) {
    const value = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate)
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32767))), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVEfmt ', 8, 'latin1')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'latin1')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/** The peak amplitude of a 997 Hz sine whose loudness is `lufs` (BS.1770: a full-scale one reads -3.01 LUFS). */
const amplitudeFor = (lufs) => 10 ** ((lufs + 3.01) / 20)

function write(relative, content) {
  const file = path.join(dir, relative)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
}

describe('bundled sound assets (DS sound.md)', () => {
  it('[NFR-TIM-14] every interface cue lasts under 0.5 s and every attention cue under 1.5 s', () => {
    expect(mp3DurationSeconds(mp3(2))).toBeCloseTo(2, 1)
    expect(mp3DurationSeconds(mp3(0.3, { xing: false }))).toBeCloseTo(0.3, 1)
    expect(
      checkCueDurations([
        { kind: 'click', file: 'click.mp3', seconds: mp3DurationSeconds(mp3(0.2)) },
        { kind: 'panel', file: 'panel.mp3', seconds: mp3DurationSeconds(mp3(0.6)) },
        { kind: 'question', file: 'question.mp3', seconds: mp3DurationSeconds(mp3(1.2)) },
        { kind: 'finished', file: 'finished.mp3', seconds: mp3DurationSeconds(mp3(2)) }
      ])
    ).toEqual([
      'panel.mp3: the interface cue "panel" lasts 0.60 s, not under 0.5 s',
      'finished.mp3: the attention cue "finished" lasts 2.01 s, not under 1.5 s'
    ])

    // The shipped cues, read from the renderer's own inventory.
    const shipped = readUiSfxInventory(repoRoot)
    expect(
      shipped
        .map((cue) => cue.kind)
        .filter((kind) => ATTENTION_CUES.includes(kind))
        .sort()
    ).toEqual(['finished', 'permission', 'question'])
    const measured = shipped.map((cue) => ({
      ...cue,
      seconds: mp3DurationSeconds(readFileSync(path.join(repoRoot, cue.file)))
    }))
    for (const cue of measured) expect(cue.seconds, cue.file).toBeGreaterThan(0)
    expect(checkCueDurations(measured)).toEqual([])
  })

  it('[NFR-SND-06] every attention cue peaks at -26.4 LUFS momentary, all at one level, and finished is the faintest', () => {
    // The meter itself, against the BS.1770 calibration point: a 997 Hz full-scale sine reads -3.01 LUFS.
    expect(maxMomentaryLoudness(readWavPcm(wav({ seconds: 1, amplitude: 1 })))).toBeCloseTo(
      -3.01,
      1
    )
    const level = (lufs) =>
      maxMomentaryLoudness(readWavPcm(wav({ seconds: 0.9, amplitude: amplitudeFor(lufs) })))
    expect(level(-26.4)).toBeCloseTo(-26.4, 1)

    expect(
      checkAttentionLevels({
        question: level(-26.4),
        permission: level(-26.4),
        finished: level(-29)
      })
    ).toEqual([])
    expect(
      checkAttentionLevels({ question: level(-26.4), permission: level(-22), finished: level(-29) })
    ).toEqual(['permission: momentary maximum -22.0 LUFS, not at the shared -26.4 LUFS level'])
    expect(
      checkAttentionLevels({
        question: level(-26.4),
        permission: level(-26.4),
        finished: level(-26.4)
      })
    ).toEqual(['finished: -26.4 LUFS is not the faintest attention cue'])
    expect(checkAttentionLevels({ question: level(-26.4), permission: level(-26.4) })).toEqual([
      'finished: no loudness measured'
    ])
  })

  it('[NFR-SND-09] a sound the renderer reaches by a dynamic path instead of an explicit import, or an imported file that is missing, fails the check', () => {
    write('src/renderer/src/assets/audio/sfx/ok.mp3', mp3(0.2))
    write(
      'src/renderer/src/lib/audio/audioAssets.ts',
      [
        "import ok from '../../assets/audio/sfx/ok.mp3'",
        "import gone from '../../assets/audio/sfx/gone.ogg'",
        '/** `.mp3` in a comment is prose, not a path. */',
        '// new Audio("commented.mp3")',
        'export const SRC = { ok, gone }',
        ''
      ].join('\n')
    )
    write(
      'src/renderer/src/lib/audio/dynamic.ts',
      [
        "export const a = new Audio('/sounds/click.mp3')",
        'export const b = (name: string) => `../../assets/audio/${name}.ogg`',
        "export const c = import.meta.glob('../../assets/audio/sfx/*.wav')",
        ''
      ].join('\n')
    )
    write(
      'src/renderer/src/components/Cue.vue',
      '<template><audio src="./ding.mp3" /></template>\n'
    )
    write('src/renderer/src/lib/audio/engine.test.ts', "const clip = 'click.mp3'\n")

    expect(scanAudioReferences(dir)).toEqual([
      'src/renderer/src/components/Cue.vue:1: an audio file reached by a path, not an explicit import',
      'src/renderer/src/lib/audio/audioAssets.ts:2: imports ../../assets/audio/sfx/gone.ogg, which does not exist',
      'src/renderer/src/lib/audio/dynamic.ts:1: an audio file reached by a path, not an explicit import',
      'src/renderer/src/lib/audio/dynamic.ts:2: an audio file reached by a path, not an explicit import',
      'src/renderer/src/lib/audio/dynamic.ts:3: an audio file reached by a path, not an explicit import'
    ])
    expect(scanAudioReferences(repoRoot)).toEqual([])
  })

  it('[NFR-SND-06] a shipped MP3 attention cue is reported unmeasured (mp3) on a warning, neither a failure nor a pass', () => {
    const shipped = checkAudioAssets(repoRoot)
    expect(shipped.failures).toEqual([])
    expect(shipped.warnings).toEqual([
      'question: unmeasured (mp3): no MP3 decoder in the toolchain, so its loudness is not checked',
      'permission: unmeasured (mp3): no MP3 decoder in the toolchain, so its loudness is not checked',
      'finished: unmeasured (mp3): no MP3 decoder in the toolchain, so its loudness is not checked'
    ])
  })

  it('[NFR-SND-06, NFR-TIM-14] WAV cues are measured for both duration and level, and a loud attention cue fails', () => {
    const cue = (lufs, seconds = 0.9) => wav({ seconds, amplitude: amplitudeFor(lufs) })
    write('src/renderer/src/assets/audio/sfx/click.wav', cue(-30, 0.2))
    write('src/renderer/src/assets/audio/sfx/question.wav', cue(-26.4))
    write('src/renderer/src/assets/audio/sfx/permission.wav', cue(-22))
    write('src/renderer/src/assets/audio/sfx/finished.wav', cue(-29, 0.6))
    write(
      'src/renderer/src/lib/audio/audioAssets.ts',
      [
        "import sfxClick from '../../assets/audio/sfx/click.wav'",
        "import sfxQuestion from '../../assets/audio/sfx/question.wav'",
        "import sfxPermission from '../../assets/audio/sfx/permission.wav'",
        "import sfxFinished from '../../assets/audio/sfx/finished.wav'",
        'export const UI_SFX_SRC = {',
        '  click: sfxClick,',
        '  question: sfxQuestion,',
        '  permission: sfxPermission,',
        '  finished: sfxFinished',
        '}',
        ''
      ].join('\n')
    )
    const result = checkAudioAssets(dir)
    expect(result.warnings).toEqual([])
    expect(result.failures).toEqual([
      'permission: momentary maximum -22.0 LUFS, not at the shared -26.4 LUFS level'
    ])
  })
})
