// JsonUiPreferenceStore: the `UiPreferenceStore` adapter of the window module (05 §3.14; 16 §4.14; ADR-024 item 1).
// One JSON file per store under `userData`, written by UI main alone through a sibling temp file and a rename, so an
// interrupted write never leaves a half-written store file behind. A file is read only when it holds exactly what
// this store would write (the row's schema, and the value already in its stored form, 21 §5.3): anything else is that
// store's defaults and one `uiprefs.corrupt` record, and the other stores are untouched (FM-053). A missing file is a
// first start: defaults, no record. Loading never writes.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { CHANNELS, validateAccelerator } from '@dwarfai/contracts'
import { defaultsOf, migrateTwoChoiceTypography, storedFormOf } from '../domain/uiPreferenceValues'
import type {
  UiPreferenceLogRecord,
  UiPreferenceStore,
  UiPreferenceStoreKey,
  UiPreferenceStoreMap
} from '../ports/uiPreferenceStore'

/** The synchronous file operations the store uses (Node's `fs` in production; a faulty one in tests). */
export interface UiPreferenceFs {
  readFileSync(path: string, encoding: 'utf8'): string
  writeFileSync(path: string, data: string, encoding: 'utf8'): void
  renameSync(from: string, to: string): void
  mkdirSync(path: string, options: { recursive: true }): unknown
}

export const nodeFs: UiPreferenceFs = { readFileSync, writeFileSync, renameSync, mkdirSync }

/**
 * One file per store under `userData`, named as today's stores name them, so a conforming file left by today's
 * runtime is read from the first start on (21 §5.3, TC-048-02).
 */
export const UI_PREFERENCE_FILES: Readonly<Record<UiPreferenceStoreKey, string>> = {
  audio: 'audio-preferences-v1.json',
  typography: 'typography-preferences-v2.json',
  launchView: 'launch-view-v1.json',
  dockSide: 'panel-edge-v1.json',
  alwaysOnTop: 'pin-preference-v1.json',
  shortcut: 'shortcut-preference-v1.json',
  // NEW with the UiPreferencesMap (ISSUE-060): no store of today's holds it.
  startWithSystem: 'start-with-system-v1.json',
  // NEW with the Reset metrics UI step (ISSUE-061): no store of today's holds it.
  resetEpochApplied: 'reset-epoch-applied-v1.json'
}

/** The older two-choice typography preference (Interface and Messaging faces), read while no typography file exists. */
export const TWO_CHOICE_TYPOGRAPHY_FILE = 'typography-preferences-v1.json'

/** Sibling suffix of the atomic write: the same folder keeps the rename on one volume. */
const TEMP_SUFFIX = '.tmp'

/** How each store's value sits in its file: the row's own shape, or today's one-field document. */
interface FileFormat<K extends UiPreferenceStoreKey> {
  /** The value a document holds, or `undefined` when the document does not conform. */
  decode(document: unknown): UiPreferenceStoreMap[K] | undefined
  encode(value: UiPreferenceStoreMap[K]): unknown
}

/** A document that is the value itself, checked by the row's strict schema. */
function asItself<K extends UiPreferenceStoreKey>(schema: z.ZodTypeAny): FileFormat<K> {
  return {
    decode: (document) => {
      const parsed = schema.safeParse(document)
      return parsed.success ? (parsed.data as UiPreferenceStoreMap[K]) : undefined
    },
    encode: (value) => value
  }
}

/** Today's one-field document `{ [field]: value }`. */
function inField<K extends UiPreferenceStoreKey>(
  field: string,
  schema: z.ZodTypeAny
): FileFormat<K> {
  const document = z.object({ [field]: schema }).strict()
  return {
    decode: (raw) => {
      const parsed = document.safeParse(raw)
      return parsed.success ? (parsed.data[field] as UiPreferenceStoreMap[K]) : undefined
    },
    encode: (value) => ({ [field]: value })
  }
}

/** A recorded shortcut is stored only in its one canonical spelling (`validateAccelerator`). */
const canonicalAccelerator = z
  .string()
  .refine((s) => {
    const checked = validateAccelerator(s)
    return checked.ok && checked.accelerator === s
  })
  .nullable()

const FORMATS: { readonly [K in UiPreferenceStoreKey]: FileFormat<K> } = {
  audio: asItself(CHANNELS['audio:preferences:get'].response),
  typography: asItself(CHANNELS['typography:preferences:get'].response),
  launchView: asItself(CHANNELS['launch-view:get'].response),
  dockSide: inField('edge', CHANNELS['panel:layout:get'].response.shape.edge),
  alwaysOnTop: inField('pinned', z.boolean()),
  shortcut: inField('accelerator', canonicalAccelerator),
  startWithSystem: inField('on', z.boolean()),
  resetEpochApplied: inField('epoch', z.number().int().nonnegative())
}

export interface JsonUiPreferenceStoreOptions {
  /** The folder of the store files: Electron's `userData` in production. */
  dir: string
  /** Where the store's one record per unusable file or failed write goes (19 §9.6). */
  log: (record: UiPreferenceLogRecord) => void
  /** Injected for tests; Node's `fs` by default. */
  fs?: UiPreferenceFs
}

/** What reading a file found. */
type Found =
  { kind: 'absent' } | { kind: 'unusable'; errCode?: string } | { kind: 'read'; document: unknown }

function errCodeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

export class JsonUiPreferenceStore implements UiPreferenceStore {
  private readonly fs: UiPreferenceFs

  constructor(private readonly options: JsonUiPreferenceStoreOptions) {
    this.fs = options.fs ?? nodeFs
  }

  load<K extends UiPreferenceStoreKey>(k: K): UiPreferenceStoreMap[K] {
    const found = this.read(UI_PREFERENCE_FILES[k])
    if (found.kind === 'absent') {
      if (k === 'typography') return this.olderTypography() as UiPreferenceStoreMap[K]
      return defaultsOf(k)
    }
    if (found.kind === 'read') {
      const value = FORMATS[k].decode(found.document)
      if (value !== undefined && isDeepStrictEqual(storedFormOf(k, value), value)) return value
    }
    this.options.log({
      level: 'warn',
      event: 'uiprefs.corrupt',
      subsystem: 'window',
      msg: k,
      ...(found.kind === 'unusable' && found.errCode !== undefined
        ? { errCode: found.errCode }
        : {})
    })
    return defaultsOf(k)
  }

  save<K extends UiPreferenceStoreKey>(k: K, v: UiPreferenceStoreMap[K]): void {
    const file = join(this.options.dir, UI_PREFERENCE_FILES[k])
    const temp = `${file}${TEMP_SUFFIX}`
    try {
      this.fs.mkdirSync(this.options.dir, { recursive: true })
      this.fs.writeFileSync(temp, `${JSON.stringify(FORMATS[k].encode(v))}\n`, 'utf8')
      this.fs.renameSync(temp, file)
    } catch (error) {
      const errCode = errCodeOf(error)
      this.options.log({
        level: 'warn',
        event: 'uiprefs.write-failed',
        subsystem: 'window',
        msg: k,
        ...(errCode !== undefined ? { errCode } : {})
      })
      throw error
    }
  }

  private read(name: string): Found {
    let raw: string
    try {
      raw = this.fs.readFileSync(join(this.options.dir, name), 'utf8')
    } catch (error) {
      const errCode = errCodeOf(error)
      return errCode === 'ENOENT' ? { kind: 'absent' } : { kind: 'unusable', errCode }
    }
    try {
      return { kind: 'read', document: JSON.parse(raw) as unknown }
    } catch {
      return { kind: 'unusable' }
    }
  }

  /**
   * While no typography file exists, the older two-choice file is read in the preset model (US-SET-003.AC07); it is
   * never written, so the person's older choice survives whatever happens to the new file.
   */
  private olderTypography(): UiPreferenceStoreMap['typography'] {
    const found = this.read(TWO_CHOICE_TYPOGRAPHY_FILE)
    if (found.kind === 'read') return migrateTwoChoiceTypography(found.document)
    if (found.kind === 'unusable') {
      this.options.log({
        level: 'warn',
        event: 'uiprefs.corrupt',
        subsystem: 'window',
        msg: 'typography'
      })
    }
    return defaultsOf('typography')
  }
}
