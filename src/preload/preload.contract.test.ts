// L6 contract of the generated preload (ISSUE-045): one `window.api` member per registry row with today's names
// and wires (14 §2.1; ADR-033 item 6; 21 §1 item 2a), the committed files equal a fresh generation (22 §5), the
// preload never throws (14 §1.4; ADR-019 item 7), and it builds as the one CommonJS script a sandboxed renderer
// can load (ADR-019 item 1; S-019-1 Decision).
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { createContext, Script } from 'node:vm'
import { resolveConfig } from 'electron-vite'
import { build } from 'vite'
import { beforeAll, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { z } from 'zod'
import {
  CHANNELS,
  PRELOAD_HELPERS,
  ROW_IDS,
  TODAY_SHAPES,
  type ChannelKey
} from '@dwarfai/contracts'
import type { TODAY } from '../contracts/ipc/todayShapes'
import { ROUTES } from '../ui-main/ipc/routes'
import type { DwarfAiMinersApi } from './index'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const I21 = '§8 I-21'

// ---- the electron surface, faked before the preload loads (it calls `exposeInMainWorld` at import time) ----
const exposed = new Map<string, unknown>()
const invoke = vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>()
const send = vi.fn<(channel: string, ...args: unknown[]) => void>()
const on = vi.fn<(channel: string, listener: (...args: unknown[]) => void) => void>()
const removeListener = vi.fn()

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => {
      exposed.set(key, value)
    }
  },
  ipcRenderer: {
    // Electron runs structured clone on the payload: a value it cannot copy throws in `send` (observed on Electron
    // 44, `preload.os.test.ts`). Electron 44's `invoke` rejects instead; its documented signature does not exclude
    // a synchronous throw, so the fake throws there too, the case the preload must still turn into a rejection.
    invoke: (channel: string, ...args: unknown[]) => {
      structuredClone(args)
      return invoke(channel, ...args)
    },
    send: (channel: string, ...args: unknown[]) => {
      structuredClone(args)
      send(channel, ...args)
    },
    on: (channel: string, listener: (...args: unknown[]) => void) => on(channel, listener),
    removeListener: (channel: string, listener: (...args: unknown[]) => void) =>
      removeListener(channel, listener)
  },
  webUtils: {
    // Electron's own refuses anything that is not a File.
    getPathForFile: (file: unknown) => {
      if (!(file instanceof File)) throw new TypeError('Error processing argument at index 0')
      return ''
    }
  }
}))

type Member = (...args: unknown[]) => unknown
let api: Record<string, Member>

beforeAll(async () => {
  await import('./index')
  api = exposed.get('api') as Record<string, Member>
})

beforeEach(() => {
  vi.clearAllMocks()
  invoke.mockResolvedValue(undefined)
})

// ---- the registry side, read independently of the generated files ----
interface CatalogRow {
  id: string
  wire: string | null
  member: string
  kind: string
}
/** The hand-written, reviewed data fixture of 14 §2.1/§2.2 and §8 I-21 (member names as 14 gives them). */
const catalog14: CatalogRow[] = JSON.parse(
  readFileSync(
    resolve(
      REPO_ROOT,
      'scripts',
      'checks',
      '__fixtures__',
      'ipc-reinventory',
      'catalog-14-seam-a.json'
    ),
    'utf8'
  )
).rows
const KEYS = Object.keys(CHANNELS) as ChannelKey[]
const helpers: readonly string[] = PRELOAD_HELPERS

/** Whether this release's routes of a row keep today's shape (21 §1 item 2a). */
const speaksToday = (key: ChannelKey): boolean =>
  ROUTES.some((route) => route.channel === key && route.shape === 'today')

/**
 * A row's member name in 14. AMENDED for ISSUE-123 (was: today's name for every row): a CHANGE that renames its member
 * (14 §1.1: A-44, `setOpenMine` → `reportVisibleMines`) carries the 14 name once its route is `target` (cut 1 on).
 */
function memberOf(key: ChannelKey): string | undefined {
  const id = ROW_IDS[key]
  if (key === 'presence:visibleMines' && !speaksToday(key)) return 'reportVisibleMines'
  return catalog14.find((row) => row.id === id && (id !== I21 || row.wire === key))?.member
}

/**
 * The wire a row is spoken on in this release: today's (the ROW_IDS entry of the same row that is not a registry key,
 * A-44) while its route keeps today's shape, the registry key otherwise. AMENDED for ISSUE-123 (was: always today's).
 */
function todayWireOf(key: ChannelKey): string {
  const wire = Object.keys(ROW_IDS).find(
    (w) => w !== key && ROW_IDS[w] === ROW_IDS[key] && !(w in CHANNELS)
  )
  return speaksToday(key) ? (wire ?? key) : key
}

const kindOf = (key: ChannelKey): string => (helpers.includes(key) ? 'helper' : CHANNELS[key].kind)

// The generator is plain ESM under scripts/ and ships no type declarations.
interface Generator {
  renderWindowApi(registry: unknown): Promise<{ preload: string; fake: string }>
  PRELOAD_FILE: string
  FAKE_FILE: string
}
async function loadGenerator(): Promise<Generator> {
  const href = new URL('../../scripts/ipc/generate-window-api.mjs', import.meta.url).href
  return (await import(/* @vite-ignore */ href)) as Generator
}
const REGISTRY = {
  channels: CHANNELS,
  todayShapes: TODAY_SHAPES,
  rowIds: ROW_IDS,
  helpers: PRELOAD_HELPERS,
  routes: ROUTES
}
const lf = (text: string): string => text.replace(/\r\n/g, '\n')

// Payloads a renderer could hand a member: every JSON-like kind, and objects whose fields have the wrong types.
const HOSTILE: readonly unknown[] = [
  undefined,
  null,
  true,
  false,
  0,
  -1,
  Number.NaN,
  '',
  'x',
  [],
  [1, 'a', null],
  {},
  {
    dwarfId: 7,
    mineId: [],
    before: null,
    change: 'model',
    answers: 'x',
    ownWords: [1],
    text: 5,
    provider: {},
    edge: 'up',
    name: 3,
    target: {},
    decision: 9,
    command: null,
    prompt: false
  },
  { dwarfId: 'd', toolUseId: 't', answers: { q: 1 }, ownWords: null },
  { dwarfId: 'd', change: { kind: 'model', model: 3 } },
  { dwarfId: 'd', before: { timestamp: 1, text: null } }
]

describe('generated preload (14 §2.1; ADR-033 items 6, 7; 21 §1 item 2a)', () => {
  it("[ADR-033] the generated preload exposes exactly the registry's members with today's names", () => {
    // Premise: every member keeps today's name and wire. AMENDED for ISSUE-056 (was: every route keeps today's shape,
    // true before cut 0): from cut 0 a `target` route is a KEEP row, whose target shape is today's (14 §2.1), or a
    // NEW row (14 §2.2), which has no today shape; no CHANGE or RETIRE row is `target` yet.
    // AMENDED for ISSUE-123 (was: no CHANGE or RETIRE row is `target`): the cut-1 switch moves the CHANGE rows A-15,
    // A-19, A-33, A-44 and the RETIRE rows A-12, A-P2 to their target shape (21 §3.1), and a RETIRE row it retired has
    // no route, so the preload speaks it with its registry entry, which is today's shape (14 §2.1).
    expect(
      ROUTES.filter(
        (route) =>
          route.shape !== 'today' &&
          CHANNELS[route.channel].status !== 'kept' &&
          CHANNELS[route.channel].status !== 'new'
      )
        .map((route) => ROW_IDS[route.channel])
        .sort()
    ).toEqual(['A-12', 'A-15', 'A-19', 'A-33', 'A-44', 'A-P2'])
    const expected = KEYS.map(memberOf)
    expect(
      KEYS.filter((key) => memberOf(key) === undefined),
      'registry rows with no 14 member'
    ).toEqual([])
    expect(new Set(expected).size, 'one member per registry row').toBe(KEYS.length)
    expect(Object.keys(api).sort()).toEqual([...expected].sort())

    // Each member speaks on its own row, with the row's kind and today's wire.
    const wrong: string[] = []
    for (const key of KEYS) {
      vi.clearAllMocks()
      invoke.mockResolvedValue(undefined)
      const member = memberOf(key) ?? ''
      const kind = kindOf(key)
      const call = api[member]
      if (typeof call !== 'function') {
        wrong.push(`${member}: not a function`)
        continue
      }
      call(kind === 'push' ? () => {} : undefined)
      const spoken = [
        ...invoke.mock.calls.map(([channel]) => `invoke ${channel}`),
        ...send.mock.calls.map(([channel]) => `send ${channel}`),
        ...on.mock.calls.map(([channel]) => `push ${channel}`)
      ]
      const want = kind === 'helper' ? [] : [`${kind} ${todayWireOf(key)}`]
      if (JSON.stringify(spoken) !== JSON.stringify(want))
        wrong.push(`${member}: spoke ${JSON.stringify(spoken)}, the row is ${JSON.stringify(want)}`)
    }
    expect(wrong).toEqual([])
  })

  it('[ADR-033] committed generated files equal a fresh generation from the registry', async () => {
    const generator = await loadGenerator()
    const fresh = await generator.renderWindowApi(REGISTRY)
    const committed = (file: string): string => lf(readFileSync(resolve(REPO_ROOT, file), 'utf8'))
    expect(committed(generator.PRELOAD_FILE), generator.PRELOAD_FILE).toBe(fresh.preload)
    expect(committed(generator.FAKE_FILE), generator.FAKE_FILE).toBe(fresh.fake)
  })

  it('[ADR-019] a preload member given a value it cannot coerce passes it on and never throws', async () => {
    const thrown: string[] = []
    for (const key of KEYS) {
      const member = memberOf(key) ?? ''
      const call = api[member]
      if (typeof call !== 'function') continue
      if (kindOf(key) === 'push') {
        vi.clearAllMocks()
        call(() => {})
        const wrapper = on.mock.calls[0]?.[1]
        for (const value of HOSTILE) {
          try {
            wrapper?.({}, value)
          } catch (error) {
            thrown.push(`${member} push ${JSON.stringify(value)}: ${String(error)}`)
          }
        }
        continue
      }
      for (const value of HOSTILE) {
        try {
          await call(value)
        } catch (error) {
          thrown.push(`${member}(${JSON.stringify(value)}): ${String(error)}`)
        }
      }
    }
    expect(thrown).toEqual([])
    // Passed on, not dropped: a value the preload cannot coerce still reaches main, which refuses it.
    await api.sendDwarfText?.('not a request')
    expect(invoke).toHaveBeenLastCalledWith('dwarf:sendText', 'not a request')
  })

  it('[ADR-019] a member given a value structured clone cannot copy never throws: a send is dropped and an invoke rejects with an Error', async () => {
    const uncloneable = (): string => 'not cloneable'
    const thrown: string[] = []
    const settled: string[] = []
    for (const key of KEYS) {
      const kind = kindOf(key)
      if (kind !== 'send' && kind !== 'invoke') continue
      const member = memberOf(key) ?? ''
      const call = api[member]
      if (typeof call !== 'function') continue
      let answer: unknown
      try {
        answer = call(uncloneable)
      } catch (error) {
        thrown.push(`${member}: ${String(error)}`)
        continue
      }
      if (kind === 'send') {
        if (answer !== undefined) settled.push(`${member}: a send answered ${String(answer)}`)
        continue
      }
      if (!(answer instanceof Promise)) {
        settled.push(`${member}: an invoke answered ${typeof answer}, not a promise`)
        continue
      }
      // A member whose coercion copies only cloneable fields still crosses and resolves (the fake answers undefined).
      await answer.then(
        () => undefined,
        (error: unknown) => {
          if (!(error instanceof Error)) settled.push(`${member}: rejected with ${typeof error}`)
        }
      )
    }
    expect(thrown).toEqual([])
    expect(settled).toEqual([])
    // Dropped and rejected, not passed on: main never receives a payload that cannot cross.
    vi.clearAllMocks()
    await expect(api.sendDwarfText?.(uncloneable)).rejects.toBeInstanceOf(Error)
    api.reportRendererDiagnostic?.(uncloneable)
    expect(invoke).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it("[ADR-033] a member whose route shape is today exposes today's result type", () => {
    // AMENDED for ISSUE-056 (was: 'panel:getAlwaysOnTop' as the KEEP row): A-03 is `ui-local` + `target` from cut 0, so
    // A-42, a KEEP row still served `legacy`, stands for it.
    // AMENDED for ISSUE-123 (was: with 'mines:get'): the cut-1 switch routes A-12 `host` with its target shape, which for
    // a RETIRE row is today's `MinesSnapshot`; the RETIRE row still `today` is A-P3.
    const today = [
      'dwarf:activate',
      'agent:launchFailed',
      'notifications:enabled:get',
      'dwarf:sendText'
    ]
    for (const key of today) {
      expect(
        ROUTES.filter((route) => route.channel === key).map((route) => route.shape),
        key
      ).toEqual(['today'])
    }
    // CHANGE row: today's DwarfActivation, not the target IpcResult<ConsoleOpenResult>.
    expectTypeOf<DwarfAiMinersApi['activateDwarf']>()
      .parameter(0)
      .toEqualTypeOf<TodayRequest<'dwarf:activate'>>()
    expectTypeOf<DwarfAiMinersApi['activateDwarf']>().returns.resolves.toEqualTypeOf<
      TodayResult<'dwarf:activate'>
    >()
    // A request is accepted with readonly arrays, as today's types have them (the preload never mutates it).
    expectTypeOf<TodayRequest<'dwarf:sendText'>>().toExtend<
      Parameters<DwarfAiMinersApi['sendDwarfText']>[0]
    >()
    expectTypeOf<readonly string[]>().toExtend<
      Parameters<DwarfAiMinersApi['describeDwarfAttachments']>[0]
    >()
    expectTypeOf<DwarfAiMinersApi['sendDwarfText']>().returns.resolves.toEqualTypeOf<
      TodayResult<'dwarf:sendText'>
    >()
    // RETIRE row and KEEP row. AMENDED for ISSUE-123 (was: A-12 `getMines` as the RETIRE row): A-12's target shape is
    // today's `MinesSnapshot` (H3), so its result type is unchanged; A-P3 stands for a RETIRE row still `today`.
    expectTypeOf<DwarfAiMinersApi['getMines']>().returns.resolves.toEqualTypeOf<
      TodayResult<'mines:get'>
    >()
    expectTypeOf<DwarfAiMinersApi['onLaunchFailed']>()
      .parameter(0)
      .parameter(0)
      .toEqualTypeOf<TodayResult<'agent:launchFailed'>>()
    expectTypeOf<DwarfAiMinersApi['getAlwaysOnTop']>().returns.resolves.toEqualTypeOf<boolean>()
    // A-44 keeps today's member name and today's request while its route is today. AMENDED for ISSUE-123 (was: the
    // `setOpenMine` member): from cut 1 its route is `target`, so it is `reportVisibleMines` with its 14 request.
    expectTypeOf<z.input<(typeof CHANNELS)['presence:visibleMines']['request']>>().toExtend<
      Parameters<DwarfAiMinersApi['reportVisibleMines']>[0]
    >()
    // A push hands its listener today's payload; the helper answers synchronously.
    expectTypeOf<DwarfAiMinersApi['onMinesUpdated']>()
      .parameter(0)
      .parameter(0)
      .toEqualTypeOf<TodayResult<'mines:update'>>()
    expectTypeOf<DwarfAiMinersApi['pathForDroppedFile']>().returns.toEqualTypeOf<string>()
  })
})

type TodayRow<K extends ChannelKey> = K extends keyof typeof TODAY
  ? (typeof TODAY)[K]
  : (typeof CHANNELS)[K]
type TodayRequest<K extends ChannelKey> = z.input<TodayRow<K>['request']>
type TodayResult<K extends ChannelKey> = z.output<TodayRow<K>['response']>

describe('built preload (ADR-019 item 1; S-019-1 Decision)', () => {
  it('[ADR-019] the preload builds as one CommonJS script whose only runtime import is electron', async () => {
    const out = mkdtempSync(join(tmpdir(), 'dwarfai-preload-build-'))
    const nodeEnv = process.env.NODE_ENV
    try {
      const resolved = await resolveConfig(
        {
          configFile: resolve(REPO_ROOT, 'electron.vite.config.ts'),
          build: { outDir: out },
          logLevel: 'silent'
        },
        'build',
        'production'
      )
      const preloadConfig = resolved.config?.preload
      expect(preloadConfig, 'electron.vite.config.ts has a preload build').toBeDefined()
      await build({ ...preloadConfig, configFile: false, logLevel: 'silent' })

      const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
          entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]
        )
      const files = walk(out).map((file) => relative(out, file).split(sep).join('/'))
      expect(files, 'one bundled file, no sibling chunk').toEqual(['preload/index.cjs'])

      // Loaded the way a sandboxed renderer loads it: a classic script (an `import` statement is a SyntaxError,
      // "Cannot use import statement outside a module"), whose `require` answers `electron` and nothing else.
      const code = readFileSync(join(out, 'preload', 'index.cjs'), 'utf8')
      const required: string[] = []
      const bridged = new Map<string, unknown>()
      const electron = {
        contextBridge: {
          exposeInMainWorld: (key: string, value: unknown) => bridged.set(key, value)
        },
        ipcRenderer: {
          invoke: async () => undefined,
          send: () => {},
          on: () => {},
          removeListener: () => {}
        },
        webUtils: { getPathForFile: () => '' }
      }
      const sandboxRequire = (id: string): unknown => {
        required.push(id)
        if (id !== 'electron') throw new Error(`a sandboxed preload cannot require ${id}`)
        return electron
      }
      const module = { exports: {} }
      const context = createContext({ require: sandboxRequire, module, exports: module.exports })
      new Script(code, { filename: 'index.cjs' }).runInContext(context)
      expect([...new Set(required)]).toEqual(['electron'])
      expect(Object.keys(bridged.get('api') as object).length).toBe(KEYS.length)
    } finally {
      process.env.NODE_ENV = nodeEnv
      rmSync(out, { recursive: true, force: true })
    }
  }, 60_000)
})
