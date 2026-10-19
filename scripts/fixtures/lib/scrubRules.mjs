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
  organization: '<ORGANIZATION>',
  sid: '<SID>',
  signature: '<SIGNATURE>',
  installation: '<INSTALLATION_ID>',
  syncedSkill: '<CLAUDE_SYNCED_SKILL_DIR>',
  scratchpad: '<AGENT_SCRATCHPAD>',
  personalSetup: '<PERSONAL_SETUP>',
  apiRequest: '<API_REQUEST>'
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
  const encoded = segments.map(percentEncodedSegment).join(`${ENCODED_SEPARATOR}+`)
  const encodedLead = literal.startsWith('/') ? `${ENCODED_SEPARATOR}+` : ''
  return new RegExp(
    `(?:${posixLead}${spelled}|${encodedLead}${encoded}|${escapeRegExp(encodeAsFolderName(literal))})`,
    /^[A-Za-z]:/.test(literal) ? 'gi' : 'g'
  )
}

/** A separator of a percent-encoded path (a URL query value): `%2F` or `%5C`, either case. */
const ENCODED_SEPARATOR = '(?:%2[Ff]|%5[Cc])'

/** One path segment as `encodeURIComponent` spells it, each escape matched in either case. */
function percentEncodedSegment(segment) {
  return escapeRegExp(encodeURIComponent(segment)).replace(
    /%([0-9A-F])([0-9A-F])/g,
    (_, high, low) => `%[${high}${high.toLowerCase()}][${low}${low.toLowerCase()}]`
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

/**
 * Anyone's home directory percent-encoded, as a URL query carries it (OpenCode
 * `?directory=C%3A%2FUsers%2F<name>%2F…`): the name runs to the next encoded separator.
 */
const ANY_HOME_ENCODED =
  /(?:\b[A-Za-z]%3[Aa])?(?:%2[Ff]|%5[Cc])+(?:Users|home)(?:%2[Ff]|%5[Cc])+(?:(?!%2[Ff]|%5[Cc])[^\s"'<>&#?\\/])+/gi

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

/**
 * The keys whose value is a stable id of one provider installation on the maintainer's machine:
 * Codex `remoteControl/status/changed` carries `installationId` (S-015-1). Replaced whole. The list
 * is open: a driver issue adds the keys of its provider's protocol.
 */
/**
 * The keys whose value is the name of the provider organization the recording person belongs to:
 * claude-agent-acp `_auth/status_update` carries `account.organization` (ISSUE-151). Replaced
 * whole, and wherever the set repeats it. The list is open: a driver issue adds the keys of its
 * provider's protocol.
 */
export const ORGANIZATION_NAME_KEYS = new Set([
  'organization',
  'organizationName',
  'organization_name'
])

export const INSTALLATION_ID_KEYS = new Set(['installationId', 'installation_id'])

/**
 * The Claude transcript attachments that render the recording person's own setup or account: the
 * organization of the credential, the environment, CLAUDE.md instructions, the skill, agent and
 * deferred-tool listings, the session context and the prompt snapshot. Each keeps only its
 * `type`, and its `rendered` text becomes one placeholder, so the record chain stays (ADR-022: the
 * `parentUuid` chain passes through attachments). The list is open: a driver issue adds the types
 * of its provider version.
 */
export const PERSONAL_SETUP_ATTACHMENTS = new Set([
  'credential_org',
  'environment',
  'session_context',
  'remote_session_change',
  'instructions',
  'skill_listing',
  'agent_listing_delta',
  'deferred_tools_delta',
  'prompt_snapshot'
])

/** A Claude transcript record that dumps a whole API request: it keeps only its record type. */
const API_REQUEST_RECORD = /^api-request(?:-[a-z-]+)?$/

const isPersonalSetupAttachment = (value) =>
  value.type === 'attachment' &&
  value.attachment !== null &&
  typeof value.attachment === 'object' &&
  PERSONAL_SETUP_ATTACHMENTS.has(value.attachment.type)

/** The record with its personal payload removed, or null when it holds none. */
function withoutPersonalPayload(value) {
  if (typeof value.type === 'string' && API_REQUEST_RECORD.test(value.type)) {
    return { type: value.type, redacted: PLACEHOLDERS.apiRequest }
  }
  if (!isPersonalSetupAttachment(value)) return null
  const out = {}
  for (const [field, item] of Object.entries(value)) {
    if (field === 'attachment') {
      out[field] = { type: item.type, redacted: PLACEHOLDERS.personalSetup }
    } else if (field === 'rendered') {
      out[field] = PLACEHOLDERS.personalSetup
    } else out[field] = item
  }
  return out
}

/**
 * The keys whose string value is an opaque provider blob, replaced whole: Claude's thinking-block
 * `signature` is base64, so a `+/` run inside it reads as an absolute path and other runs as
 * secrets. No driver reads it, and the whole value goes, so nothing personal can hide in it. The
 * list is open: a driver issue adds the keys of its provider's protocol.
 */
export const OPAQUE_BLOB_KEYS = new Set(['signature'])

/**
 * The list fields of a Claude `system/init` line that describe the recording person's own setup
 * (commands, agents, skills, plugins), with the placeholder stem of each item. Each item becomes
 * `<stem-n>`, every string inside an object item too, so lengths and types stay. The list is open:
 * a driver issue adds the fields of its provider's protocol.
 */
export const INIT_ENVIRONMENT_LISTS = Object.freeze({
  slash_commands: 'slash-command',
  terminal_slash_commands: 'terminal-slash-command',
  agents: 'agent',
  skills: 'skill',
  plugins: 'plugin'
})

const isInitLine = (value) => value.type === 'system' && value.subtype === 'init'

/**
 * The map fields of an OpenCode config (`GET /config`, its `$schema` names the OpenCode config
 * schema) that describe the recording person's own setup: agents with their prompts, commands
 * with their templates, MCP servers. Each entry becomes `<stem-n>`, its key and every string inside
 * it, so the shape stays; `plugin` and `permission` stay for the plugin-load and deny cases
 * (S-011-1). The list is open: a driver issue adds the fields of its provider's protocol.
 */
export const OPENCODE_CONFIG_MAPS = Object.freeze({
  agent: 'agent',
  command: 'command',
  mcp: 'mcp-server'
})

const isOpenCodeConfig = (value) =>
  typeof value.$schema === 'string' && /opencode\.ai\/config\.json$/.test(value.$schema)

/** A numbered placeholder this scrubber wrote, such as `<agent-3>`. */
const NUMBERED_PLACEHOLDER = /^<[a-z]+(?:-[a-z]+)*-\d+>$/

/**
 * The placeholder of one setup name: the set-wide one when the name was harvested (so a listing
 * and a later mention agree), the name itself when it already is one, else the listing's own.
 */
function setupPlaceholder(name, scrub, fallback) {
  const scrubbed = scrub(name)
  return NUMBERED_PLACEHOLDER.test(scrubbed) ? scrubbed : fallback
}

/** Every entry of a setup map under its numbered placeholder, the key included. */
function placeholderMap(map, stem, scrub) {
  return Object.fromEntries(
    Object.entries(map).map(([name, entry], index) => {
      const placeholder = setupPlaceholder(name, scrub, `<${stem}-${index + 1}>`)
      return [placeholder, placeholderItem(entry, placeholder, scrub)]
    })
  )
}

/**
 * The names a person gives their own setup: built-in commands, agents, modes and tools of the
 * providers stay, so a fixture keeps what every installation shows.
 */
const BUILTIN_SETUP_NAMES = new Set([
  'default',
  'plan',
  'auto',
  'yolo',
  'build',
  'general',
  'explore',
  'compaction',
  'title',
  'summary',
  'init',
  'review',
  'compact',
  'status',
  'usage',
  'mcp',
  'tasks',
  'help',
  'task',
  'read',
  'write',
  'edit',
  'bash',
  'glob',
  'grep',
  'list',
  'webfetch',
  'todowrite',
  'todoread',
  // Claude Code built-in commands that claude-agent-acp lists and that are also its own protocol
  // vocabulary (`_claude/model`, `model_usage`, the `effort` and `fast` config options).
  'model',
  'effort',
  'fast',
  'config',
  'context',
  // A Claude Code bundled skill whose name is an everyday word of the agent's own replies.
  'run',
  // Claude Code permission modes (the ACP `mode` config option).
  'acceptEdits',
  'bypassPermissions',
  'dontAsk',
  // Codex built-in commands that codex-acp lists and that are also its own protocol vocabulary
  // (`auth.logout` in agentCapabilities, the `_session/goal` steering method).
  'skills',
  'review-branch',
  'review-commit',
  'goal',
  'rename',
  'logout',
  // codex-acp session modes (the ACP `mode` config option); `agent` is also ACP's own
  // `agent_message_chunk` and `agent_thought_chunk`.
  'read-only',
  'agent',
  'agent-full-access'
])

/** A plugin file of the person's global OpenCode config (a project's own plugin stays). */
const GLOBAL_OPENCODE_PLUGIN = /[\\/]\.config[\\/]opencode[\\/]plugins?[\\/]([^\\/]+?)\.[cm]?[jt]s$/

/** A Kimi skill command is `skill:<name>`; the name is what other lines repeat. */
const commandName = (name) => name.replace(/^skill:/, '')

/** OpenCode `--print-logs`: `message="duplicate skill name" name=<skill>`. */
const DUPLICATE_SKILL = /duplicate skill name" name=([^\s"<>]+)/g

/** An OpenCode `GET /mcp` body: each MCP server name to its `{ status }`. */
const isMcpStatusMap = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length > 0 &&
  Object.values(value).every(
    (entry) => entry !== null && typeof entry === 'object' && typeof entry.status === 'string'
  )

/** Calls `visit(object)` for every object of a parsed value. */
function walkObjects(value, visit) {
  if (Array.isArray(value)) for (const item of value) walkObjects(item, visit)
  else if (value !== null && typeof value === 'object') {
    visit(value)
    for (const item of Object.values(value)) walkObjects(item, visit)
  }
}

/**
 * The names of the recording person's own setup in one set, each to a numbered placeholder in
 * first-seen order: command listings (ACP `available_commands_update`), agents and modes, MCP
 * servers (Codex startup status and status list, OpenCode `/mcp` and `/config`), and the skills
 * OpenCode warns about. They are replaced wherever the set repeats them, tool names and prose too.
 */
function buildSetupNameMap(values, documents) {
  const map = new Map()
  const counters = new Map()
  const add = (name, stem) => {
    if (typeof name !== 'string' || name === '' || name.startsWith('<')) return
    if (BUILTIN_SETUP_NAMES.has(name) || map.has(name)) return
    const n = (counters.get(stem) ?? 0) + 1
    counters.set(stem, n)
    map.set(name, `<${stem}-${n}>`)
  }
  for (const value of values) {
    walkObjects(value, (object) => {
      if (Array.isArray(object.availableCommands)) {
        for (const command of object.availableCommands)
          add(commandName(command?.name ?? ''), 'command')
      }
      if (object.category === 'mode' && Array.isArray(object.options)) {
        for (const option of object.options) add(option?.value, 'agent')
      }
      if (typeof object.agent === 'string') add(object.agent, 'agent')
      if (object.method === 'mcpServer/startupStatus/updated')
        add(object.params?.name, 'mcp-server')
      if (isMcpServerStatus(object)) add(object.name, 'mcp-server')
      if (isMcpStatusMap(object.body))
        for (const name of Object.keys(object.body)) add(name, 'mcp-server')
      if (isOpenCodeConfig(object)) {
        for (const [field, stem] of Object.entries(OPENCODE_CONFIG_MAPS)) {
          const entries = object[field]
          if (entries !== null && typeof entries === 'object' && !Array.isArray(entries)) {
            for (const name of Object.keys(entries)) add(name, stem)
          }
        }
        if (Array.isArray(object.plugin)) {
          for (const plugin of object.plugin) {
            const global = typeof plugin === 'string' ? GLOBAL_OPENCODE_PLUGIN.exec(plugin) : null
            if (global) add(global[1], 'plugin')
          }
        }
      }
    })
  }
  for (const { text } of documents) {
    for (const match of text.matchAll(DUPLICATE_SKILL)) add(match[1], 'skill')
  }
  return map
}

/**
 * One entry of an ACP command listing: a person's own command keeps its (placeholder) name, and
 * every other string of it, its description too, becomes that placeholder; a built-in command stays.
 */
function placeholderCommand(command, scrub, shiftMs) {
  if (command === null || typeof command !== 'object' || typeof command.name !== 'string') {
    return scrubValue(command, scrub, shiftMs)
  }
  const placeholder = setupPlaceholder(commandName(command.name), scrub, null)
  if (placeholder === null) return scrubValue(command, scrub, shiftMs)
  return Object.fromEntries(
    Object.entries(command).map(([field, inner]) => [
      field,
      field === 'name' ? scrub(inner) : placeholderItem(inner, placeholder, scrub)
    ])
  )
}

/** Replaces every setup name inside a string, as a whole name, the longest first. */
function setupNameReplacer(map) {
  const patterns = [...map.keys()]
    .sort((a, b) => b.length - a.length)
    .map((name) => [
      new RegExp(`(?<![A-Za-z0-9-])${escapeRegExp(name)}(?![A-Za-z0-9-])`, 'gi'),
      map.get(name)
    ])
  return (s) =>
    patterns.reduce((result, [pattern, placeholder]) => result.replace(pattern, placeholder), s)
}

/**
 * An entry of Codex `mcpServerStatus/list`: one MCP server of the recording person's own setup,
 * with every tool it offers (the connected apps among them). The fields are the protocol's.
 */
const isMcpServerStatus = (item) =>
  item !== null &&
  typeof item === 'object' &&
  !Array.isArray(item) &&
  ['name', 'tools', 'resources', 'resourceTemplates', 'authStatus'].every((field) =>
    Object.hasOwn(item, field)
  )

/** One MCP server status under `<mcp-server-n>`, its tools under `<mcp-server-n-tool-k>`. */
function placeholderMcpServer(item, index, scrub) {
  const placeholder = setupPlaceholder(item.name, scrub, `<mcp-server-${index}>`)
  const n = placeholder.slice(1, -1)
  const out = {}
  for (const [field, inner] of Object.entries(item)) {
    out[field] =
      field === 'tools' && inner !== null && typeof inner === 'object' && !Array.isArray(inner)
        ? Object.fromEntries(
            Object.values(inner).map((tool, index) => [
              `<${n}-tool-${index + 1}>`,
              placeholderItem(tool, placeholder, scrub)
            ])
          )
        : placeholderItem(inner, placeholder, scrub)
  }
  return out
}

/** Every string of one list item replaced by its numbered placeholder; other leaves stay. */
function placeholderItem(item, placeholder, scrubKey = (key) => key) {
  if (typeof item === 'string') return placeholder
  if (Array.isArray(item)) {
    return item.map((inner) => placeholderItem(inner, placeholder, scrubKey))
  }
  if (item !== null && typeof item === 'object') {
    return Object.fromEntries(
      Object.entries(item).map(([key, inner]) => [
        scrubKey(key),
        placeholderItem(inner, placeholder, scrubKey)
      ])
    )
  }
  return item
}

/**
 * A folder of Claude's synced skills, `.claude/skills/synced/<organization uuid>_<uuid>`: its name
 * holds the Claude organization id, and other providers print it (OpenCode `--print-logs` lists
 * the duplicate skills it finds there). The whole folder name goes; a placeholder already in it is
 * taken in too, so a scrubbed path scrubs to itself.
 */
const CLAUDE_SYNCED_SKILL_DIR =
  /(\.claude[\\/]+skills[\\/]+synced[\\/]+)(?:<[A-Z_]+>|[^\\/\s"'<>])+/g

/**
 * The scratchpad of the agent session that ran a probe, `claude/<project folder>/<session id>/scratchpad`
 * under the temporary folder: the session id names one local agent session. Both folder names go.
 */
const AGENT_SCRATCHPAD =
  /([\\/]+claude[\\/]+)(?:<[A-Z_]+>|[^\\/\s"'<>])+[\\/]+(?:<[A-Z_]+>|[^\\/\s"'<>])+[\\/]+scratchpad(?=[\\/"'\s]|$)/g

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g

/**
 * An absolute path that no earlier rule recognised: outside the throwaway repository, so it names
 * something of the maintainer's machine. Not glued to a word, a scheme or a placeholder, so a URL
 * path, `<REPO>/src` and the rest of a path after a `[redacted]` segment stay (the secret rule runs
 * after this one, so a second pass must change nothing).
 */
const ABSOLUTE_PATH = /(?<![\w:/\\.<>\]-])(?:[A-Za-z]:[\\/]+|\/)[^\s"'<>|*?]+/g

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
  'agentId',
  'promptId',
  'requestRef',
  'toolUseID',
  'hook_id'
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
/**
 * A composite id whose last part is the provider's own run id: Codex names a hook run
 * `<event>:<n>:<hooks file>:exec-<uuid>`. Only that last part is an id; the rest is scrubbed as text.
 */
const EMBEDDED_RUN_ID = /:exec-([A-Za-z0-9][A-Za-z0-9-]{7,})$/

function buildIdMap(values) {
  const found = []
  const used = new Set()
  for (const value of values) {
    walkFields(value, (key, item, parentKey) => {
      if (typeof item !== 'string' || !PROVIDER_ID_KEYS.has(key)) return
      if (NOT_PROVIDER_ID_PARENTS.has(parentKey)) return
      const embedded = EMBEDDED_RUN_ID.exec(item)
      const id = embedded ? embedded[1] : item
      const fake = FAKE_ID.exec(id)
      if (fake) used.add(Number.parseInt(fake[1], 16))
      else if (OPAQUE_ID.test(id)) found.push(id)
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

/**
 * The account and installation ids of one set, each to its placeholder: a value seen under an
 * account or installation key is replaced wherever the set repeats it (a log line, a path, a
 * rendered text), not only under its key.
 */
function buildPersonalIdMap(values) {
  const map = new Map()
  for (const value of values) {
    walkFields(value, (key, item) => {
      if (typeof item !== 'string') return
      if (ORGANIZATION_NAME_KEYS.has(key) && item.trim() !== '' && !item.startsWith('<')) {
        map.set(item, PLACEHOLDERS.organization)
        return
      }
      if (!OPAQUE_ID.test(item)) return
      if (ACCOUNT_ID_KEYS.has(key)) map.set(item, PLACEHOLDERS.account)
      else if (INSTALLATION_ID_KEYS.has(key)) map.set(item, PLACEHOLDERS.installation)
    })
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
  add('home', ANY_HOME_ENCODED, PLACEHOLDERS.home)
  add('claude-synced-skill', CLAUDE_SYNCED_SKILL_DIR, `$1${PLACEHOLDERS.syncedSkill}`)
  add('agent-scratchpad', AGENT_SCRATCHPAD, `$1${PLACEHOLDERS.scratchpad}`)
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
  if (key !== null && ORGANIZATION_NAME_KEYS.has(key) && typeof value === 'string') {
    return PLACEHOLDERS.organization
  }
  if (
    key !== null &&
    INSTALLATION_ID_KEYS.has(key) &&
    (typeof value === 'string' || typeof value === 'number')
  ) {
    return PLACEHOLDERS.installation
  }
  if (key !== null && OPAQUE_BLOB_KEYS.has(key) && typeof value === 'string') {
    return PLACEHOLDERS.signature
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
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every(isMcpServerStatus)) {
      return value.map((item, index) => placeholderMcpServer(item, index + 1, scrub))
    }
    return value.map((item) => scrubValue(item, scrub, shiftMs, key))
  }
  if (value !== null && typeof value === 'object') {
    const source = withoutPersonalPayload(value) ?? value
    const out = {}
    const init = isInitLine(source)
    const openCodeConfig = isOpenCodeConfig(source)
    for (const [field, item] of Object.entries(source)) {
      if (
        openCodeConfig &&
        Object.hasOwn(OPENCODE_CONFIG_MAPS, field) &&
        item !== null &&
        typeof item === 'object' &&
        !Array.isArray(item)
      ) {
        out[field] = placeholderMap(item, OPENCODE_CONFIG_MAPS[field], scrub)
        continue
      }
      if (field === 'availableCommands' && Array.isArray(item)) {
        out[field] = item.map((command) => placeholderCommand(command, scrub, shiftMs))
        continue
      }
      const stem =
        init && Object.hasOwn(INIT_ENVIRONMENT_LISTS, field) ? INIT_ENVIRONMENT_LISTS[field] : null
      out[scrub(field)] =
        stem !== null && Array.isArray(item)
          ? item.map((entry, index) => placeholderItem(entry, `<${stem}-${index + 1}>`))
          : scrubValue(item, scrub, shiftMs, field)
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
  const replacePersonalIds = idReplacer(buildPersonalIdMap(values))
  const replaceIds = idReplacer(buildIdMap(values))
  const shiftMs = timeShift(values)
  const replaceSetupNames = setupNameReplacer(buildSetupNameMap(values, documents))
  const scrub = (s) => scrubText(replaceSetupNames(replaceIds(replacePersonalIds(s))), rules)
  const scrubbed = documents.map(({ name, text }) => {
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
  return remeasureTiming(documents, scrubbed)
}

const TIMING_SUFFIX = '-timing.jsonl'

/** The byte offset at which each line of a JSONL text ends, its newline included. */
function lineEnds(text) {
  const ends = []
  let offset = 0
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    offset += Buffer.byteLength(line)
    ends.push(offset)
  }
  return ends
}

/**
 * The timing stream re-measured against the scrubbed streams (17 §1.4). The recorder counted the
 * raw bytes of each chunk, and scrubbing changes the length of a line (a path becomes `<REPO>`, a
 * name a placeholder), so a replay that cuts the scrubbed stream by the raw counts releases a line
 * after the wrong sent frames. Each chunk is given the scrubbed bytes of the lines it completed in
 * the raw stream (0 when it completed none), so every line completes after the same sent frames as
 * recorded. A stream whose scrubbed line count differs from its raw one is left as it is.
 */
function remeasureTiming(documents, scrubbed) {
  const raw = new Map(documents.map(({ name, text }) => [name, text]))
  const out = new Map(scrubbed.map(({ name, text }) => [name, text]))
  return scrubbed.map((document) => {
    if (!document.name.endsWith(TIMING_SUFFIX)) return document
    const caseName = document.name.slice(0, -TIMING_SUFFIX.length)
    const streams = new Map()
    const streamOf = (stream) => {
      if (!streams.has(stream)) {
        const file = stream === 'received' ? `${caseName}.jsonl` : `${caseName}-${stream}.jsonl`
        const before = raw.has(file) ? lineEnds(raw.get(file)) : []
        const after = out.has(file) ? lineEnds(out.get(file)) : []
        const usable = before.length > 0 && before.length === after.length
        streams.set(stream, usable ? { before, after, consumed: 0, done: 0, emitted: 0 } : null)
      }
      return streams.get(stream)
    }
    const text = document.text
      .split('\n')
      .map((line) => {
        if (line === '') return line
        let mark
        try {
          mark = JSON.parse(line)
        } catch {
          return line
        }
        if (typeof mark?.stream !== 'string' || typeof mark.bytes !== 'number') return line
        const state = streamOf(mark.stream)
        if (state === null) return line
        state.consumed += mark.bytes
        while (state.done < state.before.length && state.before[state.done] <= state.consumed) {
          state.done += 1
        }
        const end = state.done === 0 ? 0 : state.after[state.done - 1]
        const bytes = end - state.emitted
        state.emitted = end
        return JSON.stringify({ ...mark, bytes })
      })
      .join('\n')
    return { name: document.name, text }
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
