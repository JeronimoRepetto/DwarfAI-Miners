// layer: L2
import { describe, expect, it } from 'vitest'
import { createLegacyDwarfIdRows, type LegacyDwarfIdBridge } from '../LegacyDwarfIdBridge'
import { createLegacySettlementJoin } from './legacySettlementJoin'
import { createPerProviderShapeAdapter } from './PerProviderShapeAdapter'

const MINE = '01920000-0000-7000-8000-000000000001'
const HOST_DWARF = '01920000-0000-7000-8000-000000000002'
const UNKNOWN_DWARF = '01920000-0000-7000-8000-000000000003'
const FAILED_LAUNCH = '01920000-0000-7000-8000-000000000004'
const REQUEST = '01920000-0000-7000-a000-000000000177'
const MINTED = '01920000-0000-7000-8000-0000000001a1'
const LEGACY_DWARF = 'codex:t-1'

/** Today's runtime as the adapter reaches it: records each call and answers what `answers` gives. */
function recordingLegacy(answers: Record<string, unknown>) {
  const served: Array<[string, unknown]> = []
  return {
    served,
    serve(channel: string, payload: unknown): Promise<unknown> {
      served.push([channel, payload])
      return Promise.resolve(answers[channel])
    }
  }
}

/** The id bridge: the one Host dwarf maps to the one legacy dwarf of the same provider identity. */
const bridge: LegacyDwarfIdBridge = {
  toLegacy: (id) => Promise.resolve(id === HOST_DWARF ? LEGACY_DWARF : null),
  toHost: (id) => Promise.resolve(id === LEGACY_DWARF ? HOST_DWARF : null),
  dispose: () => {}
}

const LAUNCH = {
  mineId: MINE,
  way: { kind: 'supplier', providerId: 'codex' },
  model: 'gpt-5-codex',
  effort: 'high',
  permissionMode: 'read-only',
  prompt: 'Map the build',
  jevOn: false,
  jevAutoAccept: false,
  requestId: REQUEST
}
const TODAY_LAUNCH = {
  mineId: MINE,
  provider: 'codex',
  prompt: 'Map the build',
  model: 'gpt-5-codex',
  effort: 'high',
  permissionMode: 'read-only'
}
const LAUNCHED = { launched: true, provider: 'codex', launchId: 'receipt:1' }

describe('PerProviderShapeAdapter (21 §3.1)', () => {
  it("[ADR-001] a target launch for a provider not yet moved reaches today's launch call and answers LaunchAccepted", async () => {
    const legacy = recordingLegacy({ 'agent:launch': LAUNCHED })
    const adapter = createPerProviderShapeAdapter({ legacy, mintId: () => MINTED })

    const answer = await adapter.serve('agent:launch', LAUNCH)

    expect(legacy.served).toEqual([['agent:launch', TODAY_LAUNCH]])
    expect(answer).toEqual({ ok: true, value: { launchId: MINTED } })
  })

  it("[ADR-001] a Retry with retryOf reaches today's launch with the same request", async () => {
    const legacy = recordingLegacy({ 'agent:launch': LAUNCHED })
    const adapter = createPerProviderShapeAdapter({ legacy, mintId: () => MINTED })

    await adapter.serve('agent:launch', LAUNCH)
    const retried = await adapter.serve('agent:launch', { ...LAUNCH, retryOf: FAILED_LAUNCH })

    expect(legacy.served).toEqual([
      ['agent:launch', TODAY_LAUNCH],
      ['agent:launch', TODAY_LAUNCH]
    ])
    expect(retried).toEqual({ ok: true, value: { launchId: MINTED } })
  })

  it("[ADR-001] a launch today's runtime refuses answers a call error naming only the closed cause, never today's text", async () => {
    const legacy = recordingLegacy({
      'agent:launch': {
        launched: false,
        provider: 'none',
        error: 'Codex CLI is not installed on this machine.',
        cause: 'not-installed'
      }
    })
    const adapter = createPerProviderShapeAdapter({ legacy, mintId: () => MINTED })

    expect(await adapter.serve('agent:launch', LAUNCH)).toEqual({
      ok: false,
      error: {
        code: 'INTERNAL',
        message: 'the legacy launch was refused (not-installed)',
        retryable: false
      }
    })
  })

  it("[ADR-001] a launch off the target shape, by Jev or for a provider today's runtime does not know reaches nothing", async () => {
    const legacy = recordingLegacy({ 'agent:launch': LAUNCHED })
    const adapter = createPerProviderShapeAdapter({ legacy, mintId: () => MINTED })
    const invalid = {
      ok: false,
      error: expect.objectContaining({ code: 'INVALID_PARAMS', retryable: false })
    }

    expect(await adapter.serve('agent:launch', { ...LAUNCH, requestId: undefined })).toEqual(
      invalid
    )
    expect(await adapter.serve('agent:launch', { ...LAUNCH, way: { kind: 'jev' } })).toEqual(
      invalid
    )
    expect(
      await adapter.serve('agent:launch', {
        ...LAUNCH,
        way: { kind: 'supplier', providerId: 'simulated' }
      })
    ).toEqual(invalid)
    expect(legacy.served).toEqual([])
  })

  it("[ADR-001] a target send reaches today's send for a legacy dwarf through the id bridge", async () => {
    const legacy = recordingLegacy({ 'dwarf:sendText': { delivered: true, via: 'codex-queue' } })
    const adapter = createPerProviderShapeAdapter({
      legacy: createLegacyDwarfIdRows({ bridge, legacy }),
      mintId: () => MINTED
    })

    const answer = await adapter.serve('dwarf:sendText', {
      dwarfId: HOST_DWARF,
      text: 'Run the tests',
      attachments: [],
      requestId: REQUEST
    })

    expect(legacy.served).toEqual([
      ['dwarf:sendText', { dwarfId: LEGACY_DWARF, text: 'Run the tests', pressEnter: true }]
    ])
    expect(answer).toEqual({ ok: true, value: { ok: true, value: { messageId: MINTED } } })
  })

  it('[ADR-001] a send held for a later settlement is accepted, and one today refuses or to an unknown dwarf is cannot-receive', async () => {
    const held = recordingLegacy({
      'dwarf:sendText': { delivered: false, via: 'held-session', holdId: 'hold-1' }
    })
    const heldAdapter = createPerProviderShapeAdapter({
      legacy: createLegacyDwarfIdRows({ bridge, legacy: held }),
      mintId: () => MINTED
    })
    const send = { dwarfId: HOST_DWARF, text: 'Go on', attachments: [], requestId: REQUEST }
    expect(await heldAdapter.serve('dwarf:sendText', send)).toEqual({
      ok: true,
      value: { ok: true, value: { messageId: MINTED } }
    })

    const refused = recordingLegacy({
      'dwarf:sendText': { delivered: false, via: 'none', error: 'The terminal is closed.' }
    })
    const refusedAdapter = createPerProviderShapeAdapter({
      legacy: createLegacyDwarfIdRows({ bridge, legacy: refused }),
      mintId: () => MINTED
    })
    const cannotReceive = { ok: true, value: { ok: false, error: 'cannot-receive' } }
    expect(await refusedAdapter.serve('dwarf:sendText', send)).toEqual(cannotReceive)
    // An unknown dwarf answers the bridge's own not-found, which is cannot-receive too, and reaches nothing.
    expect(
      await refusedAdapter.serve('dwarf:sendText', { ...send, dwarfId: UNKNOWN_DWARF })
    ).toEqual(cannotReceive)
    expect(refused.served).toHaveLength(1)
  })

  it("[ADR-001] a send's attachment paths reach today's send as today's described picks, and a refused pick sends nothing", async () => {
    const picture = { path: '/work/a.png', name: 'a.png', kind: 'image', bytes: 10 }
    const legacy = recordingLegacy({
      'dwarf:attachments:describe': [{ path: '/work/a.png', attachment: picture }],
      'dwarf:sendText': { delivered: true, via: 'codex-queue' }
    })
    const adapter = createPerProviderShapeAdapter({
      legacy: createLegacyDwarfIdRows({ bridge, legacy }),
      mintId: () => MINTED
    })
    const send = {
      dwarfId: HOST_DWARF,
      text: 'Look',
      attachments: ['/work/a.png'],
      requestId: REQUEST
    }

    expect(await adapter.serve('dwarf:sendText', send)).toEqual({
      ok: true,
      value: { ok: true, value: { messageId: MINTED } }
    })
    expect(legacy.served).toEqual([
      ['dwarf:attachments:describe', ['/work/a.png']],
      [
        'dwarf:sendText',
        { dwarfId: LEGACY_DWARF, text: 'Look', pressEnter: true, attachments: [picture] }
      ]
    ])

    const refusing = recordingLegacy({
      'dwarf:attachments:describe': [{ path: '/work/a.png', refusal: 'file-too-large' }]
    })
    const refusingAdapter = createPerProviderShapeAdapter({
      legacy: createLegacyDwarfIdRows({ bridge, legacy: refusing }),
      mintId: () => MINTED
    })
    expect(await refusingAdapter.serve('dwarf:sendText', send)).toEqual({
      ok: true,
      value: { ok: false, error: 'attachment-refused' }
    })
    expect(refusing.served.map(([channel]) => channel)).toEqual(['dwarf:attachments:describe'])
  })

  it("[ADR-001] a target console activation reaches today's activation through the id bridge and answers ConsoleOpenResult", async () => {
    const answers: Array<[unknown, unknown]> = [
      [
        { focused: true, openedTerminal: false, feed: [] },
        { outcome: 'raised', mode: 'focus-terminal' }
      ],
      [
        { focused: false, openedTerminal: true, feed: [] },
        { outcome: 'opened', mode: 'attach' }
      ],
      [
        { focused: false, openedTerminal: false, feed: [] },
        { outcome: 'failed', mode: 'attach' }
      ]
    ]
    for (const [today, target] of answers) {
      const legacy = recordingLegacy({ 'dwarf:activate': today })
      const adapter = createPerProviderShapeAdapter({
        legacy: createLegacyDwarfIdRows({ bridge, legacy }),
        mintId: () => MINTED
      })
      expect(
        await adapter.serve('dwarf:activate', { dwarfId: HOST_DWARF, purpose: 'open-console' })
      ).toEqual({ ok: true, value: target })
      expect(legacy.served).toEqual([['dwarf:activate', LEGACY_DWARF]])
    }

    // A jump to a terminal that could not be raised fails in the focus mode; an unknown dwarf fails without a call.
    const legacy = recordingLegacy({
      'dwarf:activate': { focused: false, openedTerminal: false, feed: [] }
    })
    const adapter = createPerProviderShapeAdapter({
      legacy: createLegacyDwarfIdRows({ bridge, legacy }),
      mintId: () => MINTED
    })
    expect(
      await adapter.serve('dwarf:activate', { dwarfId: UNKNOWN_DWARF, purpose: 'jump-to-terminal' })
    ).toEqual({ ok: true, value: { outcome: 'failed', mode: 'focus-terminal' } })
    expect(legacy.served).toEqual([])
  })

  it("[ADR-001] an answer that is not today's shape, a throw or a row it does not convert is a call error, never a throw", async () => {
    const legacy = {
      serve: (channel: string): Promise<unknown> =>
        channel === 'agent:launch' ? Promise.reject(new Error('down')) : Promise.resolve({ odd: 1 })
    }
    const adapter = createPerProviderShapeAdapter({ legacy, mintId: () => MINTED })
    const internal = { ok: false, error: expect.objectContaining({ code: 'INTERNAL' }) }

    expect(await adapter.serve('agent:launch', LAUNCH)).toEqual(internal)
    expect(
      await adapter.serve('dwarf:sendText', {
        dwarfId: HOST_DWARF,
        text: 'x',
        attachments: [],
        requestId: REQUEST
      })
    ).toEqual(internal)
    expect(
      await adapter.serve('dwarf:activate', { dwarfId: HOST_DWARF, purpose: 'open-console' })
    ).toEqual(internal)
    expect(await adapter.serve('agent:providers', {})).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'METHOD_NOT_FOUND' })
    })
  })
})

describe('PerProviderShapeAdapter records the ids it mints (21 §3.1, lead decision 2026-10-17)', () => {
  it("[ADR-001] an accepted launch records today's receipt against the minted launch id", async () => {
    const legacy = recordingLegacy({ 'agent:launch': LAUNCHED })
    const settlements = createLegacySettlementJoin()
    const adapter = createPerProviderShapeAdapter({ legacy, mintId: () => MINTED, settlements })

    await adapter.serve('agent:launch', LAUNCH)

    expect(settlements.settleLaunch('receipt:1')).toBe(MINTED)
  })

  it("[ADR-001] a held send records today's holdId against the minted message id", async () => {
    const legacy = recordingLegacy({
      'dwarf:sendText': { delivered: false, via: 'held-session', holdId: 'hold-1' }
    })
    const settlements = createLegacySettlementJoin()
    const adapter = createPerProviderShapeAdapter({
      legacy: createLegacyDwarfIdRows({ bridge, legacy }),
      mintId: () => MINTED,
      settlements
    })

    await adapter.serve('dwarf:sendText', {
      dwarfId: HOST_DWARF,
      text: 'Go on',
      attachments: [],
      requestId: REQUEST
    })

    expect(settlements.settleHold('hold-1')).toBe(MINTED)
  })

  it('[ADR-001] a launch with no receipt, a refused launch and a send delivered at once record nothing', async () => {
    const recorded: string[] = []
    const settlements = {
      recordLaunch: (receipt: string) => void recorded.push(receipt),
      recordHold: (hold: string) => void recorded.push(hold)
    }
    const legacy = recordingLegacy({
      'agent:launch': { launched: true, provider: 'codex' },
      'dwarf:sendText': { delivered: true, via: 'codex-queue' }
    })
    const adapter = createPerProviderShapeAdapter({
      legacy: createLegacyDwarfIdRows({ bridge, legacy }),
      mintId: () => MINTED,
      settlements
    })
    const refusing = createPerProviderShapeAdapter({
      legacy: recordingLegacy({
        'agent:launch': {
          launched: false,
          provider: 'none',
          cause: 'could-not-start',
          launchId: 'receipt:2'
        }
      }),
      mintId: () => MINTED,
      settlements
    })

    await adapter.serve('agent:launch', LAUNCH)
    await refusing.serve('agent:launch', LAUNCH)
    await adapter.serve('dwarf:sendText', {
      dwarfId: HOST_DWARF,
      text: 'Run',
      attachments: [],
      requestId: REQUEST
    })

    expect(recorded).toEqual([])
  })
})
