import type { UiPreferenceKey, UiPreferencesMap, UiPreferenceWrite } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import { createFakeWindowApi } from '../../../contracts/ipc/testing/fakeWindowApi'
import { useModeAtLaunch } from './useModeAtLaunch'

/**
 * Settings › General "Mode at launch" (US-SET-002.AC09; 14 §2.2 A-N20, A-N21, A-N12; ISSUE-294): the generated fake
 * `window.api` stands in for UI main, which stores the pick and answers what it stored.
 */
type ModeAtLaunch = UiPreferencesMap['modeAtLaunch']

function world(options: { stored?: ModeAtLaunch; refuse?: boolean } = {}) {
  let stored: ModeAtLaunch = options.stored ?? 'last-used'
  const reads: UiPreferenceKey[][] = []
  const writes: UiPreferenceWrite[] = []
  const resets: ((e: { epoch: number }) => void)[] = []
  const api = createFakeWindowApi({
    getUiPreferences: (request) => {
      reads.push([...request.keys])
      return Promise.resolve(request.keys.includes('modeAtLaunch') ? { modeAtLaunch: stored } : {})
    },
    setUiPreference: (write) => {
      writes.push(write)
      if (options.refuse === true) {
        // How the router answers a write it refuses (ui-main/ipc/router.ts), typed looser than the row's answer.
        return Promise.resolve({
          ok: false,
          error: { code: 'NOT_SUPPORTED', message: 'not served', retryable: false }
        } as never)
      }
      if (write.key === 'modeAtLaunch') stored = write.value
      return Promise.resolve(write)
    },
    onUiPreferencesReset: (h) => (resets.push(h), () => {})
  })
  return {
    api,
    reads,
    writes,
    reset: (value: ModeAtLaunch) => {
      stored = value
      for (const h of resets) h({ epoch: 1 })
    }
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('useModeAtLaunch (US-SET-002.AC09; ADR-034 item 2)', () => {
  it('[US-SET-002.AC09, ADR-034] the options are the built modes, and the row shows what UI main stored', async () => {
    const w = world({ stored: 'veta' })
    const mode = useModeAtLaunch({ bridge: w.api, shipped: ['panel', 'veta'] })
    expect(mode.options).toEqual(['last-used', 'panel', 'veta'])
    expect(mode.value.value).toBeNull()
    await mode.read()
    expect(w.reads).toEqual([['modeAtLaunch']])
    expect(mode.value.value).toBe('veta')
    mode.dispose()
  })

  it('[US-SET-002.AC09] a pick is written through A-N21 and the row shows the answer, never the wish', async () => {
    const w = world()
    const mode = useModeAtLaunch({ bridge: w.api, shipped: ['panel', 'veta'] })
    await mode.read()
    await mode.pick('veta')
    expect(w.writes).toEqual([{ key: 'modeAtLaunch', value: 'veta' }])
    expect(mode.value.value).toBe('veta')
    // A mode this build does not ship is never written (BR-19: the option is absent, so no pick names it).
    await mode.pick('valle')
    expect(w.writes).toHaveLength(1)
    mode.dispose()
  })

  it('[US-SET-002.AC09] a refused write leaves the row on what is stored', async () => {
    const w = world({ refuse: true })
    const mode = useModeAtLaunch({ bridge: w.api, shipped: ['panel', 'veta'] })
    await mode.read()
    await mode.pick('panel')
    expect(mode.value.value).toBe('last-used')
    mode.dispose()
  })

  it('[ADR-024, BR-19] after a Reset metrics the row re-reads the stored value; a Panel-only build asks nothing', async () => {
    const w = world({ stored: 'veta' })
    const mode = useModeAtLaunch({ bridge: w.api, shipped: ['panel', 'veta'] })
    await mode.read()
    w.reset('last-used')
    await flush()
    expect(mode.value.value).toBe('last-used')
    mode.dispose()

    const panelOnly = world()
    const none = useModeAtLaunch({ bridge: panelOnly.api, shipped: ['panel'] })
    expect(none.options).toEqual([])
    await none.read()
    expect(panelOnly.reads).toEqual([])
    none.dispose()
  })
})
