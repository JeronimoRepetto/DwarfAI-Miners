import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import {
  answerPermissionParamsSchema,
  answerQuestionParamsSchema,
  feedParamsSchema,
  jevSuggestParamsSchema,
  launchCustomParamsSchema,
  launchParamsSchema,
  resetMetricsParamsSchema,
  sendMessageParamsSchema,
  setOpenCodePermissionsParamsSchema,
  suppliersLaunchableParamsSchema,
  type AnswerOutcome,
  type AnswerPermissionParams,
  type AnswerQuestionParams,
  type FeedParams,
  type JevSuggestParams,
  type JevSuggestResult,
  type LaunchAccepted,
  type LaunchCustomParams,
  type LaunchParams,
  type MetricsResetResult,
  type ResetMetricsParams,
  type SendMessageParams,
  type SendMessageResult,
  type SetOpenCodePermissionsParams,
  type SetOpenCodePermissionsResult
} from '../host-protocol/params'
import type { IpcResult } from '../host-protocol'
import type { FeedPage, MineHistoryView, MineId, StopAllOutcome, SupplierEntryView } from '../wire'
import { CHANNELS, PRELOAD_HELPERS, todayShapeOf } from './channels'
import type { ChannelSpec } from './channelSpec'
import { ROW_IDS } from './rowIds'
import { TODAY_SHAPES } from './todayShapes'
import type {
  ActivateDwarfRequest,
  ConsoleOpenResult,
  OpenCodeSettingsView,
  UiPreferenceKey,
  UiPreferenceWrite,
  UiPreferencesMap
} from './windowApi'

/** One row of `__fixtures__/today-rows.json`: 14 §2.1 as written (hand-kept test data). */
interface TodayRow {
  id: string
  wire: string | null
  todayWire?: string
  member?: string
  kind: 'invoke' | 'send' | 'push' | 'sync helper'
  status: 'KEEP' | 'CHANGE' | 'RETIRE'
  placement: 'ui-local' | 'host' | 'split'
  sensitive: boolean
}

/** One row of the ISSUE-006 re-inventory table, as `readReinventoryTable` returns it. */
interface FoundRow {
  wire: string | null
  member: string | null
  kind: string | null
  id: string | null
  status: string | null
}

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..')
const TODAY_ROWS: TodayRow[] = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '__fixtures__', 'today-rows.json'), 'utf8')
)
const I21 = '§8 I-21'
const STATUS = { KEEP: 'kept', CHANGE: 'changed', RETIRE: 'retired' } as const

/**
 * The NEW rows of 14 §2.2 declared so far, as 14 writes them; each is declared by the issue that builds its handler
 * (22 §5) and added here in the same change.
 */
const NEW_ROWS = [
  {
    id: 'A-N30',
    wire: 'diag:renderer:report',
    member: 'reportRendererDiagnostic',
    kind: 'send',
    placement: 'ui-local',
    sensitive: false
  },
  {
    id: 'A-N25',
    wire: 'tray:stopEverything:requested',
    member: 'onStopEverythingRequested',
    kind: 'push',
    placement: 'ui-local',
    sensitive: false
  },
  {
    id: 'A-N26',
    wire: 'tray:stopEverything:confirm',
    member: 'confirmStopEverything',
    kind: 'invoke',
    placement: 'host',
    sensitive: false
  },
  {
    id: 'A-N27',
    wire: 'tray:stopEverything:cancel',
    member: 'cancelStopEverything',
    kind: 'send',
    placement: 'ui-local',
    sensitive: false
  },
  {
    id: 'A-N03',
    wire: 'host:connection:get',
    member: 'getHostConnection',
    kind: 'invoke',
    placement: 'ui-local',
    sensitive: false
  },
  {
    id: 'A-N04',
    wire: 'host:connection:changed',
    member: 'onHostConnection',
    kind: 'push',
    placement: 'ui-local',
    sensitive: false
  },
  {
    id: 'A-N05',
    wire: 'host:connection:retry',
    member: 'retryHostConnection',
    kind: 'invoke',
    placement: 'ui-local',
    sensitive: false
  },
  {
    id: 'A-N33',
    wire: 'host:connection:confirm-restart',
    member: 'confirmHostRestart',
    kind: 'invoke',
    placement: 'ui-local',
    sensitive: false
  },
  // AMENDMENT (owner-approved 2026-10-01, ISSUE-316): the renderer's own entry to Stop everything and quit
  {
    id: 'A-N34',
    wire: 'tray:stopEverything:request',
    member: 'requestStopEverything',
    kind: 'send',
    placement: 'ui-local',
    sensitive: false
  },
  // ISSUE-059: the UI-main session store (ADR-024 items 1, 3), born `ui-local` in cut 1
  {
    id: 'A-N17',
    wire: 'ui:session:get',
    member: 'getUiSession',
    kind: 'invoke',
    placement: 'ui-local',
    sensitive: false
  },
  {
    id: 'A-N18',
    wire: 'ui:session:patch',
    member: 'patchUiSession',
    kind: 'send',
    placement: 'ui-local',
    sensitive: false
  },
  {
    id: 'A-N19',
    wire: 'ui:session:changed',
    member: 'onUiSessionChanged',
    kind: 'push',
    placement: 'ui-local',
    sensitive: false
  },
  // ISSUE-060: the UI-main preference map (ADR-024 items 1, 9; AMENDMENT-6 `startWithSystem`), born `ui-local` in cut 1
  {
    id: 'A-N20',
    wire: 'ui:preferences:get',
    member: 'getUiPreferences',
    kind: 'invoke',
    placement: 'ui-local',
    sensitive: false
  },
  {
    id: 'A-N21',
    wire: 'ui:preferences:set',
    member: 'setUiPreference',
    kind: 'invoke',
    placement: 'ui-local',
    sensitive: false
  },
  // ISSUE-082: the Host read path of every Host-fed read model (ADR-033 item 3), born `host` in cut 1; both carry
  // sensitive Host data (14 §3.5 `session.snapshot` result, SENSITIVE_FRAMES)
  {
    id: 'A-N01',
    wire: 'host:snapshot',
    member: 'getHostSnapshot',
    kind: 'invoke',
    placement: 'host',
    sensitive: true
  },
  {
    id: 'A-N02',
    wire: 'host:event',
    member: 'onHostEvent',
    kind: 'push',
    placement: 'host',
    sensitive: true
  }
] as const
const NEW_WIRES: readonly string[] = NEW_ROWS.map((row) => row.wire)

const registry: Record<string, ChannelSpec<z.ZodTypeAny, z.ZodTypeAny>> = CHANNELS
const keyOf = (row: TodayRow): string => row.wire ?? row.member ?? row.id

async function foundRows(): Promise<FoundRow[]> {
  // Loaded by URL: the scanner is plain ESM under scripts/ and ships no type declarations.
  const scanner = new URL('../../../scripts/checks/ipc-reinventory.mjs', import.meta.url).href
  const { readReinventoryTable } = (await import(/* @vite-ignore */ scanner)) as {
    readReinventoryTable: (markdown: string) => FoundRow[]
  }
  const markdown = readFileSync(
    resolve(REPO_ROOT, 'docs', 'strangler', 'registry-reinventory.md'),
    'utf8'
  )
  return readReinventoryTable(markdown)
}

/** Every `ZodObject` reachable from a schema whose unknown keys are not `strict`, by path. */
function nonStrictObjects(schema: z.ZodTypeAny, path: string, seen = new Set<unknown>()): string[] {
  if (seen.has(schema)) return []
  seen.add(schema)
  const def = schema._def as Record<string, unknown> & { typeName: z.ZodFirstPartyTypeKind }
  const walk = (inner: unknown, at: string): string[] =>
    nonStrictObjects(inner as z.ZodTypeAny, at, seen)
  const K = z.ZodFirstPartyTypeKind
  switch (def.typeName) {
    case K.ZodObject: {
      const shape = (schema as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>
      const own = def.unknownKeys === 'strict' ? [] : [path]
      return [
        ...own,
        ...Object.entries(shape).flatMap(([key, value]) => walk(value, `${path}.${key}`))
      ]
    }
    case K.ZodOptional:
    case K.ZodNullable:
    case K.ZodDefault:
    case K.ZodReadonly:
    case K.ZodCatch:
      return walk(def.innerType, path)
    case K.ZodArray:
      return walk(def.type, `${path}[]`)
    case K.ZodUnion:
    case K.ZodDiscriminatedUnion:
      return (def.options as z.ZodTypeAny[]).flatMap((option, i) => walk(option, `${path}|${i}`))
    case K.ZodEffects:
      return walk(def.schema, path)
    case K.ZodBranded:
      return walk(def.type, path)
    case K.ZodRecord:
      return walk(def.valueType, `${path}{}`)
    case K.ZodTuple:
      return (def.items as z.ZodTypeAny[]).flatMap((item, i) => walk(item, `${path}[${i}]`))
    case K.ZodIntersection:
      return [...walk(def.left, path), ...walk(def.right, path)]
    case K.ZodPipeline:
      return [...walk(def.in, path), ...walk(def.out, path)]
    case K.ZodLazy:
      return walk((def.getter as () => z.ZodTypeAny)(), path)
    default:
      return []
  }
}

// ---- fuzz (14 §6.5 "Schemas"): one valid payload per request schema, then one mutation per class

const U1 = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b'
const U2 = '0190a1b2-c3d4-7e5f-9a6b-7c8d9e0f1a2c'
const LEGACY_DWARF = 'claude:3f1c9a2e-session'
const CONFIRMATION = '6f1d2c3b-4a59-4e6d-8c7b-9a0b1c2d3e4f'
const LEGACY_MINE = 'mine:/home/person/project'
const TYPOGRAPHY = {
  style: 'dwarfai',
  faces: { display: 'jacquard-12', label: 'tiny5', meta: 'tiny5', talk: 'roboto' }
}

/** A valid target request for every renderer → main entry (invoke, send, the preload helper). */
const VALID_REQUESTS: Record<string, unknown> = {
  'panel:hide': undefined,
  'panel:raise': undefined,
  'panel:getAlwaysOnTop': undefined,
  'panel:setAlwaysOnTop': true,
  'panel:visible:get': undefined,
  'audio:preferences:get': undefined,
  'audio:preferences:set': {
    musicAtStartup: true,
    musicVolume: 0.5,
    ambienceVolume: 0.25,
    voiceVolume: 1,
    notificationSounds: false
  },
  'panel:layout:get': undefined,
  'panel:layout:set': { mineOpen: false, dockOpen: true, edge: 'left' },
  'shortcut:get': undefined,
  'shortcut:set': 'Control+Shift+D',
  'mines:get': undefined,
  'dwarf:activate': { dwarfId: U1, purpose: 'open-console' },
  'dwarf:feed': LEGACY_DWARF,
  'dwarf:feed:page': { dwarfId: U1, page: { before: U2, limit: 20 } },
  'panel:watchDwarfFeed': LEGACY_DWARF,
  'dwarf:refreshTelemetry': LEGACY_DWARF,
  'dwarf:setTuning': { dwarfId: LEGACY_DWARF, change: { kind: 'model', model: 'opus' } },
  'mine:history': U1,
  'mine:openPath': { mineId: LEGACY_MINE, target: 'src/index.ts', dwarfId: LEGACY_DWARF },
  'shell:openExternalLink': 'https://example.com/docs',
  'shell:copyText': 'copied words',
  'dwarf:sendText': { dwarfId: U1, text: 'hello', attachments: ['/tmp/a.png'], requestId: U2 },
  'dwarf:attachments:choose': undefined,
  'dwarf:attachments:describe': ['/tmp/a.png', '/tmp/b.txt'],
  'dwarf:kick': { dwarfId: LEGACY_DWARF },
  'dwarf:retire': LEGACY_DWARF,
  'app:build': undefined,
  'app:features': undefined,
  'mine:declare': undefined,
  'mine:declare-main': undefined,
  'mine:undeclare': LEGACY_MINE,
  'metrics:reset': { confirmed: 'yes', requestId: U1 },
  'projects:query': {
    sortBy: 'addedAt',
    direction: 'desc',
    nameContains: 'dw',
    limit: 10,
    offset: 0
  },
  'agent:launch': {
    mineId: U1,
    way: { kind: 'supplier', providerId: 'claude' },
    model: 'opus',
    prompt: 'start here',
    jevOn: false,
    jevAutoAccept: false,
    requestId: U2
  },
  'agent:providers': { refresh: true },
  'agent:models': undefined,
  'agent:launchHeld': { mineId: LEGACY_MINE, provider: 'claude', prompt: 'start here' },
  'agent:launchHosted': { mineId: U1, command: 'my-cli --flag', prompt: 'go', requestId: U2 },
  'agent:answerQuestion': { askId: U1, answers: [{ step: 0, option: 'Yes' }], requestId: U2 },
  'agent:answerPermission': { askId: U1, decision: 'allow', requestId: U2 },
  'notifications:enabled:get': undefined,
  'notifications:enabled:set': true,
  'presence:visibleMines': { mineIds: [U1, U2] },
  'typography:preferences:get': undefined,
  'typography:preferences:set': TYPOGRAPHY,
  'jev:settings:get': undefined,
  'jev:apiKey:set': 'sk-test-key',
  'jev:apiKey:clear': undefined,
  'jev:route': { prompt: 'which model', mineId: U1 },
  'jev:preferences:set': {
    profile: 'balanced',
    default: { provider: 'claude' },
    delegation: false
  },
  'opencode:settings:get': undefined,
  'opencode:plugin:set': { on: true, origin: 'settings', requestId: U1 },
  'opencode:password:set': 'server-password',
  'opencode:password:clear': undefined,
  'launch-view:get': undefined,
  'launch-view:set': { area: 'mines', mineId: null },
  pathForDroppedFile: new File(['x'], 'dropped.txt'),
  'dwarf:setName': { dwarfId: LEGACY_DWARF, name: 'Gimli' },
  'dwarf:resetName': LEGACY_DWARF,
  'diag:renderer:report': { event: 'renderer.error', errCode: 'TypeError', count: 3 },
  'tray:stopEverything:confirm': { confirmationId: CONFIRMATION, requestId: U2 },
  'tray:stopEverything:cancel': { confirmationId: CONFIRMATION },
  'tray:stopEverything:request': undefined,
  'host:connection:get': undefined,
  'host:connection:retry': undefined,
  'host:connection:confirm-restart': undefined,
  'ui:session:get': undefined,
  'ui:session:patch': { kind: 'draft', dwarfId: U1, text: 'half a thought' },
  'ui:preferences:get': { keys: ['startWithSystem', 'lastMode'] },
  'ui:preferences:set': { key: 'startWithSystem', value: false },
  'host:snapshot': { sections: ['mines', 'dwarfs'] }
}

/** A valid today request for every renderer → main row whose today shape differs (CHANGE rows). */
const VALID_TODAY_REQUESTS: Record<string, unknown> = {
  'dwarf:activate': LEGACY_DWARF,
  'dwarf:feed:page': {
    dwarfId: LEGACY_DWARF,
    before: { timestamp: '2026-09-30T10:00:00.000Z', text: 'older words' }
  },
  'mine:history': LEGACY_MINE,
  'dwarf:sendText': {
    dwarfId: LEGACY_DWARF,
    text: 'hello',
    pressEnter: true,
    attachments: [{ path: '/tmp/a.png', name: 'a.png', kind: 'image', bytes: 10 }]
  },
  'metrics:reset': undefined,
  'agent:launch': {
    mineId: LEGACY_MINE,
    provider: 'codex',
    prompt: 'go',
    permissionMode: 'default'
  },
  'agent:providers': undefined,
  'agent:launchHosted': { mineId: LEGACY_MINE, command: 'my-cli', prompt: 'go' },
  'agent:answerQuestion': {
    dwarfId: LEGACY_DWARF,
    toolUseId: 'toolu_01',
    answers: { 'Which one?': 'The first' }
  },
  'agent:answerPermission': { dwarfId: LEGACY_DWARF, toolUseId: 'toolu_02', decision: 'deny' },
  'presence:visibleMines': LEGACY_MINE,
  'jev:route': { prompt: 'which model' },
  'opencode:settings:get': undefined,
  'opencode:plugin:set': true,
  'opencode:password:set': 'server-password',
  'opencode:password:clear': undefined
}

const OVERSIZED = 'x'.repeat(1_048_577)

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof File)

type Mutation = { label: string; value: unknown }

/** Replace the node at `path` inside `root`, copying every container on the way. */
function replaceAt(root: unknown, path: (string | number)[], value: unknown): unknown {
  if (path.length === 0) return value
  const [head, ...rest] = path as [string | number, ...(string | number)[]]
  if (Array.isArray(root)) {
    const copy = [...root]
    copy[head as number] = replaceAt(copy[head as number], rest, value)
    return copy
  }
  const record = root as Record<string, unknown>
  return { ...record, [head]: replaceAt(record[head], rest, value) }
}

/** Every node of a payload with its path. */
function nodes(value: unknown, path: (string | number)[] = []): [(string | number)[], unknown][] {
  const children = Array.isArray(value)
    ? value.flatMap((item, i) => nodes(item, [...path, i]))
    : isPlainObject(value)
      ? Object.entries(value).flatMap(([key, item]) => nodes(item, [...path, key]))
      : []
  return [[path, value], ...children]
}

function wrongTypeOf(value: unknown): unknown {
  if (typeof value === 'string') return 42
  if (typeof value === 'number') return '42'
  if (typeof value === 'boolean') return 'true'
  if (value === null) return 42
  if (value === undefined) return 'unexpected'
  return 42
}

const where = (path: (string | number)[]): string =>
  path.length === 0 ? 'the payload' : path.join('.')

function extraKeyCases(valid: unknown): Mutation[] {
  return nodes(valid)
    .filter(([, value]) => isPlainObject(value))
    .map(([path, value]) => ({
      label: `extra key at ${where(path)}`,
      value: replaceAt(valid, path, { ...(value as object), unexpectedKey: true })
    }))
}

function wrongTypeCases(valid: unknown): Mutation[] {
  const depthOne = nodes(valid).filter(([path]) => path.length <= 1)
  return depthOne.map(([path, value]) => ({
    label: `wrong type at ${where(path)}`,
    value: replaceAt(valid, path, wrongTypeOf(value))
  }))
}

function oversizedCases(valid: unknown): Mutation[] {
  return nodes(valid)
    .filter(([, value]) => typeof value === 'string')
    .map(([path]) => ({
      label: `oversized string at ${where(path)}`,
      value: replaceAt(valid, path, OVERSIZED)
    }))
}

const FUZZ_CLASSES = {
  'extra keys': extraKeyCases,
  'wrong types': wrongTypeCases,
  'oversized strings': oversizedCases
}

describe('CHANNELS registry (14 §2.1, ADR-019 item 6)', () => {
  it('[ADR-019] every today row of 14 §2.1 has exactly one CHANNELS entry with its kind, status, placement and sensitive flag', () => {
    expect(TODAY_ROWS).toHaveLength(64)
    for (const row of TODAY_ROWS) {
      const key = keyOf(row)
      const entries = Object.entries(registry).filter(([k]) => ROW_IDS[k] === row.id)
      expect(
        entries.map(([k]) => k),
        `${row.id} has exactly one entry`
      ).toEqual([key])
      const entry = registry[key]
      expect(entry, `${row.id} (${key})`).toBeDefined()
      if (!entry) continue
      expect(entry.name, `${row.id} name`).toBe(key)
      if (row.kind === 'sync helper') {
        expect(PRELOAD_HELPERS, `${row.id} is preload-only`).toContain(key)
        expect(entry.kind, `${row.id} kind`).toBe('invoke')
      } else {
        expect(PRELOAD_HELPERS, `${row.id} is not preload-only`).not.toContain(key)
        expect(entry.kind, `${row.id} kind`).toBe(row.kind)
      }
      expect(entry.status, `${row.id} status`).toBe(STATUS[row.status])
      expect(entry.placement, `${row.id} placement`).toBe(row.placement)
      expect(entry.sensitive === true, `${row.id} sensitive`).toBe(row.sensitive)
      if (row.todayWire) expect(ROW_IDS[row.todayWire], `${row.todayWire}`).toBe(row.id)
    }
    // Besides the 64 rows, the registry holds only the two legacy rows of 14 §8 I-21 (AMENDMENT-12) and the NEW
    // rows of 14 §2.2 declared so far.
    const others = Object.keys(registry).filter(
      (k) => !TODAY_ROWS.some((row) => keyOf(row) === k) && !NEW_WIRES.includes(k)
    )
    expect(others.sort()).toEqual(['dwarf:resetName', 'dwarf:setName'])
    for (const row of NEW_ROWS) {
      expect(ROW_IDS[row.wire], `${row.id} row id`).toBe(row.id)
      expect(registry[row.wire], row.id).toMatchObject({
        name: row.wire,
        kind: row.kind,
        status: 'new',
        placement: row.placement
      })
      expect(registry[row.wire]?.sensitive === true, `${row.id} sensitive`).toBe(row.sensitive)
    }
    for (const key of others) {
      expect(ROW_IDS[key]).toBe(I21)
      expect(registry[key]).toMatchObject({
        name: key,
        kind: 'invoke',
        status: 'retired',
        placement: 'host'
      })
      expect(registry[key]?.sensitive).toBeUndefined()
    }
  })

  it('[ADR-019] every found registration, preload member and push of the re-inventory maps to exactly one CHANNELS entry or is a NEW / UNLISTED row', async () => {
    const table = await foundRows()
    // The table also lists the 34 NEW rows of 14 §2.2 that the found tree does not have yet.
    // AMENDED for the A-N34 amendment (owner-approved 2026-10-01, ISSUE-316; was: 33): seam A NEW 33 → 34.
    const found = table.filter((row) => row.status !== 'NEW')
    expect(found).toHaveLength(66)
    expect(table.filter((row) => row.status === 'NEW')).toHaveLength(34)
    const resolveEntry = (key: string): string[] => {
      if (key in registry) return [key]
      const id = ROW_IDS[key]
      return Object.keys(registry).filter(
        (k) => id !== undefined && id !== I21 && ROW_IDS[k] === id
      )
    }
    for (const row of table) {
      const key = row.wire ?? row.member ?? ''
      if (row.status === 'NEW' || row.status === 'UNLISTED') {
        // A NEW row is declared only by the issue that builds its handler (NEW_ROWS); an UNLISTED one never is.
        const declared = row.status === 'NEW' && NEW_WIRES.includes(key)
        expect(key in registry, `${key} is ${row.status}, declared: ${declared}`).toBe(declared)
        if (declared) expect(ROW_IDS[key], `${key} row id`).toBe(row.id)
        continue
      }
      expect(ROW_IDS[key], `${key} row id`).toBe(row.id)
      const entries = resolveEntry(key)
      expect(entries, `${key} maps to one entry`).toHaveLength(1)
      const entry = registry[entries[0] ?? '']
      expect(entry?.status, `${key} status`).toBe(STATUS[row.status as keyof typeof STATUS])
    }
    // No entry lacks a 14 row: each is a 14 §2.1 row or a §8 I-21 legacy row, and each was found, or a NEW row of
    // the re-inventory's NEW list.
    const foundIds = new Set(found.map((row) => row.id))
    const newIds = new Set(table.filter((row) => row.status === 'NEW').map((row) => row.id))
    for (const key of Object.keys(registry)) {
      const id = ROW_IDS[key]
      expect(id, `${key} has a 14 row`).toBeDefined()
      const listed = NEW_WIRES.includes(key) ? newIds : foundIds
      expect(listed.has(id ?? null), `${key} (${id}) is in the re-inventory`).toBe(true)
    }
  })

  it("[ADR-001] every CHANGE and RETIRE row has a today shape and every KEEP row's today shape is its target shape", () => {
    const rows = [
      ...TODAY_ROWS.map((row) => ({ key: keyOf(row), status: row.status })),
      { key: 'dwarf:setName', status: 'RETIRE' as const },
      { key: 'dwarf:resetName', status: 'RETIRE' as const }
    ]
    for (const { key, status } of rows) {
      const entry = registry[key]
      const today = TODAY_SHAPES[key]
      expect(entry, key).toBeDefined()
      if (!entry) continue
      if (status === 'KEEP') {
        expect(today, `${key} (KEEP) has no separate today shape`).toBeUndefined()
        expect(todayShapeOf(key)?.request, `${key} today request`).toBe(entry.request)
        expect(todayShapeOf(key)?.response, `${key} today response`).toBe(entry.response)
        continue
      }
      expect(today, `${key} (${status}) today shape`).toBeDefined()
      expect(todayShapeOf(key), `${key}`).toBe(today)
      if (status === 'RETIRE') {
        // A RETIRE row has no target: its target schema is its today schema.
        expect(entry.request, `${key} request`).toBe(today?.request)
        expect(entry.response, `${key} response`).toBe(today?.response)
      } else {
        const differs = entry.request !== today?.request || entry.response !== today?.response
        expect(differs, `${key} (CHANGE) today shape differs from its target`).toBe(true)
      }
    }
    expect(Object.keys(TODAY_SHAPES).sort()).toEqual(
      rows
        .filter((row) => row.status !== 'KEEP')
        .map((row) => row.key)
        .sort()
    )
  })

  it('[ADR-019] every object schema of every entry is strict', () => {
    expect(Object.keys(registry)).toHaveLength(66 + NEW_ROWS.length)
    const offenders = [
      ...Object.entries(registry).flatMap(([key, entry]) => [
        ...nonStrictObjects(entry.request, `${key}.request`),
        ...nonStrictObjects(entry.response, `${key}.response`)
      ]),
      ...Object.entries(TODAY_SHAPES).flatMap(([key, shape]) => [
        ...nonStrictObjects(shape.request, `${key}.today.request`),
        ...nonStrictObjects(shape.response, `${key}.today.response`)
      ])
    ]
    expect(offenders).toEqual([])
  })

  it('[ADR-019] each request schema refuses extra keys, wrong types and oversized strings', () => {
    const targets = Object.entries(registry).filter(([, entry]) => entry.kind !== 'push')
    expect(Object.keys(VALID_REQUESTS).sort()).toEqual(targets.map(([key]) => key).sort())
    const todays = Object.keys(VALID_TODAY_REQUESTS)
    const changedRequestRows = targets
      .filter(([key, entry]) => entry.status === 'changed' && TODAY_SHAPES[key])
      .map(([key]) => key)
    expect(todays.sort()).toEqual(changedRequestRows.sort())
    const subjects = [
      ...targets.map(([key, entry]) => ({
        key,
        schema: entry.request,
        valid: VALID_REQUESTS[key]
      })),
      ...todays.map((key) => ({
        key: `${key} (today)`,
        schema: (TODAY_SHAPES[key] as { request: z.ZodTypeAny }).request,
        valid: VALID_TODAY_REQUESTS[key]
      }))
    ]
    const perClass: Record<string, number> = {}
    for (const { key, schema, valid } of subjects) {
      expect(schema.safeParse(valid).success, `${key}: the valid payload parses`).toBe(true)
      for (const [name, cases] of Object.entries(FUZZ_CLASSES)) {
        for (const mutation of cases(valid)) {
          perClass[name] = (perClass[name] ?? 0) + 1
          expect(schema.safeParse(mutation.value).success, `${key}: ${mutation.label}`).toBe(false)
        }
      }
    }
    // Every class is exercised: object payloads, typed payloads and string fields all exist.
    expect(Object.keys(perClass).sort()).toEqual(Object.keys(FUZZ_CLASSES).sort())
    // 06 MessageText is bounded in UTF-8 bytes, not in characters: 21 846 '€' are 65 538 bytes.
    const send = registry['dwarf:sendText']?.request
    const withText = (text: string) => ({ ...(VALID_REQUESTS['dwarf:sendText'] as object), text })
    expect(send?.safeParse(withText('€'.repeat(21_845))).success, '65 535 bytes').toBe(true)
    expect(send?.safeParse(withText('€'.repeat(21_846))).success, '65 538 bytes').toBe(false)
  })

  it("[ADR-019] A-53's request refuses origin 'first-run', which only answerWelcome carries (14 §3.4, AMENDMENT-7)", () => {
    const request = registry['opencode:plugin:set']?.request
    const valid = VALID_REQUESTS['opencode:plugin:set'] as object
    expect(request?.safeParse({ ...valid, origin: 'add-panel' }).success).toBe(true)
    expect(request?.safeParse({ ...valid, origin: 'first-run' }).success).toBe(false)
  })

  it("[ADR-019] a host-placed CHANGE row's target request is the same schema object as its seam-B params", () => {
    const SAME_AS_PARAMS: Record<string, z.ZodTypeAny> = {
      'dwarf:feed:page': feedParamsSchema, // A-15 → conversation.feed
      'dwarf:sendText': sendMessageParamsSchema, // A-23 → conversation.send
      'metrics:reset': resetMetricsParamsSchema, // A-33 → preferences.resetMetrics
      'agent:launch': launchParamsSchema, // A-35 → launching.launch
      'agent:providers': suppliersLaunchableParamsSchema, // A-36 → suppliers.launchable
      'agent:launchHosted': launchCustomParamsSchema, // A-39 → launching.launchCustom
      'agent:answerQuestion': answerQuestionParamsSchema, // A-40 → asking.answerQuestion
      'agent:answerPermission': answerPermissionParamsSchema, // A-41 → asking.answerPermission
      'jev:route': jevSuggestParamsSchema, // A-50 → jev.suggest
      'opencode:plugin:set': setOpenCodePermissionsParamsSchema // A-53 → preferences.setOpenCodePermissions
    }
    // 14 §3.8 gives these members a request that is not the params object: main builds the params.
    const MAIN_BUILDS_PARAMS = [
      'mine:history', // A-19 getMineHistory(mineId) → conversation.mineHistory { mineId }
      'opencode:settings:get', // A-52 getOpenCodeSettings() → preferences.get {}
      'opencode:password:set', // A-54 setOpenCodeServerPassword(value) → settings.secret.set { name, value, … }
      'opencode:password:clear' // A-55 clearOpenCodeServerPassword() → settings.secret.clear { name, requestId }
    ]
    const hostChanged = TODAY_ROWS.filter(
      (row) => row.status === 'CHANGE' && row.placement === 'host'
    )
    expect(hostChanged.map(keyOf).sort()).toEqual(
      [...Object.keys(SAME_AS_PARAMS), ...MAIN_BUILDS_PARAMS].sort()
    )
    for (const [key, params] of Object.entries(SAME_AS_PARAMS)) {
      expect(registry[key]?.request, `${key} request`).toBe(params)
    }
  })

  it('[ADR-019] the zod-inferred type of every target schema equals the 14 §3 type it implements', () => {
    type Req<K extends keyof typeof CHANNELS> = z.infer<(typeof CHANNELS)[K]['request']>
    type Res<K extends keyof typeof CHANNELS> = z.infer<(typeof CHANNELS)[K]['response']>
    // One pair per changed member of 14 §3.8 `DwarfAiMinersApiDelta`.
    expectTypeOf<Req<'dwarf:activate'>>().toEqualTypeOf<ActivateDwarfRequest>()
    expectTypeOf<Res<'dwarf:activate'>>().toEqualTypeOf<IpcResult<ConsoleOpenResult>>()
    expectTypeOf<Req<'dwarf:feed:page'>>().toEqualTypeOf<FeedParams>()
    expectTypeOf<Res<'dwarf:feed:page'>>().toEqualTypeOf<IpcResult<FeedPage>>()
    expectTypeOf<Req<'mine:history'>>().toEqualTypeOf<MineId>()
    expectTypeOf<Res<'mine:history'>>().toEqualTypeOf<IpcResult<MineHistoryView>>()
    expectTypeOf<Req<'dwarf:sendText'>>().toEqualTypeOf<SendMessageParams>()
    expectTypeOf<Res<'dwarf:sendText'>>().toEqualTypeOf<IpcResult<SendMessageResult>>()
    expectTypeOf<Req<'metrics:reset'>>().toEqualTypeOf<ResetMetricsParams>()
    expectTypeOf<Res<'metrics:reset'>>().toEqualTypeOf<IpcResult<MetricsResetResult>>()
    expectTypeOf<Req<'agent:launch'>>().toEqualTypeOf<LaunchParams>()
    expectTypeOf<Res<'agent:launch'>>().toEqualTypeOf<IpcResult<LaunchAccepted>>()
    expectTypeOf<Req<'agent:providers'>>().toEqualTypeOf<{ refresh?: boolean }>()
    expectTypeOf<Res<'agent:providers'>>().toEqualTypeOf<IpcResult<SupplierEntryView[]>>()
    expectTypeOf<Req<'agent:launchHosted'>>().toEqualTypeOf<LaunchCustomParams>()
    expectTypeOf<Res<'agent:launchHosted'>>().toEqualTypeOf<IpcResult<LaunchAccepted>>()
    expectTypeOf<Req<'agent:answerQuestion'>>().toEqualTypeOf<AnswerQuestionParams>()
    expectTypeOf<Res<'agent:answerQuestion'>>().toEqualTypeOf<IpcResult<AnswerOutcome>>()
    expectTypeOf<Req<'agent:answerPermission'>>().toEqualTypeOf<AnswerPermissionParams>()
    expectTypeOf<Res<'agent:answerPermission'>>().toEqualTypeOf<IpcResult<AnswerOutcome>>()
    expectTypeOf<Req<'presence:visibleMines'>>().toEqualTypeOf<{ mineIds: MineId[] }>()
    expectTypeOf<Res<'presence:visibleMines'>>().toEqualTypeOf<undefined>()
    expectTypeOf<Req<'jev:route'>>().toEqualTypeOf<JevSuggestParams>()
    expectTypeOf<Res<'jev:route'>>().toEqualTypeOf<IpcResult<JevSuggestResult>>()
    expectTypeOf<Req<'opencode:settings:get'>>().toEqualTypeOf<undefined>()
    expectTypeOf<Res<'opencode:settings:get'>>().toEqualTypeOf<IpcResult<OpenCodeSettingsView>>()
    expectTypeOf<Req<'opencode:plugin:set'>>().toEqualTypeOf<SetOpenCodePermissionsParams>()
    expectTypeOf<Res<'opencode:plugin:set'>>().toEqualTypeOf<
      IpcResult<SetOpenCodePermissionsResult>
    >()
    expectTypeOf<Req<'opencode:password:set'>>().toEqualTypeOf<string>()
    expectTypeOf<Res<'opencode:password:set'>>().toEqualTypeOf<IpcResult<OpenCodeSettingsView>>()
    expectTypeOf<Req<'opencode:password:clear'>>().toEqualTypeOf<undefined>()
    expectTypeOf<Res<'opencode:password:clear'>>().toEqualTypeOf<IpcResult<OpenCodeSettingsView>>()
    // NEW members of 14 §3.8 declared so far.
    expectTypeOf<Res<'tray:stopEverything:requested'>>().toEqualTypeOf<{ confirmationId: string }>()
    expectTypeOf<Req<'tray:stopEverything:confirm'>>().toEqualTypeOf<{
      confirmationId: string
      requestId: string
    }>()
    expectTypeOf<Res<'tray:stopEverything:confirm'>>().toEqualTypeOf<IpcResult<StopAllOutcome>>()
    expectTypeOf<Req<'tray:stopEverything:cancel'>>().toEqualTypeOf<{ confirmationId: string }>()
    expectTypeOf<Res<'tray:stopEverything:cancel'>>().toEqualTypeOf<undefined>()
    // A-N20, A-N21 (ISSUE-060): the request asks for any key of the map; the answers and the renderer's writes hold the
    // keys built so far, each typed as 14 §3.9 types it (lastMode and resetEpochApplied are never a renderer's write).
    expectTypeOf<Req<'ui:preferences:get'>>().toEqualTypeOf<{ keys: UiPreferenceKey[] }>()
    expectTypeOf<Res<'ui:preferences:get'>>().toMatchTypeOf<Partial<UiPreferencesMap>>()
    expectTypeOf<Req<'ui:preferences:set'>>().toMatchTypeOf<UiPreferenceWrite>()
    expectTypeOf<Res<'ui:preferences:set'>>().toMatchTypeOf<UiPreferenceWrite>()
  })

  it('[ADR-002] the Stop everything rows carry the confirmationId UI main issued and A-N26 the requestId of host.shutdown', () => {
    const push = registry['tray:stopEverything:requested']?.response
    expect(push?.safeParse({ confirmationId: CONFIRMATION }).success).toBe(true)
    expect(push?.safeParse({ confirmationId: 'not-an-id' }).success).toBe(false)
    const confirm = registry['tray:stopEverything:confirm']?.request
    expect(confirm?.safeParse({ confirmationId: CONFIRMATION, requestId: 'r-1' }).success).toBe(
      false
    )
    const answer = registry['tray:stopEverything:confirm']?.response
    expect(answer?.safeParse({ ok: true, value: { ended: [U1], failed: [U2] } }).success).toBe(true)
    expect(answer?.safeParse({ ok: true, value: { ended: [U1] } }).success).toBe(false)
  })
})
