#!/usr/bin/env node
// The static check of the bundled sounds (02 NFR-TIM-14, NFR-SND-06, NFR-SND-09; DS docs/sound.md; ISSUE-272).
//
//   node scripts/release/audioAssets.mjs [--root <dir>]
//
// - NFR-TIM-14: every interface cue lasts under 0.5 s and every attention cue under 1.5 s. The cues are UI_SFX_SRC
//   of src/renderer/src/lib/audio/audioAssets.ts; an MP3's duration is counted from its frame headers, a WAV's from
//   its samples.
// - NFR-SND-06: the attention cues share one level, a maximum momentary loudness of -26.4 LUFS (ITU-R BS.1770
//   K-weighting, 400 ms windows every 100 ms), and "finished" is the faintest. The meter reads PCM WAV. The shipped
//   cues are MP3, and decoding MP3 needs a decoder this toolchain does not have (a new dependency or a system tool,
//   both the owner's decision; foreman ruling 2026-10-16: none for now), so an MP3 cue's level is printed as
//   `unmeasured (mp3)` on a warning line: neither a failure nor a pass.
// - NFR-SND-09: every sound the renderer plays is an explicit `import` of a file that exists; a path to an audio file
//   in any other form (a string, a template, a glob, a `src` attribute) fails.
// Exits 1 on any failure. Reads files only.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ATTENTION_CUES = ['question', 'permission', 'finished']
export const INTERFACE_MAX_SECONDS = 0.5
export const ATTENTION_MAX_SECONDS = 1.5
/** The shared attention level (DS sound.md) and how far a cue may sit from it, in LU (a package gap; see the PR). */
export const ATTENTION_LUFS = -26.4
export const LEVEL_TOLERANCE_LU = 0.5

export const INVENTORY = path.join('src', 'renderer', 'src', 'lib', 'audio', 'audioAssets.ts')
const RENDERER = path.join('src', 'renderer')
const AUDIO_EXT = 'mp3|ogg|wav|flac|m4a|aac|opus'

// ---------------------------------------------------------------------------------------------------------------
// MP3 duration from frame headers.

const BITRATES = {
  v1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
}
const SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }

function skipId3(bytes) {
  let at = 0
  while (bytes.length - at >= 10 && bytes.toString('latin1', at, at + 3) === 'ID3') {
    const size =
      ((bytes[at + 6] & 0x7f) << 21) |
      ((bytes[at + 7] & 0x7f) << 14) |
      ((bytes[at + 8] & 0x7f) << 7) |
      (bytes[at + 9] & 0x7f)
    at += 10 + size + ((bytes[at + 5] & 0x10) !== 0 ? 10 : 0)
  }
  return at
}

/** The Layer III frame at `at`, as `{ length, samples, sampleRate }`, or null when no valid header is there. */
function frameAt(bytes, at) {
  if (at + 4 > bytes.length || bytes[at] !== 0xff || (bytes[at + 1] & 0xe0) !== 0xe0) return null
  const version = (bytes[at + 1] >> 3) & 0x03 // 3: MPEG-1, 2: MPEG-2, 0: MPEG-2.5
  const layer = (bytes[at + 1] >> 1) & 0x03 // 1: Layer III
  const bitrateIndex = bytes[at + 2] >> 4
  const rateIndex = (bytes[at + 2] >> 2) & 0x03
  if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3)
    return null
  const bitrate = (version === 3 ? BITRATES.v1 : BITRATES.v2)[bitrateIndex] * 1000
  const sampleRate = SAMPLE_RATES[version][rateIndex]
  const padding = (bytes[at + 2] >> 1) & 0x01
  const samples = version === 3 ? 1152 : 576
  const length = Math.floor(((samples / 8) * bitrate) / sampleRate) + padding
  return { length, samples, sampleRate }
}

/**
 * The duration of an MPEG Layer III stream in seconds: the samples of every audio frame over the sample rate. A
 * Xing, Info or VBRI frame is the encoder's header, not audio, and is not counted.
 */
export function mp3DurationSeconds(bytes) {
  let at = skipId3(bytes)
  let seconds = 0
  let frames = 0
  while (at < bytes.length) {
    const frame = frameAt(bytes, at)
    if (!frame) {
      if (bytes.toString('latin1', at, at + 3) === 'TAG') break
      at++
      continue
    }
    const head = bytes.toString('latin1', at + 4, Math.min(bytes.length, at + 48))
    const isHeader = frames === 0 && /Xing|Info|VBRI/.test(head)
    if (!isHeader) seconds += frame.samples / frame.sampleRate
    frames++
    at += frame.length
  }
  if (frames === 0) throw new Error('not an MPEG Layer III stream')
  return seconds
}

// ---------------------------------------------------------------------------------------------------------------
// The renderer's cue inventory.

/** The interface and attention cues of UI_SFX_SRC, as `{ kind, file }` with `file` relative to the root. */
export function readUiSfxInventory(rootDir) {
  const source = readFileSync(path.join(rootDir, INVENTORY), 'utf8').replace(/\r\n/g, '\n')
  const imports = new Map()
  for (const m of source.matchAll(
    new RegExp(`^import (\\w+) from '([^']+\\.(?:${AUDIO_EXT}))'`, 'gm')
  )) {
    imports.set(m[1], path.join(path.dirname(INVENTORY), m[2]))
  }
  const block = source.match(/export const UI_SFX_SRC = \{\n([\s\S]*?)\n\}/)
  if (!block) throw new Error(`${INVENTORY} has no UI_SFX_SRC`)
  return [...block[1].matchAll(/^\s*(\w+): (\w+),?$/gm)].map(([, kind, name]) => {
    if (!imports.has(name)) throw new Error(`UI_SFX_SRC.${kind} is not an imported audio file`)
    return { kind, file: imports.get(name) }
  })
}

/** The duration failures of a list of `{ kind, file, seconds }` cues. */
export function checkCueDurations(cues) {
  return cues.flatMap(({ kind, file, seconds }) => {
    const attention = ATTENTION_CUES.includes(kind)
    const max = attention ? ATTENTION_MAX_SECONDS : INTERFACE_MAX_SECONDS
    return seconds < max
      ? []
      : [
          `${file}: the ${attention ? 'attention' : 'interface'} cue "${kind}" lasts ${seconds.toFixed(2)} s, not under ${max} s`
        ]
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Loudness (ITU-R BS.1770-4 momentary loudness).

/** A RIFF WAV's PCM as `{ sampleRate, channels: Float32Array[] }`: 16, 24 or 32-bit integer, or 32-bit float. */
export function readWavPcm(bytes) {
  if (bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF WAVE file')
  }
  let at = 12
  let format = null
  while (at + 8 <= bytes.length) {
    const id = bytes.toString('latin1', at, at + 4)
    const size = bytes.readUInt32LE(at + 4)
    const body = at + 8
    if (id === 'fmt ') {
      const tag = bytes.readUInt16LE(body)
      format = {
        tag: tag === 0xfffe ? bytes.readUInt16LE(body + 24) : tag,
        channels: bytes.readUInt16LE(body + 2),
        sampleRate: bytes.readUInt32LE(body + 4),
        bits: bytes.readUInt16LE(body + 14)
      }
    } else if (id === 'data') {
      if (!format) throw new Error('WAV data before its fmt chunk')
      const width = format.bits / 8
      const frames = Math.floor(Math.min(size, bytes.length - body) / (width * format.channels))
      const channels = Array.from({ length: format.channels }, () => new Float32Array(frames))
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < format.channels; c++) {
          const p = body + (i * format.channels + c) * width
          let value
          if (format.tag === 3 && format.bits === 32) value = bytes.readFloatLE(p)
          else if (format.tag === 1 && format.bits === 16) value = bytes.readInt16LE(p) / 32768
          else if (format.tag === 1 && format.bits === 24) value = bytes.readIntLE(p, 3) / 8388608
          else if (format.tag === 1 && format.bits === 32) value = bytes.readInt32LE(p) / 2147483648
          else throw new Error(`unsupported WAV format ${format.tag}/${format.bits}`)
          channels[c][i] = value
        }
      }
      return { sampleRate: format.sampleRate, channels }
    }
    at = body + size + (size % 2)
  }
  throw new Error('WAV without a data chunk')
}

/** The two K-weighting biquads for a sample rate (BS.1770 stage 1 shelf and stage 2 high-pass, as libebur128). */
function kWeighting(sampleRate) {
  const shelf = (() => {
    const f0 = 1681.974450955533
    const gain = 3.999843853973347
    const q = 0.7071752369554196
    const k = Math.tan((Math.PI * f0) / sampleRate)
    const vh = 10 ** (gain / 20)
    const vb = vh ** 0.4996667741545416
    const a0 = 1 + k / q + k * k
    return {
      b: [
        (vh + (vb * k) / q + k * k) / a0,
        (2 * (k * k - vh)) / a0,
        (vh - (vb * k) / q + k * k) / a0
      ],
      a: [(2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0]
    }
  })()
  const highPass = (() => {
    const f0 = 38.13547087602444
    const q = 0.5003270373238773
    const k = Math.tan((Math.PI * f0) / sampleRate)
    const a0 = 1 + k / q + k * k
    return { b: [1, -2, 1], a: [(2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0] }
  })()
  return [shelf, highPass]
}

function filter(samples, { b, a }) {
  const out = new Float64Array(samples.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i]
    const y = b[0] * x + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2
    out[i] = y
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y
  }
  return out
}

/**
 * The maximum momentary loudness of a clip in LUFS: the loudest 400 ms window, stepped every 100 ms, of the
 * K-weighted mean square summed over the channels (each weighted 1). A clip shorter than one window is measured
 * as one window padded with silence. Silence is -Infinity.
 */
export function maxMomentaryLoudness({ sampleRate, channels }) {
  const stages = kWeighting(sampleRate)
  const squared = channels.map((samples) => {
    const weighted = stages.reduce((signal, stage) => filter(signal, stage), samples)
    const prefix = new Float64Array(weighted.length + 1)
    for (let i = 0; i < weighted.length; i++) prefix[i + 1] = prefix[i] + weighted[i] * weighted[i]
    return prefix
  })
  const window = Math.round(sampleRate * 0.4)
  const hop = Math.round(sampleRate * 0.1)
  const length = channels[0]?.length ?? 0
  let loudest = -Infinity
  for (let start = 0; start === 0 || start + window <= length; start += hop) {
    const end = Math.min(length, start + window)
    const power = squared.reduce((sum, prefix) => sum + (prefix[end] - prefix[start]) / window, 0)
    if (power > 0) loudest = Math.max(loudest, -0.691 + 10 * Math.log10(power))
  }
  return loudest
}

/** The level failures of the attention cues, given each cue's maximum momentary loudness (`{ kind: lufs }`). */
export function checkAttentionLevels(levels) {
  const failures = []
  for (const kind of ATTENTION_CUES) {
    if (typeof levels[kind] !== 'number' || Number.isNaN(levels[kind]))
      failures.push(`${kind}: no loudness measured`)
  }
  if (failures.length > 0) return failures
  for (const kind of ATTENTION_CUES.filter((k) => k !== 'finished')) {
    if (Math.abs(levels[kind] - ATTENTION_LUFS) > LEVEL_TOLERANCE_LU) {
      failures.push(
        `${kind}: momentary maximum ${levels[kind].toFixed(1)} LUFS, not at the shared ${ATTENTION_LUFS} LUFS level`
      )
    }
  }
  const others = Math.min(...ATTENTION_CUES.filter((k) => k !== 'finished').map((k) => levels[k]))
  if (levels.finished > ATTENTION_LUFS + LEVEL_TOLERANCE_LU || levels.finished >= others - 0.05) {
    failures.push(`finished: ${levels.finished.toFixed(1)} LUFS is not the faintest attention cue`)
  }
  return failures
}

// ---------------------------------------------------------------------------------------------------------------
// Explicit imports.

const SOURCE_FILE = /\.(?:ts|tsx|js|mjs|vue|html)$/
const TEST_FILE = /\.(?:test|spec)\.[^.]+$/
const IMPORT = new RegExp(`^\\s*import\\s+\\w+\\s+from\\s+['"]([^'"]+\\.(?:${AUDIO_EXT}))['"]`, 'i')
const AUDIO_PATH = new RegExp(`\\.(?:${AUDIO_EXT})(?:\\?[\\w=&]*)?['"\`]`, 'i')

function sourceFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter(
      (entry) => SOURCE_FILE.test(entry) && !TEST_FILE.test(entry) && !entry.endsWith('.d.ts')
    )
    .map((entry) => path.join(dir, entry))
    .sort()
}

/**
 * The renderer's audio references that are not an explicit import of an existing file. A comment line and a type
 * declaration file (`declare module '*.mp3'`) name no file and are not read; test files are not shipped.
 */
export function scanAudioReferences(rootDir) {
  const failures = []
  for (const file of sourceFiles(path.join(rootDir, RENDERER))) {
    const relative = path.relative(rootDir, file).replaceAll('\\', '/')
    const lines = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n')
    lines.forEach((line, index) => {
      const trimmed = line.trimStart()
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
      const imported = line.match(IMPORT)
      if (imported) {
        if (!existsSync(path.resolve(path.dirname(file), imported[1]))) {
          failures.push(`${relative}:${index + 1}: imports ${imported[1]}, which does not exist`)
        }
      } else if (AUDIO_PATH.test(line)) {
        failures.push(
          `${relative}:${index + 1}: an audio file reached by a path, not an explicit import`
        )
      }
    })
  }
  return failures
}

// ---------------------------------------------------------------------------------------------------------------

/** A cue's duration in seconds: MP3 from its frame headers, WAV from its sample count; NaN for any other format. */
function durationOf(file, bytes) {
  if (file.endsWith('.mp3')) return mp3DurationSeconds(bytes)
  if (file.endsWith('.wav')) {
    const { sampleRate, channels } = readWavPcm(bytes)
    return channels[0].length / sampleRate
  }
  return Number.NaN
}

/**
 * Every check of the bundled sounds over the tree at `rootDir`: `{ lines, failures, warnings }`. An attention cue
 * that is not a WAV cannot be decoded by this toolchain; its loudness is reported `unmeasured` on a warning, never as
 * a failure and never as a pass, and the shared-level comparison runs only when all three are measured.
 */
export function checkAudioAssets(rootDir) {
  const cues = readUiSfxInventory(rootDir)
  const lines = []
  const failures = []
  const warnings = []
  const bytesOf = (cue) => readFileSync(path.join(rootDir, cue.file))
  const measured = cues.map((cue) => {
    const seconds = durationOf(cue.file, bytesOf(cue))
    const shown = cue.file.replaceAll('\\', '/')
    lines.push(
      `${cue.kind}: ${shown} ${Number.isNaN(seconds) ? 'duration not read' : `${seconds.toFixed(3)} s`}`
    )
    if (Number.isNaN(seconds)) failures.push(`${shown}: only MP3 and WAV durations are read`)
    return { ...cue, seconds }
  })
  failures.push(...checkCueDurations(measured.filter((cue) => !Number.isNaN(cue.seconds))))
  const levels = {}
  for (const cue of cues.filter((c) => ATTENTION_CUES.includes(c.kind))) {
    if (cue.file.endsWith('.wav')) {
      levels[cue.kind] = maxMomentaryLoudness(readWavPcm(bytesOf(cue)))
      lines.push(`${cue.kind}: momentary maximum ${levels[cue.kind].toFixed(1)} LUFS`)
    } else {
      const format = path.extname(cue.file).slice(1)
      warnings.push(
        `${cue.kind}: unmeasured (${format}): no ${format.toUpperCase()} decoder in the toolchain, so its loudness is not checked`
      )
    }
  }
  if (Object.keys(levels).length === ATTENTION_CUES.length)
    failures.push(...checkAttentionLevels(levels))
  failures.push(...scanAudioReferences(rootDir))
  return { lines, failures, warnings }
}

function main() {
  const rootIndex = process.argv.indexOf('--root')
  const rootDir = path.resolve(rootIndex === -1 ? '.' : process.argv[rootIndex + 1])
  const { lines, failures, warnings } = checkAudioAssets(rootDir)
  for (const line of lines) console.log(line)
  for (const warning of warnings) console.warn(`warning: ${warning}`)
  for (const failure of failures) console.error(`FAIL ${failure}`)
  process.exitCode = failures.length > 0 ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
