// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  HostFrame,
  HostFrames,
  IpcResult,
  LaunchFailure,
  LaunchId,
  LaunchWire,
  MineId,
  SnapshotPage,
  SupplierEntryView
} from '@dwarfai/contracts'
import { createFakeWindowApi } from '../../../contracts/ipc/testing/fakeWindowApi'
import {
  COMPOSER_ENABLED_PLACEHOLDER,
  DETACHED_TIMEOUT_MESSAGE,
  DETACHED_TIMEOUT_MS,
  OTHER_CHOICE
} from '../lib/launch/launchState'
import { NOT_DETECTED } from '../lib/launch/providerChips'
import { defaultDwarf, defaultMine } from '../testing/factories'
import type { Dwarf, Mine } from '../types'
import { useAgentLaunch } from './useAgentLaunch'

const MINE = 'mine-1'
const CLAUDE = { provider: 'claude' as const, installed: true, launchable: true }
/*
 * Codex became launchable in #168 — as a DETACHED session, not a held one. AMENDED for ISSUE-001: from 3a every
 * provider launches through A-35 in its 14 shape; Codex's is served by today's runtime behind `PerProviderShapeAdapter`
 * until 3b, the panel never tells the two apart.
 */
const CODEX = { provider: 'codex' as const, installed: true, launchable: true }
/** The `LaunchId` A-35 answers in these cases (14 §1.6: a UUIDv7). */
const LAUNCH = '01920000-0000-7000-8000-0000000003c1' as LaunchId
/** The mine and the dwarf as the Host names them in its frames (UUIDv7, 14 §1.6). */
const HOST_MINE = '01920000-0000-7000-8000-0000000003d1' as MineId
const HOST_DWARF = '01920000-0000-7000-8000-0000000003e1'

/*
 * AMENDED for ISSUE-001 (was: today's A-36 `{ providers }` and A-37 `{ catalogs }`): from 3a A-36 answers every
 * provider's `SupplierEntryView`, its models included (A-37 retired).
 */
function entry(provider: string, overrides: Partial<SupplierEntryView> = {}): SupplierEntryView {
  return {
    providerId: provider as SupplierEntryView['providerId'],
    label: provider,
    models: [],
    permissionModes: [],
    offeredModes: [],
    installed: true,
    publicLaunch: 'enabled',
    answerChannel: 'available',
    ...overrides
  }
}

function catalogue(...entries: SupplierEntryView[]): IpcResult<SupplierEntryView[]> {
  return { ok: true, value: entries }
}

/**
 * Every member the composable AWAITS resolves a real result shape. A bare
 * `vi.fn()` resolves undefined, and a fire-and-forget call that then throws
 * outside the narrow try becomes an unhandled rejection only the full suite
 * catches — the trap this branch's base already fell into once.
 *
 * AMENDED for ISSUE-001 (was: today's A-36, A-37, A-38 and A-35 answers, and today's A-50): the 14 shapes of A-35
 * (`IpcResult<LaunchAccepted>`), A-36 (`IpcResult<SupplierEntryView[]>`) and A-50 (`IpcResult<JevSuggestResult>`).
 */
function stubApi(overrides: Record<string, unknown> = {}) {
  const api = {
    listAgentProviders: vi.fn().mockResolvedValue(catalogue(entry('claude'), entry('codex'))),
    // The Host accepts a launch with its `LaunchId` and states the rest as frames (14 §1.7).
    launchAgent: vi.fn().mockResolvedValue({ ok: true, value: { launchId: LAUNCH } }),
    // The third launch channel (#194). Named here rather than per test for the
    // reason this whole stub exists: an awaited member resolving undefined
    // becomes an unhandled rejection only the full suite catches.
    // AMENDED for ISSUE-186 (was: today's `{ launched: true }`): from 3d A-39 answers the 14 `IpcResult<LaunchAccepted>`.
    launchHostedProcess: vi.fn().mockResolvedValue({ ok: true, value: { launchId: LAUNCH } }),
    // Jev (#509). `configured: false` is the honest default before any test asks for `ready` — a test that never
    // touches Jev exercises the ordinary launch path exactly as it did before this option existed.
    getJevSettings: vi.fn().mockResolvedValue({ configured: false }),
    routeJevLaunch: vi
      .fn()
      .mockResolvedValue({ ok: true, value: { ok: false, error: 'not-configured' } }),
    ...overrides
  }
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: createFakeWindowApi(api)
  })
  return api
}

/*
 * ADDED for ISSUE-001: the Host's launches as the panel reads them (A-N01 `launches`, A-N02 `launch.changed` /
 * `launch.failed`, 14 §4.1). `stubApi` with the two read members; `push` hands frames to the panel.
 */
function hostWorld(overrides: Record<string, unknown> = {}, launches: LaunchWire[] = []) {
  let listener: ((frames: HostFrame[]) => void) | null = null
  let seq = 5
  const api = stubApi({
    getHostSnapshot: vi.fn(() =>
      Promise.resolve({
        ok: true,
        value: {
          snapshotId: 'snap-5',
          seq: 5,
          epoch: 'epoch-1',
          chunks: [{ section: 'launches', data: launches }]
        }
      })
    ),
    onHostEvent: (follow: (frames: HostFrame[]) => void) => {
      listener = follow
      return () => {
        listener = null
      }
    },
    ...overrides
  })
  function push<F extends keyof HostFrames>(name: F, data: HostFrames[F]): void {
    seq += 1
    if (listener === null) throw new Error('nothing follows onHostEvent')
    listener([{ type: 'evt', seq, epoch: 'epoch-1', name, data } as HostFrame])
  }
  return { api, push }
}

/** One launch as the Host states it (14 §3.6 `LaunchWire`). */
function launchWire(state: LaunchWire['state'], extra: Partial<LaunchWire> = {}): LaunchWire {
  return {
    launchId: LAUNCH,
    mineId: HOST_MINE,
    state,
    wayKind: 'supplier',
    requestedAt: 1,
    ...extra
  } as LaunchWire
}

function mineWith(dwarfs: Dwarf[]): Mine {
  return defaultMine({ id: MINE, name: 'mine', path: '/work/mine', dwarfs })
}

function heldDwarf(id: string, first: string): Dwarf {
  return defaultDwarf({
    id,
    name: id,
    sessionId: id,
    // AMENDED for #436 — the launch receipt is `openingPrompt` now, one row
    // rather than the front of an exchange that rode every snapshot.
    openingPrompt: { role: 'user', text: first, timestamp: '2026-01-01T00:00:00Z' }
  })
}

/**
 * A dwarf main has PROVED to be one of this panel's own launches (#191) — no
 * conversation, and the receipt instead.
 */
function launchedDwarf(id: string, launchId: string): Dwarf {
  return defaultDwarf({ id, name: id, sessionId: id, launchId })
}

/** The 14 `LaunchParams` the panel sends for a supplier launch (14 §3.4). */
function supplierParams(providerId: string, extra: Record<string, unknown> = {}) {
  return {
    mineId: MINE,
    way: { kind: 'supplier', providerId },
    prompt: 'dig the east gallery',
    jevOn: false,
    jevAutoAccept: false,
    requestId: expect.any(String),
    ...extra
  }
}

/** The store is a module-scope singleton, so each test starts from closed. */
beforeEach(() => {
  useAgentLaunch().close()
  useAgentLaunch().hostLaunches.stop()
})

describe('opening the Add Panel', () => {
  it('asks main which providers this machine has', async () => {
    const api = stubApi()
    const { open, providers } = useAgentLaunch()

    await open(MINE)

    // AMENDED for ISSUE-001: A-36's 14 request, refreshed on every open (14 §2.1 A-36).
    expect(api.listAgentProviders).toHaveBeenCalledWith({ refresh: true })
    // AMENDED for ISSUE-001 (merge of ISSUE-228): each entry also carries the capabilities its notice reads.
    const capabilities = { answerChannel: 'available', offeredModes: [] }
    expect(providers.value).toEqual([
      { ...CLAUDE, ...capabilities },
      { ...CODEX, ...capabilities }
    ])
  })

  it('opens on provider selection, in the mine it was opened from', async () => {
    stubApi()
    const { open, phase, mineId } = useAgentLaunch()

    await open(MINE)

    expect(phase.value).toBe('provider-selection')
    expect(mineId.value).toBe(MINE)
  })

  /*
   * A bridge that cannot answer leaves the row with Other alone, which is
   * exactly what "nothing was detected" looks like — and Other is what the
   * design guarantees is always there.
   */
  it('opens with Other alone when the bridge cannot answer', async () => {
    stubApi({ listAgentProviders: vi.fn().mockRejectedValue(new Error('bridge down')) })
    const { open, chips } = useAgentLaunch()

    await open(MINE)

    expect(chips.value.map((chip) => chip.choice)).toEqual([OTHER_CHOICE])
  })

  it('forgets the mine and everything typed when it closes', async () => {
    stubApi()
    const { open, close, setPrompt, choose, phase, mineId } = useAgentLaunch()
    await open(MINE)
    choose('claude')
    setPrompt('dig')

    close()

    expect(phase.value).toBe('closed')
    expect(mineId.value).toBeNull()
  })

  /*
   * #239. AMENDED for ISSUE-001 (was: today's A-37 asked beside A-36): from 3a each provider's models ride on its own
   * A-36 entry, so the one catalogue answers both.
   */
  it('asks main for each provider’s own model catalogue too', async () => {
    const api = stubApi({
      listAgentProviders: vi.fn().mockResolvedValue(
        catalogue(
          entry('claude', {
            models: [{ value: 'claude-sonnet-5', label: 'Sonnet', efforts: ['low', 'high'] }]
          })
        )
      )
    })
    const { open, choose, modelPicker } = useAgentLaunch()

    await open(MINE)
    choose('claude')

    expect(api.listAgentProviders).toHaveBeenCalledOnce()
    expect(modelPicker.value).toEqual({
      visible: true,
      models: [{ value: 'claude-sonnet-5', label: 'Sonnet', effortLevels: ['low', 'high'] }],
      disabled: false,
      note: null
    })
  })

  it('opens with no catalogues when the bridge cannot answer, rather than failing to open', async () => {
    stubApi({ listAgentProviders: vi.fn().mockRejectedValue(new Error('bridge down')) })
    const { open, choose, modelPicker } = useAgentLaunch()

    await open(MINE)
    choose('claude')

    expect(modelPicker.value.visible).toBe(true)
    expect(modelPicker.value.disabled).toBe(true)
  })

  it('forgets the model catalogues when it closes', async () => {
    stubApi({
      listAgentProviders: vi
        .fn()
        .mockResolvedValue(catalogue(entry('claude', { models: [{ value: 'opus', efforts: [] }] })))
    })
    const { open, close, choose, modelPicker } = useAgentLaunch()
    await open(MINE)
    choose('claude')

    close()
    choose('claude')

    // catalogs is empty again, which reads as "this provider named none" —
    // the same shape as a provider main could not ask at all.
    expect(modelPicker.value.models).toEqual([])
    expect(modelPicker.value.disabled).toBe(true)
  })
})

describe('submitting a launch', () => {
  async function ready(overrides: Record<string, unknown> = {}) {
    const api = stubApi(overrides)
    const launch = useAgentLaunch()
    await launch.open(MINE)
    launch.choose('claude')
    launch.setPrompt('  dig the east gallery  ')
    return { api, launch }
  }

  // AMENDED for ISSUE-001 (was: "starts a HELD session, …" on today's A-38): from 3a every provider launches through
  // A-35 in its 14 shape, the Host's launcher for Claude (21 §2 cut 3a).
  it('starts the launch through A-35, naming the mine, the provider and the trimmed prompt', async () => {
    const { api, launch } = await ready()

    await launch.submit()

    // The provider is what #168 added: before it, the chip the user pressed
    // reached no process, and every launch was a Claude one whatever the panel
    // had drawn as selected.
    expect(api.launchAgent).toHaveBeenCalledWith(supplierParams('claude'))
  })

  /*
   * #239. The model/effort row under the composer, forwarded on submit —
   * absent when untouched (already pinned above, since the object there
   * carries no `model`/`effort` key at all), present when chosen.
   */
  // AMENDED for ISSUE-228 (was: held Claude's `plan`, which no entry offers and the Host refuses): the chosen mode is
  // one the entry offers (14 §3.6 `offeredModes`; ADR-011 item 1).
  it('carries a chosen model, effort and permission mode to a Claude launch', async () => {
    const { api, launch } = await ready({
      listAgentProviders: vi
        .fn()
        .mockResolvedValue(catalogue(entry('claude', { offeredModes: ['ask-first', 'plan-only'] })))
    })
    launch.setModel('claude-sonnet-5')
    launch.setEffort('xhigh')
    launch.setPermissionMode('plan-only')

    await launch.submit()

    expect(api.launchAgent).toHaveBeenCalledWith(
      supplierParams('claude', {
        model: 'claude-sonnet-5',
        effort: 'xhigh',
        permissionMode: 'plan-only'
      })
    )
  })

  it('waits for the dwarf rather than claiming one from the verdict', async () => {
    const { launch } = await ready()

    await launch.submit()

    expect(launch.phase.value).toBe('submitted-spawning')
  })

  // AMENDED for ISSUE-001 (was: "carries main’s own reason back …", today's `{ launched: false, error }`): A-35 refuses
  // at acceptance only with a call error, which has no words to show; the panel says its own sentence.
  it('returns to the Add state with the panel’s sentence when the launch is refused', async () => {
    const { launch } = await ready({
      launchAgent: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'INVALID_PARAMS', message: 'refused', retryable: false }
      })
    })

    await launch.submit()

    expect(launch.phase.value).toBe('prompt-ready')
    expect(launch.state.value.error).toBe('The agent could not be started.')
  })

  it('says the bridge is down rather than failing silently', async () => {
    const { launch } = await ready({
      launchAgent: vi.fn().mockRejectedValue(new Error('bridge down'))
    })

    await launch.submit()

    expect(launch.phase.value).toBe('prompt-ready')
    expect(launch.state.value.error).toBeTruthy()
  })

  it('ignores a second Enter while one launch is already in flight', async () => {
    const { api, launch } = await ready()

    await Promise.all([launch.submit(), launch.submit()])

    expect(api.launchAgent).toHaveBeenCalledOnce()
  })

  /*
   * ## This test was REPLACED for #194
   *
   * It used to be "refuses a custom command with the stated reason and starts
   * nothing", and it pinned `OTHER_NOT_LAUNCHABLE`: the #168 ruling that no
   * engine takes a command, so Enter says why and starts nothing. The
   * maintainer reversed that ruling on 2026-09-04 — the panel is the process's
   * stdio, so the panel is what observes it — and the constant is gone from
   * providerChips.ts with its whole argument.
   *
   * The case it covered is still covered, on the other side: Enter on Other
   * reaches the bridge now, and what it must NOT do is reach the supplier
   * launch. Starting a Claude session for a command somebody typed
   * instead of Claude was the worse outcome the refusal existed to prevent, and
   * it still is.
   */
  it('starts a custom command down the hosted channel and no other', async () => {
    const api = stubApi()
    const launch = useAgentLaunch()
    await launch.open(MINE)
    launch.choose(OTHER_CHOICE)
    launch.setCommand('  lalolanda --once  ')
    launch.commit()
    launch.setPrompt('  dig the east gallery  ')

    await launch.submit()

    // AMENDED for ISSUE-186 (was: today's request, and no launch id): A-39's 14 request from 3d, and the panel
    // follows the Host's launch under the LaunchId it was answered, as for A-35.
    expect(api.launchHostedProcess).toHaveBeenCalledWith({
      mineId: MINE,
      // The committed command, trimmed exactly as commitCommand left it — the
      // panel sends the string and the Host decides what program that is.
      command: 'lalolanda --once',
      prompt: 'dig the east gallery',
      requestId: expect.any(String)
    })
    expect(api.launchAgent).not.toHaveBeenCalled()
    expect(launch.state.value.error).toBeNull()
    expect(launch.state.value.launchId).toBe(LAUNCH)
  })

  /*
   * The one thing the panel must not do with a command it cannot run: swallow
   * the answer. #194 was reported as "it froze", which was a refusal nobody
   * could see, so main's own reason has to reach the panel intact.
   */
  // AMENDED for ISSUE-186 (was: "shows main’s own reason when the command could not be started", today's
  // `{ launched: false, error }`): from 3d the Host parses the command and settles a refusal as `launch.failed
  // {could-not-start}` (14 §2.1 A-39 Notes), so the refusal everybody must see is the launch-failure notice.
  it('shows the Host’s could-not-start when the command could not be started', async () => {
    const host = hostWorld()
    const launch = useAgentLaunch()
    await launch.hostLaunches.start()
    await launch.open(MINE)
    launch.choose(OTHER_CHOICE)
    launch.setCommand('lalolanda | tee log')
    launch.commit()
    launch.setPrompt('dig')

    await launch.submit()
    host.push('launch.failed', {
      launchId: LAUNCH,
      mineId: HOST_MINE,
      failure: { cause: 'could-not-start', supplierLabel: 'The custom command', actions: ['retry'] }
    } as HostFrames['launch.failed'])

    expect(host.api.launchHostedProcess).toHaveBeenCalledOnce()
    expect(launch.state.value.failure).toEqual({ cause: 'could-not-start', choice: OTHER_CHOICE })
    // Back in the Add state with the typing intact, so a retry costs nothing.
    expect(launch.state.value.prompt).toBe('dig')
  })

  /*
   * No new phase for a hosted launch, which is the test of the wire shape
   * (#194): main seeds a hosted process's conversation with the prompt exactly
   * as the held registry seeds a session's, so the SAME receipt adopts it and
   * the panel reaches the MessagePanel through the path it already had.
   *
   * AMENDED for ISSUE-186 (was: "…by the receipt a held launch uses", the
   * opening prompt): from 3d the Host answers A-39 with a LaunchId, so the
   * receipt is the one every Host launch leaves on its dwarf (`launchId`).
   */
  it('waits for its dwarf and adopts it by the LaunchId the Host answered', async () => {
    stubApi()
    const launch = useAgentLaunch()
    await launch.open(MINE)
    launch.choose(OTHER_CHOICE)
    launch.setCommand('lalolanda')
    launch.commit()
    launch.setPrompt('dig the east gallery')

    await launch.submit()
    expect(launch.phase.value).toBe('submitted-spawning')

    launch.observe([
      mineWith([{ ...heldDwarf('hosted:1', 'dig the east gallery'), launchId: LAUNCH }])
    ])

    expect(launch.state.value.launchedDwarfId).toBe('hosted:1')
    expect(launch.phase.value).toBe('message-panel')
    // Never the detached terminal state: that one says the panel is not
    // watching, and here it is.
    expect(launch.state.value.detached).toBe(false)
  })

  // AMENDED for ISSUE-001 (was: "…, repeating main’s reason", today's `AgentProviderOption.reason`): a 14 entry carries
  // no reason sentence, so a supplier it cannot start is refused with the panel's own.
  // AMENDED for ISSUE-188 (was: a `publicLaunch: 'gated'` entry): every entry the Host lists is launchable in its build
  // (ADR-009 D6, development builds keep a gated one), so the supplier it cannot start is one not installed.
  it('refuses a detected provider it cannot start, with the panel’s own sentence', async () => {
    const api = stubApi({
      listAgentProviders: vi.fn().mockResolvedValue(catalogue(entry('codex', { installed: false })))
    })
    const launch = useAgentLaunch()
    await launch.open(MINE)
    launch.choose('codex')
    launch.setPrompt('dig')

    await launch.submit()

    expect(api.launchAgent).not.toHaveBeenCalled()
    expect(launch.state.value.error).toBe(NOT_DETECTED)
  })
})

/*
 * Which channel a chip goes down (#168).
 *
 * AMENDED for ISSUE-001 (was: the HELD channel, A-38, for Claude and the DETACHED one, A-35 in today's shape, for
 * Codex): from 3a every supplier launch is A-35 with the 14 `LaunchParams`, qualified by its provider in UI main — the
 * Host for Claude, today's runtime behind `PerProviderShapeAdapter` for a provider not yet moved (21 §2 cut 3; §3.1).
 * The panel names the supplier in the launch's way and never chooses a channel.
 */
describe('routing a launch to the channel its provider can actually use', () => {
  async function ready(provider: 'claude' | 'codex', overrides: Record<string, unknown> = {}) {
    const api = stubApi(overrides)
    const launch = useAgentLaunch()
    await launch.open(MINE)
    launch.choose(provider)
    launch.setPrompt('  dig the east gallery  ')
    return { api, launch }
  }

  // REMOVED for ISSUE-001, stated rather than passing unseen (docs/test-removals.md): "holds a Claude session, because
  // only a held one can be watched" (#168). A-38 is retired in 3a (21 §2 cut 3a): Claude launches on the Host.

  // AMENDED for ISSUE-001 (was: "starts Codex detached, naming the provider on the wire", today's request).
  it('starts Codex through A-35, naming the provider in its way', async () => {
    const { api, launch } = await ready('codex')

    await launch.submit()

    expect(api.launchAgent).toHaveBeenCalledWith(supplierParams('codex'))
  })

  /*
   * #239. Model and effort travel to the detached channel too — Codex's own
   * launch args carry them (buildCodexLaunchArgs, main-side).
   */
  it('carries a chosen model and effort to a detached launch', async () => {
    const { api, launch } = await ready('codex')
    launch.setModel('gpt-5.6-sol')
    launch.setEffort('high')

    await launch.submit()

    expect(api.launchAgent).toHaveBeenCalledWith(
      supplierParams('codex', { model: 'gpt-5.6-sol', effort: 'high' })
    )
  })

  /*
   * #635 (PO decision 2026-09-28). Codex now has permission modes of its own,
   * and the one picked travels on the detached channel — main turns it into
   * `--sandbox`. The note above the previous test is superseded for Codex.
   */
  // AMENDED for ISSUE-228 (was: "carries a chosen Codex permission mode to a detached launch", Codex's `read-only`):
  // Codex offers Ask first, and the select's first value is what launches when nothing was picked (US-LAUNCH-001.AC04).
  it('[US-LAUNCH-001.AC04, US-LAUNCH-001.AC13] carries the first offered mode, Ask first, to a Codex launch nobody tuned', async () => {
    const { api, launch } = await ready('codex', {
      listAgentProviders: vi
        .fn()
        .mockResolvedValue(
          catalogue(entry('claude'), entry('codex', { offeredModes: ['ask-first'] }))
        )
    })

    await launch.submit()

    expect(api.launchAgent).toHaveBeenCalledWith(
      supplierParams('codex', { permissionMode: 'ask-first' })
    )
    expect(launch.permissionsVisible.value).toBe(true)
  })

  // AMENDED for ISSUE-001 (was: "never hands a held launch …", today's A-38): the Claude launch is A-35 too.
  it('never hands a Claude launch a Codex permission mode left over from a switch', async () => {
    const { api, launch } = await ready('codex')
    launch.setPermissionMode('read-only')
    launch.choose('claude')

    await launch.submit()

    expect('permissionMode' in api.launchAgent.mock.calls[0]![0]).toBe(false)
  })

  // REMOVED for ISSUE-001, stated rather than passing unseen (docs/test-removals.md): "lands on started-detached with
  // main’s receipt and no dwarf claimed" (#191). An accepted launch stays "Sending the dwarf in…" under its `LaunchId`
  // until it settles (07 5A `sending`): no launch is detached from the panel any more.

  /*
   * The distinction the receipt exists to keep. A launch's own words prove
   * nothing — only main, or from 3a the Host, can say which dwarf this launch
   * became. AMENDED for ISSUE-001: it waits in `submitted-spawning`.
   */
  it('never adopts a dwarf for a detached launch, however well its words match', async () => {
    const { launch } = await ready('codex')
    await launch.submit()

    launch.observe([mineWith([heldDwarf('codex:sess-9', 'dig the east gallery')])])

    expect(launch.phase.value).toBe('submitted-spawning')
    expect(launch.state.value.launchedDwarfId).toBeNull()
  })

  /*
   * #191's whole point. Add > Codex started the session, the dwarf appeared,
   * replied and left, and the Add Panel still read "the session started" with
   * the prompt sitting in it. It hands over now.
   */
  it('hands over to the MessagePanel on the dwarf carrying its receipt', async () => {
    const { launch } = await ready('codex')
    await launch.submit()

    launch.observe([mineWith([launchedDwarf('codex:sess-9', LAUNCH)])])

    expect(launch.phase.value).toBe('message-panel')
    expect(launch.state.value.launchedDwarfId).toBe('codex:sess-9')
  })

  /*
   * The session that finished before the poll first drew it — the case the
   * issue reports, where the reply had already landed. The panel opens on the
   * ended dwarf all the same.
   */
  it('hands over to a dwarf whose session had already ended', async () => {
    const { launch } = await ready('codex')
    await launch.submit()

    launch.observe([mineWith([{ ...launchedDwarf('codex:sess-9', LAUNCH), status: 'leaving' }])])

    expect(launch.phase.value).toBe('message-panel')
    expect(launch.state.value.launchedDwarfId).toBe('codex:sess-9')
  })

  it('ignores a dwarf carrying somebody else’s receipt', async () => {
    const { launch } = await ready('codex')
    await launch.submit()

    launch.observe([mineWith([launchedDwarf('codex:sess-8', 'receipt:2')])])

    expect(launch.phase.value).toBe('submitted-spawning')
  })

  // REMOVED for ISSUE-001, stated rather than passing unseen (docs/test-removals.md): "waits without adopting when main
  // opened no receipt" (#168). Every accepted A-35 answers its `LaunchId` (14 §3.4 `LaunchAccepted`).

  // AMENDED for ISSUE-001 (was: "carries a refused detached launch back with main’s own reason"): a refusal at
  // acceptance is a call error with no words to show, so the panel's own sentence.
  it('carries a refused detached launch back with the panel’s sentence', async () => {
    const { launch } = await ready('codex', {
      launchAgent: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'INVALID_PARAMS', message: 'unknown supplier', retryable: false }
      })
    })

    await launch.submit()

    expect(launch.phase.value).toBe('prompt-ready')
    expect(launch.state.value.error).toBe('The agent could not be started.')
  })

  it('says the bridge is down for a detached launch too', async () => {
    const { launch } = await ready('codex', {
      launchAgent: vi.fn().mockRejectedValue(new Error('bridge down'))
    })

    await launch.submit()

    expect(launch.phase.value).toBe('prompt-ready')
    expect(launch.state.value.error).toBeTruthy()
  })
})

/*
 * APPENDED for ISSUE-179 (read side, ISSUE-001 part C): the launches as a read model of the snapshot `launches` section
 * and the `launch.changed` / `launch.failed` frames (14 §4.1, §4.3 rule 7; ADR-020 D1; ADR-033 item 3). The call side
 * (A-35 with `LaunchParams`, A-36) lands with the step-3a switch, ISSUE-001. Placed here, not at the end of the file,
 * so concurrent appends to this file merge as a union.
 */
describe('useAgentLaunch read model', () => {
  type Api = Window['api']
  type SnapshotAnswer = IpcResult<SnapshotPage>

  const EPOCH = 'epoch-1'
  const ALPHA = '01920000-0000-7000-8000-00000000a001' as MineId
  const BRAVO = '01920000-0000-7000-8000-00000000a002' as MineId
  const FIRST = '01920000-0000-7000-8000-00000000f001' as LaunchId
  const SECOND = '01920000-0000-7000-8000-00000000f002' as LaunchId
  const BORIN = '01920000-0000-7000-8000-00000000d001'
  /** 2026-10-06T09:00:00.000Z, in epoch ms. */
  const NINE = 1_791_277_200_000

  function launch(launchId: LaunchId, overrides: Partial<LaunchWire> = {}): LaunchWire {
    return {
      launchId,
      mineId: ALPHA,
      state: 'routing',
      wayKind: 'supplier',
      providerId: 'claude',
      requestedAt: NINE,
      ...overrides
    } as LaunchWire
  }

  const FAILURE: LaunchFailure = {
    cause: 'exited-at-once',
    supplierLabel: 'Claude Code',
    actions: ['retry', 'pick-manually'],
    toolOutputTail: 'error: unknown option --foo'
  }

  function page(seq: number, launches: LaunchWire[]): SnapshotAnswer {
    return {
      ok: true,
      value: {
        snapshotId: `snap-${seq}`,
        seq,
        epoch: EPOCH,
        chunks: [{ section: 'launches', data: launches }]
      }
    }
  }

  function frame<F extends keyof HostFrames>(seq: number, name: F, data: HostFrames[F]): HostFrame {
    return { type: 'evt', seq, epoch: EPOCH, name, data } as HostFrame
  }

  /** A-N01 answers each scripted page in turn (the last repeats); A-N02 is pushed by the test. */
  function installHost(answers: Array<SnapshotAnswer | (() => SnapshotAnswer)>) {
    let listener: ((frames: HostFrame[]) => void) | null = null
    let next = 0
    const getHostSnapshot = vi.fn(() => {
      const answer = answers[Math.min(next, answers.length - 1)]!
      next += 1
      return Promise.resolve(typeof answer === 'function' ? answer() : answer)
    })
    stubApi({
      getHostSnapshot: getHostSnapshot as unknown as Api['getHostSnapshot'],
      onHostEvent: ((follow: (frames: HostFrame[]) => void) => {
        listener = follow
        return () => {
          listener = null
        }
      }) as unknown as Api['onHostEvent']
    })
    return {
      getHostSnapshot,
      push(frames: HostFrame[]) {
        if (listener === null) throw new Error('nothing follows onHostEvent')
        listener(frames)
      }
    }
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
  }

  beforeEach(() => {
    useAgentLaunch().hostLaunches.stop()
  })

  it('[NFR-TIM-07] the in-flight state lasts until launch.changed or launch.failed, never a timer', async () => {
    vi.useFakeTimers()
    try {
      const host = installHost([page(5, [launch(FIRST), launch(SECOND, { state: 'spawned' })])])
      const { hostLaunches } = useAgentLaunch()
      expect(await hostLaunches.start()).toBe(true)
      expect(hostLaunches.inFlight(FIRST)).toBe(true)

      // However long the Host takes, nothing in the window ends the launch for it.
      vi.advanceTimersByTime(DETACHED_TIMEOUT_MS * 10)
      expect(hostLaunches.inFlight(FIRST)).toBe(true)
      expect(hostLaunches.inFlight(SECOND)).toBe(true)

      host.push([
        frame(6, 'launch.changed', {
          launch: launch(FIRST, { state: 'succeeded', dwarfId: BORIN } as Partial<LaunchWire>)
        })
      ])
      expect(hostLaunches.inFlight(FIRST)).toBe(false)
      expect(hostLaunches.of(FIRST)?.wire?.dwarfId).toBe(BORIN)

      host.push([frame(7, 'launch.failed', { launchId: SECOND, mineId: ALPHA, failure: FAILURE })])
      expect(hostLaunches.inFlight(SECOND)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('[ADR-020] a launch.failed frame puts the failure with its cause, label, actions and tail into the state', async () => {
    const host = installHost([page(5, [launch(FIRST)])])
    const { hostLaunches } = useAgentLaunch()
    await hostLaunches.start()
    host.push([frame(6, 'launch.failed', { launchId: FIRST, mineId: ALPHA, failure: FAILURE })])
    expect(hostLaunches.of(FIRST)).toEqual({
      launchId: FIRST,
      mineId: ALPHA,
      wire: launch(FIRST),
      failure: FAILURE
    })
    expect(hostLaunches.inMine(ALPHA).map((entry) => entry.failure)).toEqual([FAILURE])
    expect(hostLaunches.inMine(BRAVO)).toEqual([])
  })

  it('[ADR-033] frames with seq at or below the snapshot seq are dropped', async () => {
    let host: ReturnType<typeof installHost> | null = null
    host = installHost([
      () => {
        // Arrives while the snapshot is read: buffered, then dropped, as the snapshot already reflects seq 5.
        host!.push([
          frame(5, 'launch.failed', { launchId: FIRST, mineId: ALPHA, failure: FAILURE })
        ])
        return page(5, [launch(FIRST)])
      }
    ])
    const { hostLaunches } = useAgentLaunch()
    await hostLaunches.start()
    await settle()
    host.push([frame(4, 'launch.changed', { launch: launch(FIRST, { state: 'lost' }) })])
    expect(hostLaunches.of(FIRST)).toEqual({
      launchId: FIRST,
      mineId: ALPHA,
      wire: launch(FIRST),
      failure: null
    })
    expect(hostLaunches.inFlight(FIRST)).toBe(true)
  })

  it('[ADR-033] a launch missing from a re-snapshot is gone, and nothing is inferred from the difference', async () => {
    const host = installHost([
      page(5, [launch(FIRST), launch(SECOND, { mineId: BRAVO })]),
      page(9, [launch(FIRST)])
    ])
    const { hostLaunches } = useAgentLaunch()
    await hostLaunches.start()
    expect(hostLaunches.inMine(BRAVO).map((entry) => entry.launchId)).toEqual([SECOND])
    host.push([frame(6, 'resync-required', { reason: 'ring-overrun' })])
    await settle()
    expect(host.getHostSnapshot).toHaveBeenCalledTimes(2)
    expect(hostLaunches.of(SECOND)).toBeUndefined()
    expect(hostLaunches.inMine(BRAVO)).toEqual([])
    expect(hostLaunches.inFlight(FIRST)).toBe(true)
  })

  it('[ADR-033] until the route switch a refused snapshot leaves the launches unfed', async () => {
    stubApi({
      getHostSnapshot: vi.fn(() =>
        Promise.resolve({
          ok: false,
          error: { code: 'METHOD_NOT_FOUND', message: 'unrouted', retryable: false }
        })
      ) as unknown as Api['getHostSnapshot'],
      onHostEvent: vi.fn(() => () => undefined) as unknown as Api['onHostEvent']
    })
    const { hostLaunches } = useAgentLaunch()
    expect(await hostLaunches.start()).toBe(false)
    expect(hostLaunches.of(FIRST)).toBeUndefined()
    expect(hostLaunches.inFlight(FIRST)).toBe(false)
  })
})

/*
 * Jev (#509): the composable's own jobs — reading main's settings verdict on open, and its card while typing.
 * AMENDED for ISSUE-001 (was: today's Enter-time ask, A-50 `{ prompt }` answered by `JevRouteLaunchResult`): from 3a
 * the card is A-50 in its 14 shape while the prompt is written (ISSUE-195, `useAgentLaunch.jev.test.ts`), and Enter
 * with Let Jev choose on is the Host's Jev way (07 5B S5.10). Everything about what a suggestion does to the pickers
 * is `launchState`'s, tested there; this describes only the IPC orchestration around it.
 */
describe('Jev launch routing (#509)', () => {
  /** A-50's 14 answer: Jev suggests Codex, a model and an effort (14 §3.8 `JevSuggestResult`). */
  const SUGGESTION = {
    ok: true as const,
    value: {
      ok: true as const,
      value: {
        providerId: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
        tier: 'balanced',
        confidence: { providerId: 0.87 },
        truncated: false,
        parts: { providerId: 'answered', model: 'answered', tier: 'answered' }
      }
    }
  }

  describe('opening the panel', () => {
    it('reads the Jev settings verdict alongside providers and models', async () => {
      const api = stubApi({ getJevSettings: vi.fn().mockResolvedValue({ configured: true }) })
      const { open, jev } = useAgentLaunch()

      await open(MINE)

      expect(api.getJevSettings).toHaveBeenCalledOnce()
      expect(jev.value.availability).toBe('ready')
    })

    it('treats a bridge that cannot answer as hidden, rather than failing to open', async () => {
      stubApi({ getJevSettings: vi.fn().mockRejectedValue(new Error('bridge down')) })
      const { open, jev, phase } = useAgentLaunch()

      await open(MINE)

      expect(jev.value.availability).toBe('hidden')
      expect(phase.value).toBe('provider-selection')
    })

    it('is off by default even once ready', async () => {
      stubApi({ getJevSettings: vi.fn().mockResolvedValue({ configured: true }) })
      const { open, jev } = useAgentLaunch()

      await open(MINE)

      expect(jev.value.enabled).toBe(false)
    })
  })

  describe('the toggle and dismiss', () => {
    it('flips the toggle only once ready', async () => {
      stubApi({ getJevSettings: vi.fn().mockResolvedValue({ configured: true }) })
      const { open, jev, toggleJevEnabled } = useAgentLaunch()
      await open(MINE)

      toggleJevEnabled()

      expect(jev.value.enabled).toBe(true)
    })

    // AMENDED for ISSUE-001 (was: a decision from today's Enter-time ask): the card comes from A-50 while typing.
    it('dismiss puts the pickers back to what they were before a decision', async () => {
      const api = stubApi({
        getJevSettings: vi.fn().mockResolvedValue({ configured: true }),
        routeJevLaunch: vi.fn().mockResolvedValue(SUGGESTION)
      })
      const { open, choose, setPrompt, toggleJevEnabled, dismissJevDecision, state } =
        useAgentLaunch()
      await open(MINE)
      choose('claude')
      toggleJevEnabled()
      setPrompt('dig the east gallery')
      await vi.waitFor(() => expect(state.value.choice).toBe('codex'))

      dismissJevDecision()

      expect(state.value.choice).toBe('claude')
      expect(api.launchAgent).not.toHaveBeenCalled()
    })
  })

  // REMOVED for ISSUE-001, stated rather than passing unseen (docs/test-removals.md): the 'submitting with Jev enabled
  // and ready' block (8): "asks Jev instead of launching straight off the pickers", "shows the decision and applies it
  // to the pickers, without launching", "launches on a second submit, down the channel the applied provider actually
  // uses", "never asks Jev again for a decision already held", "ignores a second submit while Jev is still being
  // asked, in state and not only in the view", "launches immediately on a fallback, and keeps it visible", "falls back
  // with invalid-response when the bridge itself rejects" and "drops a stale decision and re-asks once the prompt is
  // edited". Their subject, today's Enter-time A-50 ask, left with A-50's 14 shape: the card is asked while typing
  // (ISSUE-195) and Enter with Let Jev choose on is the Host's Jev way.

  describe('submitting with Jev off, unavailable, or hidden', () => {
    // AMENDED for ISSUE-001: the ask that never happens is the typing-time one; the launch is A-35's supplier way.
    it('never asks when the toggle is off', async () => {
      const api = stubApi({
        getJevSettings: vi.fn().mockResolvedValue({ configured: true }),
        routeJevLaunch: vi.fn().mockResolvedValue(SUGGESTION)
      })
      const launch = useAgentLaunch()
      await launch.open(MINE)
      launch.choose('claude')
      launch.setPrompt('dig the east gallery')

      await launch.submit()

      expect(api.routeJevLaunch).not.toHaveBeenCalled()
      expect(api.launchAgent).toHaveBeenCalledWith(supplierParams('claude'))
    })

    it('never asks with no key configured', async () => {
      const api = stubApi({
        getJevSettings: vi.fn().mockResolvedValue({ configured: false }),
        routeJevLaunch: vi.fn().mockResolvedValue(SUGGESTION)
      })
      const launch = useAgentLaunch()
      await launch.open(MINE)
      launch.choose('claude')
      launch.setPrompt('dig the east gallery')

      await launch.submit()

      expect(api.routeJevLaunch).not.toHaveBeenCalled()
      expect(api.launchAgent).toHaveBeenCalledOnce()
    })
  })
})

/*
 * AMENDED for ISSUE-001 (was: today's held launch, adopted by the prompt main seeded): from 3a the launch the Host owns
 * hands over on the Host's word — `launch.changed` with its dwarf (07 5A S5.05) — never on a dwarf whose words match.
 */
describe('watching for the dwarf the launch started', () => {
  async function launched() {
    const host = hostWorld()
    const launch = useAgentLaunch()
    await launch.hostLaunches.start()
    await launch.open(MINE)
    launch.choose('claude')
    launch.setPrompt('dig the east gallery')
    await launch.submit()
    return { launch, host }
  }

  it('hands over to the MessagePanel on the dwarf carrying its own prompt', async () => {
    const { launch, host } = await launched()

    host.push('launch.changed', {
      launch: launchWire('succeeded', { dwarfId: HOST_DWARF as never })
    })

    expect(launch.phase.value).toBe('message-panel')
    expect(launch.state.value.launchedDwarfId).toBe(HOST_DWARF)
  })

  it('keeps waiting while only unrelated sessions turn up', async () => {
    const { launch } = await launched()

    launch.observe([mineWith([heldDwarf('claude:sess-8', 'shore the north wall')])])

    expect(launch.phase.value).toBe('submitted-spawning')
  })

  it('looks only in the mine the launch was made from', async () => {
    const { launch } = await launched()
    const elsewhere: Mine = {
      ...mineWith([launchedDwarf('claude:sess-9', LAUNCH)]),
      id: 'mine-2'
    }

    launch.observe([elsewhere])

    expect(launch.phase.value).toBe('submitted-spawning')
  })

  it('adopts nobody when no launch is in flight', async () => {
    stubApi()
    const launch = useAgentLaunch()
    await launch.open(MINE)

    launch.observe([mineWith([heldDwarf('claude:sess-9', 'dig the east gallery')])])

    expect(launch.state.value.launchedDwarfId).toBeNull()
  })
})

/*
 * Issue #263. AMENDED for ISSUE-001: from 3a a launch of a provider not yet moved (Codex here) is still "Sending the
 * dwarf in…" under the `LaunchId` A-35 answered, which today's A-P3 now names (legacySettlementJoin.ts); the Host
 * never states it, so today's bound still ends it. A launch the Host states is never ended by a timer (NFR-TIM-07).
 */
describe('a detached launch that fails after it started (#263)', () => {
  async function detachedLaunch(overrides: Record<string, unknown> = {}) {
    const api = stubApi(overrides)
    const launch = useAgentLaunch()
    await launch.open(MINE)
    launch.choose('codex')
    launch.setPrompt('dig the east gallery')
    await launch.submit()
    return { api, launch }
  }

  it('times out to a neutral sentence when neither a receipt nor a failure ever arrives', async () => {
    vi.useFakeTimers()
    try {
      const { launch } = await detachedLaunch()
      expect(launch.phase.value).toBe('submitted-spawning')

      vi.advanceTimersByTime(DETACHED_TIMEOUT_MS)

      expect(launch.phase.value).toBe('prompt-ready')
      expect(launch.state.value.error).toBe(DETACHED_TIMEOUT_MESSAGE)
      expect(launch.state.value.prompt).toBe('dig the east gallery')
    } finally {
      vi.useRealTimers()
    }
  })

  it('never times out a launch whose dwarf already arrived', async () => {
    vi.useFakeTimers()
    try {
      const { launch } = await detachedLaunch()
      launch.observe([mineWith([launchedDwarf('codex:sess-9', LAUNCH)])])
      expect(launch.phase.value).toBe('message-panel')

      vi.advanceTimersByTime(DETACHED_TIMEOUT_MS)

      expect(launch.phase.value).toBe('message-panel')
      expect(launch.state.value.error).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  // AMENDED for ISSUE-001 (was: "never schedules a timeout for a launch main opened no receipt for", today's #168
  // reading): every A-35 answers a `LaunchId`; what no timer ends is a launch the Host states (07 5A `sending`).
  it('[NFR-TIM-07] never times out a launch the Host states, which only its own event ends', async () => {
    vi.useFakeTimers()
    try {
      const host = hostWorld()
      const launch = useAgentLaunch()
      await launch.hostLaunches.start()
      await launch.open(MINE)
      launch.choose('claude')
      launch.setPrompt('dig the east gallery')
      await launch.submit()
      host.push('launch.changed', { launch: launchWire('routing') })

      vi.advanceTimersByTime(DETACHED_TIMEOUT_MS * 10)

      expect(launch.phase.value).toBe('submitted-spawning')
      expect(launch.state.value.error).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

/*
 * Issue #523. The toggle as an entry path: the composer opens on it alone. AMENDED for ISSUE-001: Enter with Let Jev
 * choose on is the Host's Jev way (07 5B S5.10: the Host asks Jev at Send), so no Enter stops at a decision any more.
 */
describe('the Jev entry path (#523)', () => {
  function jevApi(overrides: Record<string, unknown> = {}) {
    return stubApi({
      getJevSettings: vi.fn().mockResolvedValue({ configured: true }),
      ...overrides
    })
  }

  /** The panel entered on Jev alone: ready, toggled on, prompt typed — no chip. */
  async function readyOnJev(overrides: Record<string, unknown> = {}) {
    const api = jevApi(overrides)
    const launch = useAgentLaunch()
    await launch.open(MINE)
    launch.toggleJevEnabled()
    launch.setPrompt('dig the east gallery')
    return { api, launch }
  }

  describe('the composer with no chip', () => {
    it('opens on the Jev toggle alone, and locks again when it comes back off, typing kept', async () => {
      const { launch } = await readyOnJev()

      expect(launch.enabled.value).toBe(true)
      expect(launch.placeholder.value).toBe(COMPOSER_ENABLED_PLACEHOLDER)
      expect(launch.phase.value).toBe('prompt-ready')

      launch.toggleJevEnabled()

      expect(launch.enabled.value).toBe(false)
      expect(launch.phase.value).toBe('provider-selection')
      expect(launch.state.value.prompt).toBe('dig the east gallery')
    })
  })

  describe('the two-Enter flow, carried with no chip', () => {
    // AMENDED for ISSUE-001 (was: "asks on the first Enter, stops at the decision, and launches on the second"): one
    // Enter, the Host's Jev way, the person's Jev switches carried (14 §3.4 `LaunchParams`).
    it('launches on one Enter as the Host’s Jev way, with no chip and no ask of its own', async () => {
      const { api, launch } = await readyOnJev()
      api.routeJevLaunch.mockClear()

      await launch.submit()

      expect(api.launchAgent).toHaveBeenCalledWith({
        mineId: MINE,
        way: { kind: 'jev' },
        prompt: 'dig the east gallery',
        jevOn: true,
        jevAutoAccept: false,
        requestId: expect.any(String)
      })
      expect(api.routeJevLaunch).not.toHaveBeenCalled()
      expect(launch.phase.value).toBe('submitted-spawning')
    })
  })

  describe('auto-accept', () => {
    it('flips through the composable only once ready', async () => {
      stubApi({ getJevSettings: vi.fn().mockResolvedValue({ configured: true }) })
      const { open, jev, toggleJevAutoAccept } = useAgentLaunch()
      await open(MINE)

      expect(jev.value.autoAccept).toBe(false)
      toggleJevAutoAccept()
      expect(jev.value.autoAccept).toBe(true)
    })

    // AMENDED for ISSUE-001 (was: "applies the decision and launches on the same Enter"): auto-accept is the person's
    // switch the Host's Jev way reads (`jevAutoAccept`).
    it('carries auto-accept on the same Enter, for the Host to apply Jev’s pick', async () => {
      const { api, launch } = await readyOnJev()
      launch.toggleJevAutoAccept()

      await launch.submit()

      expect(api.launchAgent).toHaveBeenCalledWith(
        expect.objectContaining({ way: { kind: 'jev' }, jevOn: true, jevAutoAccept: true })
      )
    })

    // REMOVED for ISSUE-001, stated rather than passing unseen (docs/test-removals.md): "never auto-accepts a fallback:
    // with no chip it launches nothing, and the fallback line owns the refusal" and "leaves a fallback onto a chosen chip
    // launching, exactly as #509 had it" (#523). A Jev fallback is the Host's at Send: a Jev cause on `launch.failed`,
    // or a hand-back with the configured default (07 5B S5.13–S5.15; 'the launch-failure notice' below).
  })

  // REMOVED for ISSUE-001, stated rather than passing unseen (docs/test-removals.md): "carries routedByJev once a
  // decision routes to a heldable provider" (#511). A-38 is retired and the 14 launch states a Jev launch by its way.

  // REMOVED for ISSUE-001, stated rather than passing unseen (docs/test-removals.md): the 'a fallback with a configured
  // default (jev-routing-profiles T4)' block (2): "applies the default and stops for the second Enter, same as a
  // decision" and "launches at once with auto-accept on, instead of waiting for a second Enter". The Host hands a
  // launch back with the default in the pickers (07 5B S5.13, 5A S5.07; 'the launch-failure notice' below).

  // REMOVED for ISSUE-001, stated rather than passing unseen (docs/test-removals.md): "refuses out loud when a late
  // answer reaches a no-chip panel, and keeps the prompt" (#523). Enter never waits on a Jev answer any more.
})

/*
 * #635 (MESSAGE-QUESTIONS 14/16/17): the Add panel's launch-failure notice. AMENDED for ISSUE-001: a launch the Host
 * owns fails on its `launch.failed` frame with one of the five causes (ADR-020 D1); one of a provider not yet moved on
 * today's A-P3; a custom command (A-39, today's shape until 3d) on its own verdict.
 */
describe('the launch-failure notice (#635)', () => {
  async function ready(choice: 'claude' | 'codex', overrides: Record<string, unknown> = {}) {
    const host = hostWorld(overrides)
    const launch = useAgentLaunch()
    await launch.hostLaunches.start()
    await launch.open(MINE)
    launch.choose(choice)
    launch.setPrompt('dig the east gallery')
    return { api: host.api, host, launch }
  }

  function failed(failure: Partial<LaunchFailure>): HostFrames['launch.failed'] {
    return {
      launchId: LAUNCH,
      mineId: HOST_MINE,
      failure: {
        cause: 'not-installed',
        supplierLabel: 'Claude Code',
        actions: ['retry'],
        ...failure
      }
    } as HostFrames['launch.failed']
  }

  it('names a held supplier that is not installed', async () => {
    const { host, launch } = await ready('claude')
    await launch.submit()

    host.push('launch.failed', failed({ cause: 'not-installed' }))

    expect(launch.state.value.failure).toEqual({ cause: 'not-installed', choice: 'claude' })
    expect(launch.state.value.error).toBeNull()
    expect(launch.phase.value).toBe('prompt-ready')
  })

  // AMENDED for ISSUE-186 (was: today's `{ launched: false, cause }` verdict): from 3d the cause arrives on the Host's
  // `launch.failed` frame of the launch A-39 was answered (21 §2 cut 3d), and a Retry names that launch.
  it('names a custom command that could not be started', async () => {
    const { host, launch } = await ready('codex')
    launch.choose(OTHER_CHOICE)
    launch.setCommand('lalolanda')
    launch.commit()
    launch.setPrompt('dig')

    await launch.submit()
    host.push(
      'launch.failed',
      failed({ cause: 'not-installed', supplierLabel: 'The custom command' })
    )

    expect(host.api.launchHostedProcess).toHaveBeenCalledOnce()
    expect(launch.state.value.failure).toEqual({ cause: 'not-installed', choice: OTHER_CHOICE })

    await launch.retry()
    expect(host.api.launchHostedProcess).toHaveBeenCalledTimes(2)
    expect(host.api.launchHostedProcess.mock.calls[1]![0]).toMatchObject({
      command: 'lalolanda',
      retryOf: LAUNCH
    })
  })

  // AMENDED for ISSUE-001 (was: today's held channel): the one channel still answering in today's words is A-39's.
  // AMENDED for ISSUE-186 (was: "keeps main’s own words for a failure it named no cause for", today's A-39 verdict):
  // from 3d no launch channel answers in today's words; a refused A-39 call (14 §1.5 error branch) is a refusal with
  // no notice, the prompt kept, exactly as a refused A-35 call.
  it('refuses a custom launch the Host refused with no notice, the prompt kept', async () => {
    stubApi({
      launchHostedProcess: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'HOST_NOT_READY', message: 'starting', retryable: true }
      })
    })
    const launch = useAgentLaunch()
    await launch.open(MINE)
    launch.choose(OTHER_CHOICE)
    launch.setCommand('lalolanda')
    launch.commit()
    launch.setPrompt('dig')

    await launch.submit()

    expect(launch.state.value.failure).toBeNull()
    expect(launch.state.value.error).toBe('The agent could not be started.')
    expect(launch.state.value.prompt).toBe('dig')
  })

  // REMOVED for ISSUE-001, stated rather than passing unseen (docs/test-removals.md): the 'a held session that stopped
  // as soon as it started (MESSAGE-QUESTIONS 16)' block (3): "reaches the notice when the push names this held launch",
  // "ignores a push for a launch it did not make" and "still adopts the held dwarf by its seeded conversation, not by the
  // correlation id". A-38 is retired: a Claude launch that stops at once is the Host's `exited-at-once` on its
  // `launch.failed` (ADR-020 D1, D4; launchState.host.test.ts).

  describe('Retry', () => {
    // AMENDED for ISSUE-001 (was: today's held channel twice): the Retry is A-35 again, naming the failed launch
    // (`retryOf`, 07 5A S5.08a), with its own requestId.
    it('sends the same launch again, once per press', async () => {
      const { api, host, launch } = await ready('claude')
      await launch.submit()
      host.push('launch.failed', failed({ cause: 'not-installed' }))
      expect(api.launchAgent).toHaveBeenCalledTimes(1)

      await launch.retry()

      expect(api.launchAgent).toHaveBeenCalledTimes(2)
      expect(api.launchAgent.mock.calls[1]![0]).toEqual({
        ...api.launchAgent.mock.calls[0]![0],
        requestId: expect.any(String),
        retryOf: LAUNCH
      })
      expect(api.launchAgent.mock.calls[1]![0].requestId).not.toBe(
        api.launchAgent.mock.calls[0]![0].requestId
      )
    })

    it('does nothing by itself: no launch goes again without a press', async () => {
      vi.useFakeTimers()
      try {
        const { api, host, launch } = await ready('claude')
        await launch.submit()
        host.push('launch.failed', failed({ cause: 'not-installed' }))

        await vi.advanceTimersByTimeAsync(DETACHED_TIMEOUT_MS * 2)

        expect(api.launchAgent).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
      }
    })

    // AMENDED for ISSUE-001 (was: today's Enter-time ask again): the Host asks Jev again for the same Jev launch.
    it('asks Jev again after Jev could not be reached', async () => {
      const { api, host, launch } = await ready('claude', {
        getJevSettings: vi.fn().mockResolvedValue({ configured: true })
      })
      launch.toggleJevEnabled()
      await launch.submit()
      host.push('launch.failed', failed({ cause: 'jev-unreachable', jevReason: 'unreachable' }))
      expect(launch.state.value.failure).toEqual({ cause: 'jev-unreachable' })

      await launch.retry()

      expect(api.launchAgent).toHaveBeenCalledTimes(2)
      expect(api.launchAgent.mock.calls[1]![0]).toMatchObject({
        way: { kind: 'jev' },
        retryOf: LAUNCH
      })
    })
  })

  describe('the Jev causes — only when nothing went out', () => {
    async function onJev() {
      const setup = await ready('claude', {
        getJevSettings: vi.fn().mockResolvedValue({ configured: true })
      })
      setup.launch.toggleJevEnabled()
      await setup.launch.submit()
      return setup
    }

    // AMENDED for ISSUE-001 (was: today's fallback at Enter): the Host's `jev-could-not-choose` with its reason.
    it('names "Jev could not choose" with its reason when no chip stood under it', async () => {
      const { host, launch } = await onJev()

      host.push('launch.failed', failed({ cause: 'jev-could-not-choose', jevReason: 'no-key' }))

      expect(launch.state.value.failure).toEqual({
        cause: 'jev-could-not-choose',
        reason: 'no-key'
      })
    })

    // REMOVED for ISSUE-001, stated rather than passing unseen (docs/test-removals.md): "raises no notice for a
    // fallback that launched on the pickers" (#635). A Jev fallback that launched is the Host's launch on its way:
    // nothing reaches the panel but its `launch.changed` frames.

    // AMENDED for ISSUE-001 (was: today's fallback carrying the default): the Host's hand-back (07 5A S5.07).
    it('raises no notice for a fallback that put the configured default into the pickers', async () => {
      const { host, launch } = await onJev()

      host.push('launch.changed', {
        launch: launchWire('handed-back', { picks: { providerId: 'codex' as never } })
      })

      expect(launch.state.value.failure).toBeNull()
      expect(launch.state.value.choice).toBe('codex')
      expect(launch.phase.value).toBe('prompt-ready')
    })
  })

  // AMENDED for ISSUE-001 (was: today's Enter-time fallback): the Host's `jev-unreachable`.
  it('Pick manually turns Let Jev choose off and takes the notice away, prompt kept', async () => {
    const host = hostWorld({ getJevSettings: vi.fn().mockResolvedValue({ configured: true }) })
    const launch = useAgentLaunch()
    await launch.hostLaunches.start()
    await launch.open(MINE)
    launch.toggleJevEnabled()
    launch.setPrompt('dig the east gallery')
    await launch.submit()
    host.push('launch.failed', failed({ cause: 'jev-unreachable', jevReason: 'timeout' }))

    launch.pickManually()

    expect(launch.jev.value.enabled).toBe(false)
    expect(launch.state.value.failure).toBeNull()
    expect(launch.state.value.prompt).toBe('dig the east gallery')
    expect(launch.phase.value).toBe('provider-selection')
  })
})

/*
 * ADDED for ISSUE-228 (ADR-011 item 7; 07 machine 5A S5.02, S5.03, S5.25…S5.28; UC-009, UC-028): the Add panel's
 * OpenCode notice. A provider whose permission requests the app cannot answer while its integration is off is
 * listed with `answerChannel: 'gated-off'` (14 §3.6 `SupplierEntryView`, the A-36 answer from its switch); the panel
 * reads that capability, never a provider id (R12). Its action turns the option on (A-53, origin `add-panel`),
 * then asks A-36 again and redraws the Permissions list from the refreshed entry; no launch leaves while it is
 * pending. TC-228-03.
 */
describe('the OpenCode permission-requests notice (ISSUE-228)', () => {
  // AMENDED for ISSUE-001 (merge): from 3a A-36 answers `SupplierEntryView`s (was: today's `{ providers }`).
  const GATED = entry('opencode', { answerChannel: 'gated-off', offeredModes: ['build'] })
  const ANSWERED = entry('opencode', { answerChannel: 'available', offeredModes: ['ask', 'build'] })

  function deferred<T>() {
    let resolve: (value: T) => void = () => undefined
    const promise = new Promise<T>((settle) => {
      resolve = settle
    })
    return { promise, resolve }
  }

  async function openWith(overrides: Record<string, unknown> = {}) {
    const api = stubApi({
      listAgentProviders: vi
        .fn()
        .mockResolvedValueOnce(catalogue(entry('claude'), GATED))
        .mockResolvedValue(catalogue(entry('claude'), ANSWERED)),
      setOpenCodePluginEnabled: vi.fn().mockResolvedValue({ pluginEnabled: true }),
      ...overrides
    }) as ReturnType<typeof stubApi> & { setOpenCodePluginEnabled: ReturnType<typeof vi.fn> }
    const launch = useAgentLaunch()
    await launch.open(MINE)
    return { api, launch }
  }

  it('[US-LAUNCH-001.AC12, S5.02] choosing OpenCode while the option is off shows the notice with its action', async () => {
    const { launch } = await openWith()

    expect(launch.integrationNotice.value).toEqual({ shown: false })

    launch.choose('opencode')
    expect(launch.integrationNotice.value).toEqual({ shown: true, state: 'offered' })

    launch.choose('claude')
    expect(launch.integrationNotice.value).toEqual({ shown: false })
  })

  it('[US-LAUNCH-001.AC13, S5.03] using the action turns the option on, hides the notice and offers Ask first after the refresh', async () => {
    const { api, launch } = await openWith()
    launch.choose('opencode')
    expect(launch.offeredModes.value).toEqual(['build'])

    await launch.enableIntegration()

    expect(api.setOpenCodePluginEnabled).toHaveBeenCalledOnce()
    // ADDED for ISSUE-234: from the step-4a switch the Add panel records its own consent origin (16 §7.2; C-21).
    expect(api.setOpenCodePluginEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ on: true, origin: 'add-panel' })
    )
    expect(api.listAgentProviders).toHaveBeenCalledTimes(2)
    expect(launch.integrationNotice.value).toEqual({ shown: false })
    // The interactive mode ("Ask first") now leads the Permissions list (US-LAUNCH-001 order).
    expect(launch.offeredModes.value).toEqual(['ask', 'build'])
    expect(api.launchAgent).not.toHaveBeenCalled()
  })

  it('[US-LAUNCH-001.AC13, S5.02] no launch is sent while the enable is pending; the person launches once it settled', async () => {
    const enabling = deferred<unknown>()
    const { api, launch } = await openWith({
      setOpenCodePluginEnabled: vi.fn().mockReturnValue(enabling.promise)
    })
    launch.choose('opencode')
    launch.setPrompt('dig the east gallery')

    const action = launch.enableIntegration()
    expect(launch.integrationNotice.value).toEqual({ shown: true, state: 'enabling' })
    await launch.submit()
    expect(api.launchAgent).not.toHaveBeenCalled()

    enabling.resolve({ pluginEnabled: true })
    await action
    await launch.submit()

    expect(api.launchAgent).toHaveBeenCalledOnce()
    // AMENDED for ISSUE-228 (was: no `permissionMode`): the refreshed entry's first offered mode, which the select
    // shows, launches (US-LAUNCH-001.AC04, AC13).
    expect(api.launchAgent).toHaveBeenCalledWith(
      supplierParams('opencode', { permissionMode: 'ask' })
    )
  })

  it('[ADR-011] a write that fails keeps the notice, states the failure, and the launch still goes out without an answer channel', async () => {
    const { api, launch } = await openWith({
      listAgentProviders: vi.fn().mockResolvedValue(catalogue(entry('claude'), GATED))
    })
    launch.choose('opencode')
    launch.setPrompt('dig the east gallery')

    await launch.enableIntegration()

    expect(launch.integrationNotice.value).toEqual({ shown: true, state: 'failed' })
    expect(launch.offeredModes.value).toEqual(['build'])
    await launch.submit()
    expect(api.launchAgent).toHaveBeenCalledOnce()
  })

  it('[US-LAUNCH-001.AC14] launching without the action writes nothing and sends a launch with no Ask first', async () => {
    const { api, launch } = await openWith()
    launch.choose('opencode')
    launch.setPrompt('dig the east gallery')

    await launch.submit()

    expect(api.setOpenCodePluginEnabled).not.toHaveBeenCalled()
    expect(api.launchAgent).toHaveBeenCalledOnce()
    const request = api.launchAgent.mock.calls[0]?.[0] as Record<string, unknown>
    expect(request).toMatchObject({
      way: { kind: 'supplier', providerId: 'opencode' },
      prompt: 'dig the east gallery'
    })
    // AMENDED for ISSUE-228 (was: no `permissionMode` at all): a provider without an answer channel launches on its
    // first remaining mode, never Ask first (ADR-011 item 1; US-LAUNCH-001.AC11).
    expect(request.permissionMode).toBe('build')
    expect(launch.offeredModes.value).not.toContain('ask')
  })
})
