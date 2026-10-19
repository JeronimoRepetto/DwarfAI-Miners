import { parseJsonText } from '../text'
import type { ConfigEnv } from './config'

/**
 * The configuration file an installed app actually owns, see #38.
 *
 * `dotenv` resolves `.env` relative to `process.cwd()`, which for a packaged
 * app is never the repository — so every documented setting was unreachable
 * once installed, and the app silently ran on `defaultConfig()`. This file is
 * the transport that fixes that: one JSON document under userData, next to the
 * markers the app already writes there.
 *
 * This is the PURE half only (05 §2.1 `config/`, R9): stored text -> settings
 * layer, its inverse, and the layering under a real environment. Reading and
 * writing the file (the atomic temp-plus-rename store) is the I/O half, which
 * the issue sends to the Host's `FeatureFlagReader` wiring (ISSUE-211, 16
 * §4.12); until then the legacy `createConfigFileStore` keeps serving the
 * legacy runtime.
 *
 * What it deliberately does NOT do is define a second configuration format.
 * The keys are the documented variable names and the values are their raw
 * text, so the file is just another layer of the same string map `loadConfig`
 * already parses. One parser, one set of validation rules, one set of error
 * messages, for both a development checkout and an install.
 */

/**
 * Versioned like the other userData documents, so a future format change can
 * land beside this one instead of having to reinterpret it.
 */
export const CONFIG_FILE_NAME = 'config-v1.json'

/** Settings as stored: documented variable name -> raw unparsed value. */
export type ConfigFileEntries = Record<string, string>

export interface ParsedConfigFile {
  /** The usable settings, ready to be layered under the real environment. */
  entries: ConfigFileEntries
  /**
   * Keys that were present but whose value shape no config parser could ever
   * consume. Named rather than silently dropped so the user can be told which
   * line to fix — an ignored setting that reports nothing is exactly the
   * invisible failure #38 is about.
   */
  ignoredKeys: string[]
}

/**
 * Pure: stored bytes -> settings layer.
 *
 * The error policy here is the one thing worth reading twice, because two
 * different kinds of "bad file" get two different answers:
 *
 * - A *shape* error — unparseable JSON, a document that is not an object, or a
 *   value that is an array/object/null/boolean — is corruption. It is
 *   indistinguishable from a file that was never written, so it degrades to
 *   "no entries" and startup continues on defaults, exactly like every other
 *   preference file in the app. Refusing to start over a mangled file would
 *   leave a packaged app with no way back in.
 * - A *value* error — a string or number that is simply wrong, like a port of
 *   70000 — is not corruption; it is a legible instruction we cannot carry
 *   out. Those pass straight through to `loadConfig`, which fails fast with
 *   the message it already produces. Quietly ignoring them would recreate the
 *   original bug in a new place: a user editing a setting, and nothing
 *   happening, with no explanation.
 *
 * A JSON number is accepted and stringified because a human hand-editing JSON
 * writes `200`, not `"200"`; refusing that would be a pointless trap.
 */
export function parseConfigFileEntries(raw: string): ParsedConfigFile {
  let parsed: unknown
  try {
    // parseJsonText rather than JSON.parse (#555). A bad shape degrades to no
    // entries by design, which meant the invisible BOM a Windows editor writes
    // made this ignore the WHOLE file in silence — on the one document this
    // file's own comment says is meant to be edited by hand. Corruption still
    // degrades; an encoding mark no longer counts as corruption.
    parsed = parseJsonText(raw)
  } catch {
    return { entries: {}, ignoredKeys: [] }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { entries: {}, ignoredKeys: [] }
  }

  const entries: ConfigFileEntries = {}
  const ignoredKeys: string[] = []
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string') {
      entries[key] = value
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      entries[key] = String(value)
    } else {
      ignoredKeys.push(key)
    }
  }
  return { entries, ignoredKeys }
}

/**
 * Pure inverse of parseConfigFileEntries. Indented rather than the one-liner
 * the other preference files use: this one is meant to be opened and edited by
 * hand, so it should not arrive as a single unreadable line.
 */
export function serializeConfigFileEntries(entries: ConfigFileEntries): string {
  return `${JSON.stringify(entries, null, 2)}\n`
}

/**
 * Pure: layer stored settings *underneath* a real environment, most specific
 * source first — environment, then file, then (via `loadConfig`) the defaults.
 * That ordering is what keeps `pnpm dev` with a repo `.env` behaving exactly
 * as it does today, since dotenv has already populated `process.env` by the
 * time this runs.
 *
 * Two details the obvious `{ ...entries, ...env }` spread would get wrong:
 *
 * - A blank environment variable means "unset" at that layer (`loadConfig` has
 *   always treated it that way), so it must fall through to the file rather
 *   than past it to the defaults.
 * - The result keeps `env` as its prototype instead of copying it, so lookups
 *   still reach the original object. On Windows `process.env` resolves keys
 *   case-insensitively, and flattening it into a plain object would quietly
 *   drop that. Nothing here enumerates the map — `loadConfig` only ever reads
 *   `env[key]` — so an inherited lookup is all it needs.
 */
export function withConfigFileFallback(env: ConfigEnv, entries: ConfigFileEntries): ConfigEnv {
  const layered = Object.create(env) as ConfigEnv
  for (const [key, value] of Object.entries(entries)) {
    const fromEnv = env[key]
    if (fromEnv === undefined || fromEnv.trim() === '') {
      layered[key] = value
    }
  }
  return layered
}
