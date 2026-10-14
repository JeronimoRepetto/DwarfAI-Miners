// The fixture set of one driver (15 §6, 17 §1.4): `fixtures/<provider>/<driver>/<version>/` with
// its `meta.json`, and per case the provider's recorded side (`<case>.jsonl`: the bytes the CLI
// wrote; `<case>.json`: recorded HTTP / SSE exchanges), its companion streams as the recorder and
// scrubber write them (`<case>-sent.jsonl`: what DwarfAI sent; `<case>-timing.jsonl`: the order of
// chunks; `<case>-<stream>.jsonl`: any other stream), the `-with-extra` variant of every protocol
// file (HR T1), the CRLF variant of every JSONL file (HO-37) and the hand-written
// `<case>.expected.json` (the scripted calls and their expected outcome; 17 §1.4).
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { Json } from './expected'
import { gatesFromTiming } from './fixtureTransport'

/** One scripted call of a case (`script` of its expected file). */
export type ScriptStep =
  | {
      readonly do: 'launch'
      readonly readyAfterMs?: number
      readonly launchId?: string
      readonly prompt?: string
      readonly delegation?: boolean
      readonly permissionMode?: 'policy-only'
    }
  | { readonly do: 'sendTurn'; readonly messageId: string; readonly text: string }
  | { readonly do: 'advance'; readonly ms: number }
  | { readonly do: 'interrupt' }
  | {
      readonly do: 'answerPermission'
      readonly providerRequestId: string
      readonly decision: 'allow' | 'deny'
    }
  | {
      readonly do: 'answerQuestion'
      readonly providerRequestId: string
      readonly answers?: readonly { step: number; option?: string; freeText?: string }[]
      readonly decline?: true
    }
  | { readonly do: 'close'; readonly mode: 'detach' | 'end-thread' }
  | { readonly do: 'transportLost' }
  | { readonly do: 'resume' }
  | { readonly do: 'adopt' }
  | { readonly do: 'probe' }

/** A case's `<case>.expected.json`, written by hand from the contract (17 §1.4). */
export interface ExpectedCase {
  /** The 15 §6 case it proves, `C-01` … `C-29`. */
  readonly case: string
  readonly description?: string
  readonly script: readonly ScriptStep[]
  /** One per script step: what its call resolved (`null`: not checked). */
  readonly outcomes?: readonly (Json | null)[]
  /** The normalized `DriverEvent[]` of the run (`{session}` = the bound providerSessionId). */
  readonly events?: readonly Json[]
  /** The frames the driver must send back, in order. */
  readonly sent?: readonly Json[]
  /** C-25: what the protocol handshake negotiated (the probe is the driver's own `probe()`). */
  readonly negotiated?: { readonly protocol?: Json }
}

/** One way to replay a case: its files as recorded, with unknown fields, or with CRLF endings. */
export interface FixtureVariant {
  readonly label: 'as-recorded' | 'with-extra' | 'crlf'
  readonly format: 'jsonl' | 'json'
  /** What the provider wrote (stdout bytes for JSONL, the exchange record for JSON). */
  readonly received: string
  /** Companion streams by name (`sent`, `timing`, `stderr`, …), in the same variant. */
  readonly streams: Readonly<Record<string, string>>
  /** Per JSONL line, the driver frames that must precede it (from the timing stream). */
  readonly gates?: readonly number[]
}

export interface FixtureCase {
  /** The file stem, e.g. `c-05-send-turn`. */
  readonly name: string
  readonly expected: ExpectedCase
  readonly variants: readonly FixtureVariant[]
}

export interface FixtureSet {
  readonly provider: string
  readonly driver: string
  readonly providerVersion: string
  readonly meta: Readonly<Record<string, unknown>>
  readonly cases: readonly FixtureCase[]
}

const EXPECTED_SUFFIX = '.expected.json'
const WITH_EXTRA = '-with-extra'
const toLf = (text: string): string => text.replaceAll('\r\n', '\n')

/** Builds a fixture set from the files of one `<provider>/<driver>/<version>/` folder. */
export function fixtureSetFromFiles(
  location: { provider: string; driver: string; providerVersion: string },
  files: ReadonlyMap<string, string>
): FixtureSet {
  const problems = refusals(files)
  if (problems.length > 0) {
    const where = `${location.provider}/${location.driver}/${location.providerVersion}`
    throw new Error(`fixture set ${where} refused: ${problems.join('; ')}`)
  }
  const meta = JSON.parse(files.get('meta.json') as string) as Record<string, unknown>
  const cases: FixtureCase[] = []
  for (const [file, text] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (!file.endsWith(EXPECTED_SUFFIX)) continue
    const name = file.slice(0, -EXPECTED_SUFFIX.length)
    cases.push({
      name,
      expected: JSON.parse(text) as ExpectedCase,
      variants: variantsOf(name, files)
    })
  }
  return { ...location, meta, cases }
}

const CAPTURED_BY_ROLES = new Set(['maintainer', 'ci-synthetic'])
const META_STRING_FIELDS = ['providerVersion', 'capturedAt', 'os']

/**
 * Why the harness refuses a fixture set (15 §6, 17 §1.4; ADR-009 D3 Verification): no
 * `meta.json`, a `meta.json` without its fields, without `scrubbed: true` or with a person as
 * `capturedBy`; a protocol file without its `-with-extra` variant (HR T1); an LF JSONL file
 * without its CRLF variant (HO-37). Empty when the set is accepted.
 */
function refusals(files: ReadonlyMap<string, string>): string[] {
  const out: string[] = []
  const metaText = files.get('meta.json')
  if (metaText === undefined) out.push('the folder has no meta.json')
  else out.push(...metaRefusals(metaText))

  const jsonl = [...files].filter(([file]) => file.endsWith('.jsonl'))
  const crlfTexts = jsonl.filter(([, text]) => text.includes('\r\n')).map(([, text]) => text)
  const isCrlfVariant = (text: string): boolean =>
    text.includes('\r\n') && jsonl.some(([, lf]) => !lf.includes('\r\n') && lf === toLf(text))
  for (const [file, text] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (file === 'meta.json' || file.endsWith(EXPECTED_SUFFIX)) continue
    if (file.endsWith('.jsonl') && isCrlfVariant(text)) continue
    const ext = path.extname(file)
    const stem = file.slice(0, -ext.length)
    if (stem.endsWith(WITH_EXTRA)) continue
    if (!files.has(`${stem}${WITH_EXTRA}${ext}`)) {
      out.push(`${file} has no ${stem}${WITH_EXTRA}${ext} variant`)
    }
    if (ext === '.jsonl' && !crlfTexts.some((crlf) => toLf(crlf) === text)) {
      out.push(`${file} has no CRLF variant (the same lines ending in CRLF)`)
    }
  }
  return out
}

function metaRefusals(text: string): string[] {
  let meta: unknown
  try {
    meta = JSON.parse(text)
  } catch {
    return ['meta.json is not valid JSON']
  }
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    return ['meta.json is not a JSON object']
  }
  const fields = meta as Record<string, unknown>
  const out: string[] = []
  for (const field of META_STRING_FIELDS) {
    if (typeof fields[field] !== 'string' || fields[field] === '') {
      out.push(`meta.json lacks a non-empty string "${field}"`)
    }
  }
  const capabilities = fields.capabilities
  if (capabilities === null || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    out.push('meta.json lacks a "capabilities" object')
  }
  if (fields.scrubbed !== true) out.push('meta.json does not say "scrubbed": true')
  if (!CAPTURED_BY_ROLES.has(fields.capturedBy as string)) {
    out.push('meta.json "capturedBy" is not a role (maintainer, ci-synthetic)')
  }
  return out
}

/** The as-recorded, `-with-extra` and CRLF variants of one case and of its companion streams. */
function variantsOf(name: string, files: ReadonlyMap<string, string>): FixtureVariant[] {
  const format = files.has(`${name}.jsonl`) ? 'jsonl' : 'json'
  const streamNames = companionStreams(name, files)
  const pick = (stem: string, label: FixtureVariant['label']): string | undefined => {
    const ext = files.has(`${stem}.jsonl`) ? 'jsonl' : 'json'
    const base = files.get(`${stem}.${ext}`)
    if (label === 'as-recorded' || base === undefined) return base
    if (label === 'with-extra') return files.get(`${stem}${WITH_EXTRA}.${ext}`)
    return crlfOf(stem, base, files)
  }
  // The timing stream counts the bytes of the recording itself, so the gates come from it once.
  const recorded = pick(name, 'as-recorded')
  const timing = pick(`${name}-timing`, 'as-recorded')
  const gates =
    format === 'jsonl' && recorded !== undefined && timing !== undefined
      ? gatesFromTiming(recorded, timing)
      : undefined
  const variant = (label: FixtureVariant['label']): FixtureVariant | undefined => {
    const text = pick(name, label)
    if (text === undefined) return undefined
    const streams: Record<string, string> = {}
    for (const stream of streamNames) {
      streams[stream] =
        pick(`${name}-${stream}`, label) ?? pick(`${name}-${stream}`, 'as-recorded') ?? ''
    }
    return { label, format, received: text, streams, ...(gates === undefined ? {} : { gates }) }
  }
  const labels: FixtureVariant['label'][] =
    format === 'jsonl' ? ['as-recorded', 'with-extra', 'crlf'] : ['as-recorded', 'with-extra']
  return labels.map(variant).filter((v): v is FixtureVariant => v !== undefined)
}

/** The CRLF variant of an LF JSONL file: any file with the same lines ending in CRLF (HO-37). */
function crlfOf(
  stem: string,
  base: string,
  files: ReadonlyMap<string, string>
): string | undefined {
  if (base.includes('\r\n')) return undefined
  for (const [file, text] of files) {
    if (file.startsWith(stem) && file.endsWith('.jsonl') && text.includes('\r\n')) {
      if (toLf(text) === base) return text
    }
  }
  return undefined
}

/** `<name>-<stream>.<ext>` files that are neither variants nor the expected file. */
function companionStreams(name: string, files: ReadonlyMap<string, string>): string[] {
  const streams = new Set<string>()
  const pattern = new RegExp(`^${escape(name)}-([A-Za-z0-9_]+)\\.(?:jsonl|json)$`)
  for (const file of files.keys()) {
    const match = pattern.exec(file)
    if (match === null) continue
    const stream = match[1] as string
    // `-crlf` is a variant; `<name>-<word>` with its own expected file is another case.
    if (stream === 'crlf' || files.has(`${name}-${stream}${EXPECTED_SUFFIX}`)) continue
    streams.add(stream)
  }
  return [...streams].sort()
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Reads one fixture folder from disk (the folder's last three segments locate it). */
export function readFixtureSet(dir: string): FixtureSet {
  const files = new Map<string, string>()
  for (const name of readdirSync(dir)) files.set(name, readFileSync(path.join(dir, name), 'utf8'))
  const segments = path.resolve(dir).split(path.sep)
  return fixtureSetFromFiles(
    {
      provider: segments.at(-3) ?? '',
      driver: segments.at(-2) ?? '',
      providerVersion: segments.at(-1) ?? ''
    },
    files
  )
}
