/**
 * The pure scrub rules of the fixture recorder (17 §1.4 "Redaction (scrub rules)").
 *
 * A fixture set is every document scrubbed together for one case: the recorded streams of one
 * session. Every rule is a pure function of the set and the maintainer's identity, so the same raw
 * capture always gives the same bytes, and scrubbing a scrubbed set changes nothing.
 *
 * The secret patterns are ADR-026's, from their one source (`contracts/logging`, ISSUE-012): this
 * file adds only what a fixture needs beyond a log line (a bearer token of any length).
 */
import { REDACTED, redactSecrets } from '../../../src/contracts/logging/redactSecrets.ts'

/** The fixed epoch a fixture set's earliest timestamp is shifted to (17 §1.4), 2025-01-01T00:00:00Z. */
export const FIXED_EPOCH_MS = Date.UTC(2025, 0, 1)

/** What each personal value is replaced with. */
export const PLACEHOLDERS = Object.freeze({
  repo: '<REPO>',
  home: '<HOME>',
  user: '<USER>',
  host: '<HOST>',
  email: '<EMAIL>',
  path: '<PATH>',
  account: '<ACCOUNT_ID>',
  sid: '<SID>'
})

/**
 * @typedef {object} ScrubIdentity The maintainer's machine, as the scrubber must hide it.
 * @property {string} home the home directory
 * @property {string} user the OS user name
 * @property {string} host the host name
 * @property {string} repoRoot the recorder's throwaway repository (`<tmp>/dwarfai-rec-<n>`)
 */

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Claude-style encoding of a path or name into one folder name: every non-alphanumeric is `-`. */
const encodeAsFolderName = (s) => s.replace(/[^A-Za-z0-9]/g, '-')

/**
 * A literal absolute path in any of its spellings: either separator, doubled separators (JSON
 * escaping inside a text line), any case on a drive-letter path, and its folder-name encoding.
 */
function literalPathPattern(literal) {
  const segments = literal.split(/[\\/]+/).filter((segment) => segment !== '')
  const spelled = segments.map(escapeRegExp).join('[\\\\/]+')
  const posixLead = literal.startsWith('/') ? '[\\\\/]+' : ''
  return new RegExp(
    `(?:${posixLead}${spelled}|${escapeRegExp(encodeAsFolderName(literal))})`,
    /^[A-Za-z]:/.test(literal) ? 'gi' : 'g'
  )
}

/** A word: not glued to a letter, digit or another word character on either side. */
function wordPattern(word) {
  return new RegExp(
    `(?<![A-Za-z0-9_])(?:${escapeRegExp(word)}|${escapeRegExp(encodeAsFolderName(word))})(?![A-Za-z0-9_])`,
    'gi'
  )
}

/**
 * Anyone's home directory: `C:\Users\<name>`, `/home/<name>`, `/Users/<name>` (and `/c/Users/<name>`
 * as Git Bash spells it). The name runs to the next separator, quote or white space.
 */
const ANY_HOME = /(?:\b[A-Za-z]:|\/[A-Za-z](?=[\\/]))?[\\/]+(?:Users|home)[\\/]+[^\\/\s"'<>]+/gi

/** `Bearer <token>`, whatever the token's length; the scheme word stays so the shape is kept. */
const BEARER = /\b(Bearer)\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]+/gi

/** A Windows security identifier: names one account on one machine or domain. */
const SID = /\bS-1-\d+(?:-\d+){2,}\b/g

/**
 * The keys whose value is a provider account, organization or user id: replaced whole, a number
 * too. The list is open: a driver issue adds the keys of its provider's protocol.
 */
export const ACCOUNT_ID_KEYS = new Set([
  'accountId',
  'account_id',
  'accountUuid',
  'account_uuid',
  'organizationId',
  'organization_id',
  'organizationUuid',
  'organization_uuid',
  'orgId',
  'org_id',
  'userId',
  'userID',
  'user_id',
  'workspaceId',
  'workspace_id'
])

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g

/**
 * An absolute path that no earlier rule recognised: outside the throwaway repository, so it names
 * something of the maintainer's machine. Not glued to a word, a scheme or a placeholder, so a URL
 * path and `<REPO>/src` stay.
 */
const ABSOLUTE_PATH = /(?<![\w:/\\.<>-])(?:[A-Za-z]:[\\/]+|\/)[^\s"'<>|*?]+/g

/**
 * The keys whose string value is a provider session, message, tool-call or request id. The list is
 * open: a driver issue adds the keys of its provider's protocol.
 */
export const PROVIDER_ID_KEYS = new Set([
  'id',
  'uuid',
  'parentUuid',
  'leafUuid',
  'sessionId',
  'sessionID',
  'session_id',
  'messageId',
  'messageID',
  'message_id',
  'parentId',
  'parentID',
  'parent_id',
  'toolUseId',
  'tool_use_id',
  'toolCallId',
  'tool_call_id',
  'callId',
  'call_id',
  'requestId',
  'request_id',
  'conversationId',
  'conversation_id',
  'threadId',
  'thread_id',
  'turnId',
  'turn_id',
  'itemId',
  'item_id',
  'agentId'
])

/** Under these keys an `id` names a model, not a provider id, and stays. */
const NOT_PROVIDER_ID_PARENTS = new Set(['model', 'models'])

/** An opaque id: one token of 8+ characters holding a digit (a protocol request id `3` is not one). */
const OPAQUE_ID = /^(?=.*\d)[A-Za-z0-9][A-Za-z0-9_.:-]{7,}$/

const FAKE_ID_PREFIX = '00000000-0000-4000-8000-'
/** A fake UUID this scrubber wrote: it maps to itself, so a scrubbed set scrubs to itself. */
const FAKE_ID = /^00000000-0000-4000-8000-([0-9a-f]{12})$/

const fakeId = (n) => FAKE_ID_PREFIX + n.toString(16).padStart(12, '0')

/** Every parsed JSON value of the set, in document order, line order inside a JSONL document. */
function parsedValues(documents) {
  const values = []
  for (const { name, text } of documents) {
    const chunks = name.endsWith('.jsonl')
      ? text.split(/\r?\n/)
      : name.endsWith('.json')
        ? [text]
        : []
    for (const chunk of chunks) {
      try {
        values.push(JSON.parse(chunk))
      } catch {
        // Not JSON: scrubbed as text, and holds no id field.
      }
    }
  }
  return values
}

/** Walks a parsed value, calling `visit(key, value, parentKey)` for every object field. */
function walkFields(value, visit, parentKey = null) {
  if (Array.isArray(value)) {
    for (const item of value) walkFields(item, visit, parentKey)
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      visit(key, item, parentKey)
      walkFields(item, visit, key)
    }
  }
}

/**
 * The id map of one fixture set: every provider id, in first-seen order, to a fake UUID. Fake ids
 * already in the set keep their number and no new id takes it (17 §1.4: C-19 needs repeated ids).
 */
function buildIdMap(values) {
  const found = []
  const used = new Set()
  for (const value of values) {
    walkFields(value, (key, item, parentKey) => {
      if (typeof item !== 'string' || !PROVIDER_ID_KEYS.has(key)) return
      if (NOT_PROVIDER_ID_PARENTS.has(parentKey)) return
      const fake = FAKE_ID.exec(item)
      if (fake) used.add(Number.parseInt(fake[1], 16))
      else if (OPAQUE_ID.test(item)) found.push(item)
    })
  }
  const map = new Map()
  let next = 1
  for (const id of found) {
    if (map.has(id)) continue
    while (used.has(next)) next++
    used.add(next)
    map.set(id, fakeId(next))
  }
  return map
}

/** Replaces every mapped id inside a string, the longest first so no id eats part of another. */
function idReplacer(idMap) {
  const ids = [...idMap.keys()].sort((a, b) => b.length - a.length)
  return (s) => {
    let result = s
    for (const id of ids) if (result.includes(id)) result = result.split(id).join(idMap.get(id))
    return result
  }
}

/**
 * The text rules for one identity, in the order they apply: each is a name (what the survivor check
 * reports) and a pure replacement. The secret patterns of ADR-026 come last.
 *
 * @returns {{ name: string, apply: (s: string) => string }[]}
 */
function textRules(identity) {
  const rules = []
  const add = (name, pattern, replacement) =>
    rules.push({ name, apply: (s) => s.replace(pattern, replacement) })
  if (identity.repoRoot) add('repo', literalPathPattern(identity.repoRoot), PLACEHOLDERS.repo)
  if (identity.home) add('home', literalPathPattern(identity.home), PLACEHOLDERS.home)
  add('home', ANY_HOME, PLACEHOLDERS.home)
  add('email', EMAIL, PLACEHOLDERS.email)
  add('bearer', BEARER, `$1 ${REDACTED}`)
  add('sid', SID, PLACEHOLDERS.sid)
  if (identity.host) add('host', wordPattern(identity.host), PLACEHOLDERS.host)
  if (identity.user) add('user', wordPattern(identity.user), PLACEHOLDERS.user)
  add('path', ABSOLUTE_PATH, PLACEHOLDERS.path)
  rules.push({ name: 'secret', apply: redactSecrets })
  return rules
}

function scrubText(text, rules) {
  return rules.reduce((result, rule) => rule.apply(result), text)
}

/**
 * The keys whose number is a point in time, in epoch milliseconds or seconds. The list is open: a
 * driver issue adds the keys of its provider's protocol.
 */
export const TIMESTAMP_KEYS = new Set([
  'at',
  'ts',
  'time',
  'timestamp',
  'created',
  'updated',
  'completed',
  'createdAt',
  'updatedAt',
  'startedAt',
  'endedAt',
  'completedAt',
  'created_at',
  'updated_at',
  'started_at',
  'ended_at',
  'completed_at',
  'time_created',
  'time_updated',
  'time_completed'
])

/** A whole string value that is an ISO-8601 instant. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/

/** Epoch milliseconds from 2001-09 on, and epoch seconds from 2001-09 on. */
const MIN_EPOCH_MS = 1e12
const MIN_EPOCH_S = 1e9

/** A numeric time field's unit, or null when the number is not a point in time. */
function epochUnit(n) {
  if (!Number.isFinite(n)) return null
  if (n >= MIN_EPOCH_MS && n < MIN_EPOCH_MS * 100) return 1
  if (n >= MIN_EPOCH_S && n < MIN_EPOCH_MS) return 1_000
  return null
}

/** Calls `visit(key, leaf)` for every string and number of a parsed value, with its field name. */
function walkLeaves(value, visit, key = null) {
  if (Array.isArray(value)) for (const item of value) walkLeaves(item, visit, key)
  else if (value !== null && typeof value === 'object') {
    for (const [field, item] of Object.entries(value)) walkLeaves(item, visit, field)
  } else visit(key, value)
}

/** The earliest instant of the set, in milliseconds, or null when it holds none. */
function earliestInstant(values) {
  let earliest = null
  for (const value of values) {
    walkLeaves(value, (key, leaf) => {
      let ms = null
      if (typeof leaf === 'string' && ISO_INSTANT.test(leaf)) ms = Date.parse(leaf)
      if (typeof leaf === 'number' && TIMESTAMP_KEYS.has(key) && epochUnit(leaf) !== null) {
        ms = leaf * epochUnit(leaf)
      }
      if (ms !== null && (earliest === null || ms < earliest)) earliest = ms
    })
  }
  return earliest
}

/**
 * The shift of one set: its earliest instant, cut to the whole second, lands on the fixed epoch.
 * Whole seconds keep second-precision fields integral, and make a second scrub shift by zero.
 */
function timeShift(values) {
  const earliest = earliestInstant(values)
  if (earliest === null) return 0
  return FIXED_EPOCH_MS - Math.floor(earliest / 1_000) * 1_000
}

/**
 * Scrubs a parsed JSON value: every string through `scrub` (keys included), an ISO instant and a
 * time field shifted by `shiftMs`, deltas kept to the millisecond.
 */
function scrubValue(value, scrub, shiftMs, key = null) {
  if (
    key !== null &&
    ACCOUNT_ID_KEYS.has(key) &&
    (typeof value === 'string' || typeof value === 'number')
  ) {
    return PLACEHOLDERS.account
  }
  if (typeof value === 'string') {
    return ISO_INSTANT.test(value)
      ? new Date(Date.parse(value) + shiftMs).toISOString()
      : scrub(value)
  }
  if (typeof value === 'number' && key !== null && TIMESTAMP_KEYS.has(key)) {
    const unit = epochUnit(value)
    return unit === null ? value : value + shiftMs / unit
  }
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, scrub, shiftMs, key))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [field, item] of Object.entries(value)) {
      out[scrub(field)] = scrubValue(item, scrub, shiftMs, field)
    }
    return out
  }
  return value
}

/** One line or document: parsed JSON is scrubbed value by value, anything else as text. */
function scrubJsonOrText(text, scrub, shiftMs, indent) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return scrub(text)
  }
  return JSON.stringify(scrubValue(parsed, scrub, shiftMs), null, indent)
}

/**
 * Scrubs one fixture set. A `.jsonl` document is scrubbed line by line (a line that is not JSON is
 * scrubbed as text, so a negative fixture keeps its malformed line); a `.json` document as one
 * value; anything else as text. Line endings come out as LF.
 *
 * @param {{ name: string, text: string }[]} documents
 * @param {ScrubIdentity} identity
 * @returns {{ name: string, text: string }[]}
 */
export function scrubFixtureSet(documents, identity) {
  const rules = textRules(identity)
  const values = parsedValues(documents)
  const replaceIds = idReplacer(buildIdMap(values))
  const shiftMs = timeShift(values)
  const scrub = (s) => scrubText(replaceIds(s), rules)
  return documents.map(({ name, text }) => {
    if (name.endsWith('.jsonl')) {
      const lines = text.split(/\r?\n/)
      return {
        name,
        text: lines
          .map((line) => (line === '' ? line : scrubJsonOrText(line, scrub, shiftMs)))
          .join('\n')
      }
    }
    if (name.endsWith('.json')) {
      return { name, text: `${scrubJsonOrText(text.trim(), scrub, shiftMs, 2)}\n` }
    }
    return { name, text: scrub(text.replace(/\r\n/g, '\n')) }
  })
}

/**
 * The safety net after scrubbing: which rule would still change each line of a written file. It
 * reports the rule and the line, never the value, so its output can be printed. A non-empty result
 * means the scrub missed something and nothing may be written (TC-145-01).
 *
 * @param {string} text
 * @param {ScrubIdentity} identity
 * @returns {{ rule: string, line: number }[]}
 */
export function findSurvivors(text, identity) {
  const rules = textRules(identity)
  const survivors = []
  text.split(/\r?\n/).forEach((original, index) => {
    let line = original
    for (const rule of rules) {
      const next = rule.apply(line)
      if (next !== line) survivors.push({ rule: rule.name, line: index + 1 })
      line = next
    }
  })
  return survivors
}

/**
 * The lines of a committed file that hold an ADR-026 secret pattern or a bearer token: the
 * identity-free half of `findSurvivors`, checked on each untouched line so no earlier rule can hide
 * a secret inside a placeholder.
 *
 * @param {string} text
 * @returns {{ rule: 'secret', line: number }[]}
 */
export function findSecrets(text) {
  const found = []
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.replace(BEARER, '') !== line || redactSecrets(line) !== line) {
      found.push({ rule: 'secret', line: index + 1 })
    }
  })
  return found
}
