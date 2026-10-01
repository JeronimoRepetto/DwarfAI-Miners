#!/usr/bin/env node
/**
 * Generates `window.api` from the seam A channel registry (ISSUE-045; ADR-019 items 1, 6; ADR-033 items 6, 7;
 * 14 §1.4, §2.1; 21 §1 item 2a):
 *
 * - `src/preload/index.ts`: one member per registry row (`CHANNELS` in `src/contracts/ipc`), named as 14 names it,
 *   speaking on the wire and with the types of the shape its route uses in this release (`shape` in
 *   `src/ui-main/ipc/routes.ts`): today's wire and today's types (`TODAY_SHAPES`) while the route is `today`, the
 *   registry key and the target types once it is `target`. The preload coerces for ergonomics and never throws: a
 *   value it cannot coerce is passed on for main to refuse, and a payload structured clone cannot copy is dropped by
 *   a send and rejected by an invoke (`IPC_GUARDS`; 14 §1.4).
 * - `src/contracts/ipc/testing/fakeWindowApi.ts`: `createFakeWindowApi(overrides)` with every member, for renderer
 *   tests; reading a member the registry does not have fails the test (17 §1.6).
 *
 * Adding a channel means adding its registry row (and, for a NEW row, its member name below) and running
 * `pnpm ipc:generate`. The generated files are never edited by hand (22 §5); `src/preload/preload.contract.test.ts`
 * fails when they differ from a fresh generation.
 *
 * Usage: node scripts/ipc/generate-window-api.mjs [--check]   (--check writes nothing and exits 1 on drift)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PRELOAD_FILE = 'src/preload/index.ts'
export const FAKE_FILE = 'src/contracts/ipc/testing/fakeWindowApi.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * The `window.api` member of each registry row, as 14 names it: §2.1 (A-01…A-57, A-P1…A-P6, A-X1) and §8 I-21
 * (the two legacy rows). A row renamed by its CHANGE (only A-44, 14 §1.1) names both: today's member while its route
 * keeps `shape: 'today'`, the 14 member once it is `target`. A NEW row (14 §2.2) adds its member here in the PR
 * that declares the row (22 §5).
 */
const MEMBERS = {
  'panel:hide': 'hidePanel',
  'panel:raise': 'raisePanel',
  'panel:getAlwaysOnTop': 'getAlwaysOnTop',
  'panel:setAlwaysOnTop': 'setAlwaysOnTop',
  'panel:visible:get': 'getPanelVisible',
  'audio:preferences:get': 'getAudioPreferences',
  'audio:preferences:set': 'setAudioPreferences',
  'panel:layout:get': 'getPanelLayout',
  'panel:layout:set': 'setPanelLayout',
  'shortcut:get': 'getToggleShortcut',
  'shortcut:set': 'setToggleShortcut',
  'mines:get': 'getMines',
  'dwarf:activate': 'activateDwarf',
  'dwarf:feed': 'getDwarfFeed',
  'dwarf:feed:page': 'getDwarfFeedPage',
  'panel:watchDwarfFeed': 'setWatchedDwarf',
  'dwarf:refreshTelemetry': 'refreshDwarfTelemetry',
  'dwarf:setTuning': 'setDwarfTuning',
  'mine:history': 'getMineHistory',
  'mine:openPath': 'openMinePath',
  'shell:openExternalLink': 'openExternalLink',
  'shell:copyText': 'copyText',
  'dwarf:sendText': 'sendDwarfText',
  'dwarf:attachments:choose': 'chooseDwarfAttachments',
  'dwarf:attachments:describe': 'describeDwarfAttachments',
  'dwarf:kick': 'kickDwarf',
  'dwarf:retire': 'retireDwarf',
  'app:build': 'getAppBuild',
  'app:features': 'getFeatureFlags',
  'mine:declare': 'declareMine',
  'mine:declare-main': 'declareMainProject',
  'mine:undeclare': 'undeclareMine',
  'metrics:reset': 'resetMetrics',
  'projects:query': 'queryProjects',
  'agent:launch': 'launchAgent',
  'agent:providers': 'listAgentProviders',
  'agent:models': 'listAgentModels',
  'agent:launchHeld': 'launchHeldSession',
  'agent:launchHosted': 'launchHostedProcess',
  'agent:answerQuestion': 'answerDwarfQuestion',
  'agent:answerPermission': 'answerDwarfPermission',
  'notifications:enabled:get': 'getNotificationsEnabled',
  'notifications:enabled:set': 'setNotificationsEnabled',
  'presence:visibleMines': { today: 'setOpenMine', target: 'reportVisibleMines' },
  'typography:preferences:get': 'getTypographyPreferences',
  'typography:preferences:set': 'setTypographyPreferences',
  'jev:settings:get': 'getJevSettings',
  'jev:apiKey:set': 'setJevApiKey',
  'jev:apiKey:clear': 'clearJevApiKey',
  'jev:route': 'routeJevLaunch',
  'jev:preferences:set': 'setJevPreferences',
  'opencode:settings:get': 'getOpenCodeSettings',
  'opencode:plugin:set': 'setOpenCodePluginEnabled',
  'opencode:password:set': 'setOpenCodeServerPassword',
  'opencode:password:clear': 'clearOpenCodeServerPassword',
  'launch-view:get': 'getLaunchView',
  'launch-view:set': 'setLaunchView',
  'panel:visible:changed': 'onPanelVisibility',
  'mines:update': 'onMinesUpdated',
  'agent:launchFailed': 'onLaunchFailed',
  'dwarf:sendText:settled': 'onDwarfSendSettled',
  'panel:mine:show': 'onShowMine',
  'typography:preferences:changed': 'onTypographyPreferences',
  pathForDroppedFile: 'pathForDroppedFile',
  'dwarf:setName': 'setDwarfName',
  'dwarf:resetName': 'resetDwarfName',
  // NEW rows of 14 §2.2
  'diag:renderer:report': 'reportRendererDiagnostic', // A-N30
  'tray:stopEverything:requested': 'onStopEverythingRequested', // A-N25
  'tray:stopEverything:confirm': 'confirmStopEverything', // A-N26
  'tray:stopEverything:cancel': 'cancelStopEverything', // A-N27
  'tray:stopEverything:request': 'requestStopEverything', // A-N34 (amendment 2026-10-01, ISSUE-316)
  'host:connection:get': 'getHostConnection', // A-N03
  'host:connection:changed': 'onHostConnection', // A-N04
  'host:connection:retry': 'retryHostConnection', // A-N05
  'host:connection:confirm-restart': 'confirmHostRestart' // A-N33 (AMENDMENT-11; unrouted until generation-2)
}

/**
 * Today's coercions (the found preload's, kept: ISSUE-045 candidate decision), applied only while the row's route
 * keeps `shape: 'today'`, since each reads today's payload. `arg` is the payload a request or one-way member sends,
 * written over its parameter `request`; a push has `payload` (what its listener gets) and optionally `accept` (a push
 * that fails it never reaches the listener). Every expression only reads and compares, so none can throw. A row
 * with no entry passes its value on untouched, for main to validate (14 §1.4). The found preload's shared-parser
 * calls are not kept: they are main's refinements (14 §1.4 last bullet), three of them threw in the preload
 * (A-48, A-50, A-54, against 14 §1.4), and the parsers live in the legacy tree the preload may not import (R16).
 */
const TODAY_COERCIONS = {
  // A boolean crosses as a real boolean: anything else means "off".
  'panel:setAlwaysOnTop': { arg: 'request === true' },
  'notifications:enabled:set': { arg: 'request === true' },
  'opencode:plugin:set': { arg: 'request === true' },
  // An id or a text crosses as a string, or as '' which main refuses.
  'shortcut:set': { arg: 'textOf(request)' },
  'dwarf:feed': { arg: 'textOf(request)' },
  'dwarf:refreshTelemetry': { arg: 'textOf(request)' },
  'mine:history': { arg: 'textOf(request)' },
  'shell:openExternalLink': { arg: 'textOf(request)' },
  'shell:copyText': { arg: 'textOf(request)' },
  'dwarf:retire': { arg: 'textOf(request)' },
  'mine:undeclare': { arg: 'textOf(request)' },
  'dwarf:resetName': { arg: 'textOf(request)' },
  // null is a real answer here ("none"), so a non-string is null rather than ''.
  'panel:watchDwarfFeed': { arg: "typeof request === 'string' ? request : null" },
  'presence:visibleMines': { arg: "typeof request === 'string' ? request : null" },
  // Rebuilt field by field: what crosses is exactly the row's fields, nothing a caller hung off the object.
  'panel:layout:set': {
    arg: "{ mineOpen: request?.mineOpen === true, dockOpen: request?.dockOpen === true, ...(request?.edge === 'left' || request?.edge === 'right' ? { edge: request.edge } : {}) }"
  },
  'dwarf:feed:page': {
    arg: '{ dwarfId: textOf(request?.dwarfId), before: { timestamp: textOf(request?.before?.timestamp), text: textOf(request?.before?.text) } }'
  },
  'dwarf:setTuning': {
    arg: '{ dwarfId: textOf(request?.dwarfId), change: tuningChangeOf(request?.change) }'
  },
  // A name that is not a string does not cross, so main refuses the shape instead of reading a reset.
  'dwarf:setName': {
    arg: "{ dwarfId: textOf(request?.dwarfId), ...(typeof request?.name === 'string' ? { name: request.name } : {}) }"
  },
  'mine:openPath': {
    arg: "{ mineId: textOf(request?.mineId), target: textOf(request?.target), ...(typeof request?.dwarfId === 'string' ? { dwarfId: request.dwarfId } : {}) }"
  },
  'dwarf:attachments:describe': {
    arg: '(Array.isArray(request) ? request : []).map((path: unknown) => textOf(path))'
  },
  // A provider this build does not know crosses as '' (refused), never as a default; an optional field crosses
  // only when named, and `routedByJev` only when true.
  'agent:launch': {
    arg: "{ mineId: textOf(request?.mineId), provider: providerOf(request?.provider), prompt: textOf(request?.prompt), ...(typeof request?.model === 'string' ? { model: request.model } : {}), ...(typeof request?.effort === 'string' ? { effort: request.effort } : {}), ...(typeof request?.permissionMode === 'string' ? { permissionMode: request.permissionMode } : {}), ...(request?.routedByJev === true ? { routedByJev: true } : {}) }"
  },
  'agent:launchHeld': {
    arg: "{ mineId: textOf(request?.mineId), provider: providerOf(request?.provider), prompt: textOf(request?.prompt), ...(typeof request?.model === 'string' ? { model: request.model } : {}), ...(typeof request?.effort === 'string' ? { effort: request.effort } : {}), ...(typeof request?.permissionMode === 'string' ? { permissionMode: request.permissionMode } : {}), ...(request?.routedByJev === true ? { routedByJev: true } : {}) }"
  },
  'agent:launchHosted': {
    arg: '{ mineId: textOf(request?.mineId), command: textOf(request?.command), prompt: textOf(request?.prompt) }'
  },
  'agent:answerQuestion': { arg: 'questionAnswerOf(request)' },
  'agent:answerPermission': {
    arg: '{ dwarfId: textOf(request?.dwarfId), toolUseId: textOf(request?.toolUseId), decision: textOf(request?.decision) }'
  },
  // Pushes: the visibility is a real boolean; a show-mine push that names no mine is dropped.
  'panel:visible:changed': { payload: 'payload === true' },
  'panel:mine:show': { accept: "typeof payload === 'string' && payload !== ''", payload: 'payload' }
}

/** The body of each preload helper (a row with no IPC, `PRELOAD_HELPERS`), over its parameter `file`. */
const HELPER_BODIES = {
  // The one place a dropped File becomes a path (webUtils, S-019-1): the renderer gets the string, never the File.
  // A File with no path (a synthesized one, a drag from a web page) answers ''.
  pathForDroppedFile: "{ try { return webUtils.getPathForFile(file) } catch { return '' } }"
}

/** Helper functions the coercions call, emitted only when used. `{providers}` is filled from the registry. */
const HELPER_FUNCTIONS = {
  textOf: `/** An id or a text as a string, or '' which main refuses. */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}`,
  providerOf: `/** Today's provider names (the today launch request's enum); an unknown one crosses as '', never a default. */
const PROVIDERS: readonly unknown[] = {providers}
function providerOf(value: unknown): string {
  return typeof value === 'string' && PROVIDERS.includes(value) ? value : ''
}`,
  tuningChangeOf: `/**
 * The one act a tuning request names. An unrecognised kind crosses as a shape main refuses, never as either real
 * act: this changes a running session.
 */
function tuningChangeOf(change: unknown): { kind: string; model?: string; effort?: string; value?: string } {
  const record = typeof change === 'object' && change !== null ? (change as Record<string, unknown>) : {}
  if (record.kind === 'model' && typeof record.model === 'string') return { kind: 'model', model: record.model }
  if (record.kind === 'effort' && typeof record.effort === 'string') {
    return { kind: 'effort', effort: record.effort }
  }
  return { kind: '', value: '' }
}`,
  questionAnswerOf: `/**
 * An answer rebuilt from string pairs only. The person's own words (\`text\`) cross alone, never beside a record;
 * a non-string value is dropped, so main refuses an answer that names no option.
 */
function questionAnswerOf(request: unknown): Record<string, unknown> {
  const record = typeof request === 'object' && request !== null ? (request as Record<string, unknown>) : {}
  const address = { dwarfId: textOf(record.dwarfId), toolUseId: textOf(record.toolUseId) }
  if (record.text !== undefined) {
    return { ...address, ...(typeof record.text === 'string' ? { text: record.text } : {}) }
  }
  const answers = stringPairsOf(record.answers)
  const ownWords = stringPairsOf(record.ownWords)
  return { ...address, answers, ...(Object.keys(ownWords).length === 0 ? {} : { ownWords }) }
}
function stringPairsOf(value: unknown): Record<string, string> {
  const pairs: Record<string, string> = {}
  if (typeof value !== 'object' || value === null) return pairs
  for (const [key, entry] of Object.entries(value)) if (typeof entry === 'string') pairs[key] = entry
  return pairs
}`
}
const HELPER_DEPENDENCIES = { questionAnswerOf: ['textOf'] }

const STATUS_14 = { kept: 'KEEP', changed: 'CHANGE', new: 'NEW', retired: 'RETIRE' }

/** Whether a zod schema is the registry's "no payload" (`z.undefined()`). */
const isNoPayload = (schema) => schema?._def?.typeName === 'ZodUndefined'

/**
 * One entry per registry row: its 14 id, member, kind, wire, shape and schemas for this release.
 *
 * @param {{ channels: Record<string, any>, todayShapes: Record<string, any>, rowIds: Record<string, string>, helpers: readonly string[], routes: readonly { channel: string, shape: string }[] }} registry
 */
export function windowApiRows({ channels, todayShapes, rowIds, helpers, routes }) {
  const problems = []
  for (const key of Object.keys(MEMBERS)) {
    if (!(key in channels)) problems.push(`MEMBERS names ${key}, which is not a registry row`)
  }
  for (const key of [...Object.keys(TODAY_COERCIONS), ...Object.keys(HELPER_BODIES)]) {
    if (!(key in channels))
      problems.push(`a coercion or helper body names ${key}, not a registry row`)
  }
  const rows = Object.keys(channels).map((key) => {
    const spec = channels[key]
    const id = rowIds[key]
    const own = routes.filter((route) => route.channel === key)
    const shapes = [...new Set(own.map((route) => route.shape))]
    if (shapes.length > 1) problems.push(`${key}: its routes use two shapes (21 §1 item 2a)`)
    // A NEW row with no route yet (unrouted.ts) is born with its target shape.
    const shape = shapes.length === 1 && shapes[0] === 'today' ? 'today' : 'target'
    const named = MEMBERS[key]
    const member = typeof named === 'string' ? named : named?.[shape]
    if (member === undefined) {
      problems.push(`${key} (${id ?? 'no 14 id'}): no window.api member name; add it to MEMBERS`)
    }
    const kind = helpers.includes(key) ? 'helper' : spec.kind
    if (kind === 'helper' && HELPER_BODIES[key] === undefined) {
      problems.push(`${key}: a preload helper with no body in HELPER_BODIES`)
    }
    const todayWire = Object.keys(rowIds).find(
      (wire) => wire !== key && rowIds[wire] === id && !(wire in channels)
    )
    const schemas =
      shape === 'today' ? (todayShapes[key] ?? (spec.status === 'kept' ? spec : undefined)) : spec
    if (schemas === undefined) problems.push(`${key}: no today shape (TODAY_SHAPES)`)
    return {
      key,
      id: id ?? null,
      member: member ?? '',
      kind,
      wire: kind === 'helper' ? null : shape === 'today' ? (todayWire ?? key) : key,
      shape,
      status: STATUS_14[spec.status] ?? spec.status,
      noPayload: isNoPayload(schemas?.request),
      coercion: shape === 'today' ? TODAY_COERCIONS[key] : undefined
    }
  })
  const members = rows.map((row) => row.member)
  for (const member of new Set(members)) {
    if (members.filter((m) => m === member).length > 1)
      problems.push(`member ${member} is used twice`)
  }
  if (problems.length > 0)
    throw new Error(`window.api generation refused:\n- ${problems.join('\n- ')}`)
  return rows
}

const HEADER = (
  what
) => `// GENERATED by \`pnpm ipc:generate\` (scripts/ipc/generate-window-api.mjs) — do not edit by hand (22 §5).
// ${what}
// Source: the channel registry (src/contracts/ipc) and the route table's shapes (src/ui-main/ipc/routes.ts).`

const rowType = (row) => (row.shape === 'today' ? 'Today' : 'Target')

function memberType(row) {
  const T = rowType(row)
  const req = `${T}Request<'${row.key}'>`
  const res = `${T}Result<'${row.key}'>`
  switch (row.kind) {
    case 'push':
      return `(listener: (payload: ${res}) => void) => () => void`
    case 'helper':
      return `(file: ${req}) => ${res}`
    case 'send':
      return row.noPayload ? '() => void' : `(request: ${req}) => void`
    default:
      return row.noPayload ? `() => Promise<${res}>` : `(request: ${req}) => Promise<${res}>`
  }
}

function memberCode(row) {
  const wire = row.wire === null ? '' : `'${row.wire}'`
  switch (row.kind) {
    case 'helper':
      return `(file) => ${HELPER_BODIES[row.key]}`
    case 'push': {
      const payload = row.coercion?.payload ?? `payload as ${rowType(row)}Result<'${row.key}'>`
      const deliver = row.coercion?.accept
        ? `if (${row.coercion.accept}) listener(${payload})`
        : `listener(${payload})`
      return `(listener) => {
        const wrapped = (_event: IpcRendererEvent, payload: unknown): void => {
          ${deliver}
        }
        ipcRenderer.on(${wire}, wrapped)
        return () => ipcRenderer.removeListener(${wire}, wrapped)
      }`
    }
    default: {
      const guard = row.kind === 'send' ? 'sendOrDrop' : 'invokeOrReject'
      const args = row.noPayload ? wire : `${wire}, ${row.coercion?.arg ?? 'request'}`
      const call = `${guard}(() => ipcRenderer.${row.kind === 'send' ? 'send' : 'invoke'}(${args}))`
      return row.noPayload ? `() => ${call}` : `(request) => ${call}`
    }
  }
}

/**
 * The two guards every send and invoke member calls through. Electron structured-clones the payload, and one it
 * cannot copy (a function, a symbol, a DOM node) fails inside the preload: `send` throws (observed on Electron 44,
 * `src/preload/preload.os.test.ts`). The preload never throws (14 §1.4), so a send is dropped, as main drops a one-way
 * payload it refuses (14 §1.5: `undefined` for a one-way send), and an invoke always answers with a promise, which
 * rejects with Electron's Error: a row's refusal shape is main's (14 §1.5), and main never received this call. Each
 * member still names its own `ipcRenderer` call (the re-inventory scanner reads it), and its coercion runs inside the
 * guard.
 */
const IPC_GUARDS = {
  send: `/** A one-way message that cannot cross (structured clone refuses it) is dropped, never thrown (14 §1.4). */
function sendOrDrop(send: () => void): void {
  try {
    send()
  } catch {
    // Dropped: main never receives it, as it would drop a one-way payload it refuses.
  }
}`,
  invoke: `/** A request always answers with a promise: one that cannot cross rejects, never throws (14 §1.4). */
function invokeOrReject<T>(invoke: () => Promise<T>): Promise<T> {
  try {
    return invoke()
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)))
  }
}`
}

const docOf = (row) =>
  `/** ${row.id ?? row.key} · ${row.wire === null ? 'preload only' : `\`${row.wire}\``} · ${row.kind} · ${row.status} · ${row.shape} shape */`

function helperFunctions(rows, providers) {
  const used = new Set()
  const visit = (name) => {
    if (used.has(name)) return
    used.add(name)
    for (const dependency of HELPER_DEPENDENCIES[name] ?? []) visit(dependency)
  }
  const code = rows.map((row) =>
    [row.coercion?.arg, row.coercion?.payload, row.coercion?.accept].join(' ')
  )
  for (const name of Object.keys(HELPER_FUNCTIONS)) {
    if (code.some((text) => new RegExp(`\\b${name}\\(`).test(text))) visit(name)
  }
  return Object.keys(HELPER_FUNCTIONS)
    .filter((name) => used.has(name))
    .map((name) => HELPER_FUNCTIONS[name].replace('{providers}', JSON.stringify(providers)))
}

function renderPreload(rows, providers) {
  const shapes = new Set(rows.map((row) => row.shape))
  const usesWebUtils = rows.some((row) => row.kind === 'helper')
  const usesPush = rows.some((row) => row.kind === 'push')
  const guards = Object.keys(IPC_GUARDS)
    .filter((kind) => rows.some((row) => row.kind === kind))
    .map((kind) => IPC_GUARDS[kind])
  const electron = ['contextBridge', 'ipcRenderer', ...(usesWebUtils ? ['webUtils'] : [])]
  // A target alias is declared only when a member uses it: a send row has no result type (TS6196 otherwise).
  const memberText = rows.map((row) => `${memberType(row)} ${memberCode(row)}`).join(' ')
  const usesType = (line) => memberText.includes(`${/^type (\w+)</.exec(line)?.[1]}<`)
  const types = [
    '/** A request as the renderer hands it over: the preload never mutates it, so an array may be readonly. */',
    'type Accepted<T> = T extends readonly (infer I)[] ? readonly Accepted<I>[] : T extends File ? T : T extends object ? { [P in keyof T]: Accepted<T[P]> } : T',
    ...(shapes.has('today')
      ? [
          "/** A row's today shape (21 §1 item 2a): its TODAY_SHAPES entry, or its registry entry for a KEEP row. */",
          'type TodayRow<K extends ChannelKey> = K extends keyof typeof TODAY ? (typeof TODAY)[K] : (typeof CHANNELS)[K]',
          "type TodayRequest<K extends ChannelKey> = Accepted<z.input<TodayRow<K>['request']>>",
          "type TodayResult<K extends ChannelKey> = z.output<TodayRow<K>['response']>"
        ]
      : []),
    ...(shapes.has('target')
      ? [
          "/** A row's target shape (14): its registry entry. */",
          "type TargetRequest<K extends ChannelKey> = Accepted<z.input<(typeof CHANNELS)[K]['request']>>",
          "type TargetResult<K extends ChannelKey> = z.output<(typeof CHANNELS)[K]['response']>"
        ].filter((line) => !/^type Target(Request|Result)</.test(line) || usesType(line))
      : [])
  ]
  return `${HEADER('The preload: `window.api`, one member per registry row (14 §2.1; ADR-033 item 6; ADR-019 item 1).')}
//
// Each member speaks on its row's wire with the types of the shape its route uses in this release; it coerces for
// ergonomics and never throws (a value it cannot coerce is passed on for main to refuse; a payload structured clone
// cannot copy is dropped by a send and rejected by an invoke, 14 §1.4). Built as one
// CommonJS script whose only runtime import is \`electron\`, so it loads in a sandboxed renderer (S-019-1).
import { ${electron.join(', ')}${usesPush ? ', type IpcRendererEvent' : ''} } from 'electron'
import type { z } from 'zod'
import type { CHANNELS, ChannelKey } from '@dwarfai/contracts'
${shapes.has('today') ? "import type { TODAY } from '../contracts/ipc/todayShapes'\n" : ''}
${types.join('\n')}

${[...helperFunctions(rows, providers), ...guards].join('\n\n')}

/** API surface exposed to the renderer as \`window.api\`. */
export interface DwarfAiMinersApi {
${rows.map((row) => `  ${docOf(row)}\n  ${row.member}: ${memberType(row)}`).join('\n')}
}

const api: DwarfAiMinersApi = {
${rows.map((row) => `  ${row.member}: ${memberCode(row)},`).join('\n')}
}

contextBridge.exposeInMainWorld('api', api)
`
}

function renderFake(rows) {
  return `${HEADER('The fake `window.api` for renderer tests (ADR-033 item 7; 17 §1.6). Never imported by production code (R14).')}
import type { DwarfAiMinersApi } from '../../../preload/index'

export type WindowApiMemberKind = 'invoke' | 'send' | 'push' | 'helper'

/** Every member of \`window.api\` with its kind: exactly the registry's rows. */
export const WINDOW_API_MEMBERS = {
${rows.map((row) => `  ${row.member}: '${row.kind}',`).join('\n')}
} as const satisfies Record<keyof DwarfAiMinersApi, WindowApiMemberKind>

const MEMBERS: Readonly<Record<string, WindowApiMemberKind>> = WINDOW_API_MEMBERS

function notAMember(name: string): Error {
  return new Error(\`window.api has no member "\${name}": it is not a row of the channel registry\`)
}

/** What a member does when a test did not fake it: an invoke rejects, so a missing answer is never silent. */
function unfaked(name: string, kind: WindowApiMemberKind): unknown {
  switch (kind) {
    case 'invoke':
      return () => Promise.reject(new Error(\`fake window.api: no answer for \${name}; pass one in overrides\`))
    case 'send':
      return () => undefined
    case 'push':
      return () => () => undefined
    case 'helper':
      return () => ''
  }
}

/**
 * A fake \`window.api\` with every registry member: each override replaces its member, the others keep an inert
 * default. Overriding, or reading, a member the registry does not have throws, which fails the test.
 */
export function createFakeWindowApi(overrides: Partial<DwarfAiMinersApi> = {}): DwarfAiMinersApi {
  const given: Readonly<Record<string, unknown>> = overrides
  for (const name of Object.keys(given)) if (!Object.hasOwn(MEMBERS, name)) throw notAMember(name)
  const api: Record<string, unknown> = {}
  for (const [name, kind] of Object.entries(MEMBERS)) api[name] = given[name] ?? unfaked(name, kind)
  // \`then\` is read by \`await\` on any value; it is not a member and reads as undefined.
  return new Proxy(api, {
    get(target, key, receiver) {
      if (typeof key === 'string' && key !== 'then' && !Object.hasOwn(MEMBERS, key)) throw notAMember(key)
      return Reflect.get(target, key, receiver)
    }
  }) as unknown as DwarfAiMinersApi
}
`
}

async function format(text, file) {
  const prettier = await import('prettier')
  const options = (await prettier.resolveConfig(path.join(ROOT, file))) ?? {}
  return prettier.format(text, { ...options, filepath: path.join(ROOT, file) })
}

/**
 * The two generated files, formatted, for a registry.
 *
 * @param {Parameters<typeof windowApiRows>[0]} registry
 * @returns {Promise<{ preload: string, fake: string }>}
 */
export async function renderWindowApi(registry) {
  const rows = windowApiRows(registry)
  const launch = registry.todayShapes['agent:launch'] ?? registry.channels['agent:launch']
  const providers = launch?.request?.shape?.provider?.options
  if (
    rows.some((row) => /\bproviderOf\(/.test(row.coercion?.arg ?? '')) &&
    !Array.isArray(providers)
  ) {
    throw new Error(
      "window.api generation refused: agent:launch's today request has no provider enum"
    )
  }
  return {
    preload: await format(renderPreload(rows, providers), PRELOAD_FILE),
    fake: await format(renderFake(rows), FAKE_FILE)
  }
}

/** Loads the registry and the route table (TypeScript) through Vite's module runner. */
async function loadRegistry() {
  const { runnerImport } = await import('vite')
  const config = {
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: { '@dwarfai/contracts': path.join(ROOT, 'src', 'contracts', 'index.ts') } }
  }
  const load = async (file) => (await runnerImport(path.join(ROOT, file), config)).module
  const contracts = await load('src/contracts/index.ts')
  const { ROUTES } = await load('src/ui-main/ipc/routes.ts')
  return {
    channels: contracts.CHANNELS,
    todayShapes: contracts.TODAY_SHAPES,
    rowIds: contracts.ROW_IDS,
    helpers: contracts.PRELOAD_HELPERS,
    routes: ROUTES
  }
}

async function main(argv) {
  const check = argv.includes('--check')
  const generated = await renderWindowApi(await loadRegistry())
  const files = [
    [PRELOAD_FILE, generated.preload],
    [FAKE_FILE, generated.fake]
  ]
  let drift = false
  for (const [file, text] of files) {
    const target = path.join(ROOT, file)
    let current = ''
    try {
      current = readFileSync(target, 'utf8').replace(/\r\n/g, '\n')
    } catch {
      // absent: written below
    }
    if (current === text) continue
    drift = true
    if (check) console.error(`${file} differs from a fresh generation; run pnpm ipc:generate`)
    else {
      writeFileSync(target, text)
      console.log(`wrote ${file}`)
    }
  }
  if (check && drift) process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2))
}
