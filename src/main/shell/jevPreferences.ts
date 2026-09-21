import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseJevPreferences, type JevLaunchDefault, type JevPreferences } from '../domain/types'
import { LAUNCHABLE_PROVIDERS } from '../domain/launchProviders'
import { parseLaunchTuning } from '../domain/launchTuning'

/**
 * The persisted routing profile and default launch behind Settings' Jev
 * section (#509 follow-up): which of the three profiles Jev routes under,
 * and the provider/model/effort a launch falls back to when Jev cannot
 * decide.
 *
 * Storage mirrors every OTHER preference here (audioPreference.ts and its
 * siblings): one tiny JSON document under userData, rewritten atomically
 * through a sibling temp file plus a rename, with an injected fs so the
 * tests need no real disk. `userDataDir` rather than a bare `filePath`,
 * matching `jevApiKey.ts` beside it — this store owns joining its own
 * filename, the shape the OTHER Jev store already holds, for one Settings
 * section that composes two stores in `main/index.ts`.
 *
 * This is a PREFERENCE (`config-layering` skill), not the secret
 * `jevApiKey.ts` guards: nothing here is ciphertext, and a bad shape
 * degrades on load exactly the way `audioPreference.ts` does. What makes it
 * different from an ordinary preference is that its VALUE can be wrong in a
 * way no shape check can catch — a default naming a provider this build
 * cannot launch, or a model/effort pairing the launch gate would refuse
 * outright. `save` re-validates that value against the SAME gate a real
 * launch goes through (`parseLaunchTuning`, `LAUNCHABLE_PROVIDERS`) and
 * refuses to write anything the next launch could not carry out — the
 * bad-VALUE half of the `config-layering` asymmetry, and this store's job
 * because the shared parser (`parseJevPreferences`) only ever checks shape.
 */

/** The one file this store owns, under userData. */
const FILE_NAME = 'jev-preferences-v1.json'
/** Sibling suffix for the atomic write; same directory keeps rename on one volume. */
const TEMP_SUFFIX = '.tmp'

export interface JevPreferenceFsLike {
  readFile: (path: string, encoding: 'utf8') => Promise<string>
  writeFile: (path: string, data: string, encoding: 'utf8') => Promise<void>
  rename: (from: string, to: string) => Promise<void>
}

const realFs: JevPreferenceFsLike = { readFile, writeFile, rename }

/**
 * Why `save` refused to persist a default — never a shape problem (the
 * shared parser already fixed that up before this is ever called), always a
 * value the launch gate would reject outright.
 */
export type JevPreferenceSaveRefusalReason =
  'default-provider-not-launchable' | 'default-tuning-invalid'

export type JevPreferenceSaveResult =
  { saved: true } | { saved: false; reason: JevPreferenceSaveRefusalReason }

export interface JevPreferenceStore {
  /** The stored preferences, or the documented defaults when there are none. */
  load: () => Promise<JevPreferences>
  /** Re-validates the default against the launch gate before persisting. */
  save: (preferences: JevPreferences) => Promise<JevPreferenceSaveResult>
}

export interface JevPreferenceStoreOptions {
  /** userData directory; this store owns joining its own filename onto it. */
  userDataDir: string
  /** Injected for tests; defaults to the real filesystem. */
  fs?: JevPreferenceFsLike
}

/**
 * Whether a default launch is one `parseLaunchTuning` and
 * `LAUNCHABLE_PROVIDERS` would actually carry out, or the reason it is not.
 */
function refusalFor(launchDefault: JevLaunchDefault): JevPreferenceSaveRefusalReason | null {
  const { provider, model, effort } = launchDefault
  if (provider === undefined) {
    // No provider chosen: a model or effort here has no ladder and no CLI to
    // validate it against — the same "cannot be carried out" the gate below
    // refuses, so it is refused here too rather than silently kept.
    return model !== undefined || effort !== undefined ? 'default-tuning-invalid' : null
  }
  if (!LAUNCHABLE_PROVIDERS.includes(provider)) return 'default-provider-not-launchable'
  const tuning = parseLaunchTuning(provider, {
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort })
  })
  return tuning === null ? 'default-tuning-invalid' : null
}

export function createJevPreferenceStore(options: JevPreferenceStoreOptions): JevPreferenceStore {
  const fs = options.fs ?? realFs
  const filePath = join(options.userDataDir, FILE_NAME)

  async function load(): Promise<JevPreferences> {
    let raw: string
    try {
      raw = await fs.readFile(filePath, 'utf8')
    } catch {
      // Missing file is the common first-run case; any other read failure
      // (permissions, transient IO) is treated the same way because a
      // preference is never worth failing startup over.
      return parseJevPreferences(undefined)
    }
    try {
      return parseJevPreferences(JSON.parse(raw))
    } catch (error) {
      // Unparseable bytes are corruption, indistinguishable from a file that
      // was never written — the shape half of the `config-layering` rule.
      // Degrading is not SILENT, though: "the loader warns by name when it
      // discards a file", because starting on defaults quietly would look
      // exactly like the bug that rule exists to catch.
      console.warn('[jev] Stored preferences could not be read; using the defaults:', error)
      return parseJevPreferences(undefined)
    }
  }

  async function save(preferences: JevPreferences): Promise<JevPreferenceSaveResult> {
    const reason = refusalFor(preferences.default)
    if (reason !== null) return { saved: false, reason }

    // Parsed again on the way OUT, the same discipline serializeAudioPreferences
    // holds for its document: the one writer under our control cannot then
    // produce a file the next startup would have to correct.
    const clean = parseJevPreferences(preferences)
    const tempPath = `${filePath}${TEMP_SUFFIX}`
    await fs.writeFile(tempPath, `${JSON.stringify(clean)}\n`, 'utf8')
    await fs.rename(tempPath, filePath)
    return { saved: true }
  }

  return { load, save }
}
