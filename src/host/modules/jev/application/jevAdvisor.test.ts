// L2 (17 §1.2): `JevAdvisor.suggest` (16 §4.9, §6.2-§6.4) over FakeJevRouter (in recording mode, it
// keeps every request it was sent), FakeSecretReader and FakeRoutingCatalogSource, with the
// preferences read inline (R15: another module's fakes stay inside that module). The capability ids
// are the real Claude table's: 'sonnet' balanced/medium on the full ladder, 'default'
// balanced/unverified.
//
// TC-192-01, TC-192-02, TC-192-04, TC-192-05; TC-193-01..04 (the effort-ceiling default fallback).
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import { FakeSecretReader } from '../../../kernel/fakes/FakeSecretReader'
import { RecordingDiagnosticsLog } from '../../../kernel/fakes/RecordingDiagnosticsLog'
import type { PreferencesQueries } from '../../preferences'
import type { SupplierEntry } from '../../suppliers'
import { MODEL_CAPABILITIES } from '../domain/capabilities/modelCapability'
import type { ModelCapabilityEntry } from '../domain/capabilities/modelCapabilityEntry'
import type { JevRouteAnswers } from '../domain/routeDecision'
import { FakeJevRouter } from '../ports/fakes/FakeJevRouter'
import { FakeRoutingCatalogSource } from '../ports/fakes/FakeRoutingCatalogSource'
import { JEV_ATTEMPT_TIMEOUT_MS } from '../ports/jevRouter'
import { createJevAdvisor } from './jevAdvisor'

const KEY = 'ts-advisor-192-key'

type HostPreferences = ReturnType<PreferencesQueries['get']>

function supplier(overrides: Partial<SupplierEntry> = {}): SupplierEntry {
  return {
    providerId: 'claude',
    label: 'Claude Code',
    models: ['sonnet'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    permissionModes: ['ask-first', 'accept-edits', 'full-access'],
    installed: true,
    publicLaunch: 'enabled',
    answerChannel: 'available',
    ...overrides
  }
}

const PREFERENCES: HostPreferences = {
  subagentDelegationOn: false,
  routingProfile: 'balanced',
  systemNotificationsOn: true,
  openCodePermissionsOn: false
}

function answers(overrides: Partial<JevRouteAnswers> = {}): JevRouteAnswers {
  return {
    kind: 'answers',
    provider: { choice: 'claude', confidence: 0.91 },
    tier: { choice: 'balanced', confidence: 0.88 },
    trivial: { probability: 0.05 },
    largeContext: { probability: 0.05 },
    effort: { score: 1.5 },
    usage: { inputTokens: 42 },
    ...overrides
  }
}

function harness(
  options: {
    launchable?: readonly SupplierEntry[]
    preferences?: HostPreferences
    /** A live preferences double, read on every `get` (ISSUE-193); wins over `preferences`. */
    preferencesSource?: Pick<PreferencesQueries, 'get'>
    capabilities?: typeof MODEL_CAPABILITIES
  } = {}
) {
  const clock = new FakeClock()
  const scheduler = new FakeScheduler(clock)
  const router = new FakeJevRouter({ scheduler, attemptTimeoutMs: JEV_ATTEMPT_TIMEOUT_MS })
  const secrets = new FakeSecretReader({ values: { 'jev-key': KEY }, scheduler })
  const routingCatalog = new FakeRoutingCatalogSource(options.launchable ?? [supplier()])
  const log = new RecordingDiagnosticsLog()
  const advisor = createJevAdvisor({
    router,
    secrets,
    routingCatalog,
    preferences: options.preferencesSource ?? { get: () => options.preferences ?? PREFERENCES },
    log,
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities })
  })
  return { router, secrets, routingCatalog, log, advisor }
}

const LAUNCH = { prompt: 'add a field to this form', purpose: 'launch' } as const

describe('JevAdvisor.suggest', () => {
  it("[US-LAUNCH-003.AC02] an answered launch suggestion carries Jev's pick alone: provider, model and effort, with no reason and no fallback supplier", async () => {
    const { router, advisor } = harness()
    router.queueResponse(answers())

    const result = await advisor.suggest(LAUNCH)

    expect(result).toStrictEqual({
      ok: true,
      value: {
        providerId: 'claude',
        model: 'sonnet',
        effort: 'high',
        tier: 'balanced',
        confidence: { providerId: 0.91, tier: 0.88 },
        truncated: false,
        parts: {
          providerId: 'answered',
          model: 'answered',
          effort: 'answered',
          tier: 'answered'
        }
      }
    })
  })

  it('[US-LAUNCH-003.AC03] a decision that leaves out a part yields a suggestion carrying only the answered parts', async () => {
    // No live model in the catalogue: the decision names the provider and the tier only.
    const { router, advisor } = harness({ launchable: [supplier({ models: [] })] })
    router.queueResponse(answers())

    const result = await advisor.suggest(LAUNCH)

    expect(result).toStrictEqual({
      ok: true,
      value: {
        providerId: 'claude',
        tier: 'balanced',
        confidence: { providerId: 0.91, tier: 0.88 },
        truncated: false,
        parts: { providerId: 'answered', tier: 'answered' }
      }
    })
  })

  it("[US-LAUNCH-003.AC04] the suggestion is identical with auto-accept on or off; the acceptance mode is the renderer's", async () => {
    // `JevSuggestParams` carries no acceptance mode, so the advisor cannot tell the two apart: the
    // same prompt over the same answers yields the same view, which has no `accepted` field (06 §12).
    const first = harness()
    first.router.queueResponse(answers())
    const second = harness()
    second.router.queueResponse(answers())

    const a = await first.advisor.suggest(LAUNCH)
    const b = await second.advisor.suggest(LAUNCH)

    expect(a.ok && a.value.providerId).toBe('claude')
    expect(a).toStrictEqual(b)
    expect(a.ok && Object.keys(a.value)).not.toContain('accepted')
  })

  it('[US-LAUNCH-003.AC10] the suggestion never names a permission mode', async () => {
    const { router, advisor } = harness()
    router.queueResponse(answers())

    const result = await advisor.suggest(LAUNCH)

    expect(result.ok && [result.value.providerId, result.value.model]).toStrictEqual([
      'claude',
      'sonnet'
    ])
    const json = JSON.stringify(result)
    expect(json).not.toMatch(/permission/i)
    for (const mode of supplier().permissionModes) expect(json).not.toContain(mode)
  })

  it('[US-LAUNCH-003.AC11, R12] a synthetic catalog provider in the launchable list becomes a criterion and can be the pick with no code change', async () => {
    const entry: ModelCapabilityEntry = {
      tier: 'balanced',
      what: 'Everyday coding work that needs real reasoning.',
      notFor: 'Trivial lookups.',
      examples: ['Add a field to this form.', 'Extract this helper.'],
      launchTarget: true,
      effortLevels: [],
      relativeCost: 'medium',
      sources: ['test fixture'],
      verifiedOn: '2026-10-17'
    }
    const { router, advisor } = harness({
      launchable: [
        supplier(),
        supplier({ providerId: 'acme', label: 'Acme Agent', models: ['acme-pro'], efforts: [] })
      ],
      capabilities: { ...MODEL_CAPABILITIES, acme: { 'acme-pro': entry } }
    })
    router.queueResponse(answers({ provider: { choice: 'acme', confidence: 0.93 } }))

    const result = await advisor.suggest(LAUNCH)

    expect(Object.keys(router.requestsSeen()[0]?.providerCriteria ?? {})).toStrictEqual([
      'claude',
      'acme',
      'no_preference'
    ])
    expect(router.requestsSeen()[0]?.providerCriteria.acme?.what).toContain('Acme Agent')
    expect(result).toStrictEqual({
      ok: true,
      value: {
        providerId: 'acme',
        model: 'acme-pro',
        tier: 'balanced',
        confidence: { providerId: 0.93, tier: 0.88 },
        truncated: false,
        parts: { providerId: 'answered', model: 'answered', tier: 'answered' }
      }
    })
  })

  it('[US-LAUNCH-008.AC04] the suggestion carries the reasoning facts, the per-part confidence and the truncated flag the tooltip lists', async () => {
    // A provider answer below its floor falls back to a safe value (no confidence of its own); the
    // model is answered by the second request; the prompt was trimmed to fit the request budget.
    const { router, advisor } = harness({
      launchable: [supplier({ models: ['default', 'sonnet'] })]
    })
    router.queueResponse(answers({ provider: { choice: 'claude', confidence: 0.3 } }))
    router.queueModelResponse({
      kind: 'answers',
      fits: { '0': 0.2, '1': 0.86 },
      choice: { choice: '1', probabilities: { '0': 0.1, '1': 0.9 } },
      usage: { inputTokens: 40 }
    })

    const result = await advisor.suggest({ prompt: 'x'.repeat(200_000), purpose: 'launch' })

    expect(router.requestsSeen()[0]?.truncated).toBe(true)
    expect(result).toStrictEqual({
      ok: true,
      value: {
        providerId: 'claude',
        model: 'sonnet',
        effort: 'high',
        tier: 'balanced',
        confidence: { model: 0.86, tier: 0.88 },
        truncated: true,
        parts: {
          providerId: 'safe-default',
          model: 'answered',
          effort: 'answered',
          tier: 'answered'
        }
      }
    })
  })

  it('[ADR-020] with no launchable provider the advisor answers jev-could-not-choose with reason no-launchable-provider and sends nothing to TypeSafe', async () => {
    const { router, secrets, routingCatalog, log, advisor } = harness({ launchable: [] })

    const result = await advisor.suggest(LAUNCH)

    expect(result).toStrictEqual({ ok: false, error: 'jev-could-not-choose' })
    expect(log.byEvent('jev.fallback')).toStrictEqual([
      {
        level: 'warn',
        event: 'jev.fallback',
        subsystem: 'jev',
        outcome: 'skipped',
        causeClass: 'no-launchable-provider'
      }
    ])
    expect(routingCatalog.reads).toBe(1)
    expect(secrets.reads).toStrictEqual([])
    expect(router.requestsSeen()).toStrictEqual([])
    expect(router.keysSeen()).toStrictEqual([])
  })

  it('[NFR-PRIV-01, NFR-PRIV-03, C-26] no custom name, mine id, mine path or attachment reaches any request field', async () => {
    // The fixture world of one launch: a custom-named dwarf in a mine at a path, with an attachment.
    // Only the prompt and the launchable criteria may leave the Host.
    const fixture = {
      customName: 'Watcher of seals',
      dwarfId: '01920000-0000-7000-a000-0000000001d1',
      mineId: '01920000-0000-7000-a000-0000000001a1',
      minePath: '/home/j/projects/canary-mine',
      attachment: '/home/j/projects/canary-mine/notes/plan.png'
    }
    const { router, advisor } = harness({
      launchable: [supplier({ models: ['default', 'sonnet'] })]
    })
    router.queueResponse(answers())
    router.queueModelResponse({
      kind: 'answers',
      fits: { '0': 0.4, '1': 0.8 },
      choice: { choice: '1', probabilities: { '0': 0.2, '1': 0.8 } },
      usage: { inputTokens: 40 }
    })

    await advisor.suggest(LAUNCH)

    const sent = JSON.stringify([...router.requestsSeen(), ...router.modelRequestsSeen()])
    for (const value of Object.values(fixture)) expect(sent).not.toContain(value)
    const [first] = router.requestsSeen()
    expect(Object.keys(first ?? {}).sort()).toStrictEqual([
      'prompt',
      'providerCriteria',
      'routingProfile',
      'truncated'
    ])
    expect(first?.prompt).toBe(LAUNCH.prompt)
    // The second request's candidates are keyed by index, never by model identity (16 §6.2).
    expect(Object.keys(router.modelRequestsSeen()[0]?.candidates ?? {})).toStrictEqual(['0', '1'])
    expect(JSON.stringify(router.modelRequestsSeen()[0]?.candidates)).not.toMatch(/sonnet|default/)
  })
})

/**
 * ISSUE-193: the preferences as the person's Settings selects write them (`preferences.set` merges a
 * patch into the singleton, 09 §4.8), inline because another module's fakes stay inside it (R15).
 */
function livePreferences(initial: HostPreferences) {
  let current = initial
  return {
    get: (): HostPreferences => current,
    set(patch: Partial<HostPreferences>): void {
      current = { ...current, ...patch }
    }
  }
}

/** Two Claude models whose allowed efforts all sit above the level Jev works out (ADR-028). */
function highOnlyCapabilities(): typeof MODEL_CAPABILITIES {
  const sonnet = MODEL_CAPABILITIES.claude?.sonnet
  if (sonnet === undefined) throw new Error('the capability table lost claude sonnet')
  return {
    ...MODEL_CAPABILITIES,
    claude: {
      'c-xhigh': { ...sonnet, tier: 'balanced', effortLevels: ['xhigh', 'max'] },
      'c-high': { ...sonnet, tier: 'balanced', effortLevels: ['high', 'max'] }
    }
  }
}

const HIGH_ONLY_LAUNCHABLE = [supplier({ models: ['c-xhigh', 'c-high'] })]
/** Effort score 0 maps to the bottom of the ladder, so every high-only candidate is ineligible. */
const LOW_EFFORT = answers({ effort: { score: 0 } })

const WITH_DEFAULT: HostPreferences = {
  ...PREFERENCES,
  defaultProvider: 'codex',
  defaultModel: 'gpt-5-codex',
  defaultEffort: 'max'
}

describe('JevAdvisor.suggest — the effort-ceiling default fallback (ADR-028 items 2-3)', () => {
  it('[US-LAUNCH-003.AC13, FM-122] a launch suggestion whose candidates are all above the ceiling answers the configured default and no error', async () => {
    const { router, advisor } = harness({
      launchable: HIGH_ONLY_LAUNCHABLE,
      capabilities: highOnlyCapabilities(),
      preferences: WITH_DEFAULT
    })
    router.queueResponse(LOW_EFFORT)

    const result = await advisor.suggest(LAUNCH)

    // Uncapped: 'max' is the person's own default, not Jev's pick (ADR-028 item 3).
    expect(result).toStrictEqual({
      ok: true,
      value: {
        providerId: 'codex',
        model: 'gpt-5-codex',
        effort: 'max',
        confidence: {},
        truncated: false,
        parts: { providerId: 'safe-default', model: 'safe-default', effort: 'safe-default' },
        fallback: 'effort-ceiling'
      }
    })
  })

  it('[US-SET-008.AC03] a default set through preferences.set is used by the very next ceiling fallback', async () => {
    const preferences = livePreferences(WITH_DEFAULT)
    const { router, advisor } = harness({
      launchable: HIGH_ONLY_LAUNCHABLE,
      capabilities: highOnlyCapabilities(),
      preferencesSource: preferences
    })
    router.queueResponse(LOW_EFFORT)
    expect(await advisor.suggest(LAUNCH)).toMatchObject({
      ok: true,
      value: { providerId: 'codex' }
    })

    preferences.set({ defaultProvider: 'claude', defaultModel: 'sonnet', defaultEffort: 'low' })
    router.queueResponse(LOW_EFFORT)

    expect(await advisor.suggest(LAUNCH)).toMatchObject({
      ok: true,
      value: { providerId: 'claude', model: 'sonnet', effort: 'low', fallback: 'effort-ceiling' }
    })
  })

  it('[US-SET-008.AC06] when Jev can decide its own pick is answered whatever the defaults are; when it cannot honour the ceiling the defaults are answered', async () => {
    const decides = harness({ preferences: WITH_DEFAULT })
    decides.router.queueResponse(answers())

    const own = await decides.advisor.suggest(LAUNCH)

    expect(own).toMatchObject({
      ok: true,
      value: { providerId: 'claude', model: 'sonnet', parts: { providerId: 'answered' } }
    })
    expect(own.ok && own.value.fallback).toBe(undefined)

    const ceiling = harness({
      launchable: HIGH_ONLY_LAUNCHABLE,
      capabilities: highOnlyCapabilities(),
      preferences: WITH_DEFAULT
    })
    ceiling.router.queueResponse(LOW_EFFORT)

    expect(await ceiling.advisor.suggest(LAUNCH)).toMatchObject({
      ok: true,
      value: { providerId: 'codex', model: 'gpt-5-codex', effort: 'max' }
    })
  })

  it('[INV-89] a ceiling fallback that launches the default provider sets no Jev launch cause; only a fallback that launched nothing ends with jev-could-not-choose', async () => {
    const withDefault = harness({
      launchable: HIGH_ONLY_LAUNCHABLE,
      capabilities: highOnlyCapabilities(),
      preferences: WITH_DEFAULT
    })
    withDefault.router.queueResponse(LOW_EFFORT)
    const none = harness({
      launchable: HIGH_ONLY_LAUNCHABLE,
      capabilities: highOnlyCapabilities(),
      preferences: PREFERENCES
    })
    none.router.queueResponse(LOW_EFFORT)

    expect((await withDefault.advisor.suggest(LAUNCH)).ok).toBe(true)
    expect(await none.advisor.suggest(LAUNCH)).toStrictEqual({
      ok: false,
      error: 'jev-could-not-choose'
    })
  })

  it('[ADR-028] on a fresh install the ceiling fallback answers jev-could-not-choose', async () => {
    // OQ-72 A: "Default provider" starts at "None" on a fresh install (migration 1's seed, 09 §4.9),
    // so the fresh preferences carry no default at all.
    const { router, advisor } = harness({
      launchable: HIGH_ONLY_LAUNCHABLE,
      capabilities: highOnlyCapabilities(),
      preferences: PREFERENCES
    })
    router.queueResponse(LOW_EFFORT)

    expect(await advisor.suggest(LAUNCH)).toStrictEqual({
      ok: false,
      error: 'jev-could-not-choose'
    })
  })

  it('[ADR-028] a subtask whose candidates are all above the ceiling cannot choose, whatever the defaults are', async () => {
    const { router, advisor } = harness({
      launchable: HIGH_ONLY_LAUNCHABLE,
      capabilities: highOnlyCapabilities(),
      preferences: WITH_DEFAULT
    })
    router.queueResponse(LOW_EFFORT)

    expect(await advisor.suggest({ prompt: 'split the parser', purpose: 'subtask' })).toStrictEqual(
      {
        ok: false,
        error: 'jev-could-not-choose'
      }
    )
  })
})
