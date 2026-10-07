// L2 (17 §1.2): the close-by-process rule of owner amendment I (2026-10-07) for observed Codex and
// OpenCode sessions, on the kernel's FakeProcessControl and a FakeClock: a session closes only once
// it is quiet for PROCESS_GONE_QUIET_MS and a readable listing shows no process of its provider in
// its folder on two reads PROCESS_GONE_CONFIRM_MS apart. Never from silence alone (BR-11, INV-26).
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../../kernel/fakes/FakeClock'
import { FakeProcessControl } from '../../../../kernel/fakes/FakeProcessControl'
import {
  PROCESS_GONE_CONFIRM_MS,
  PROCESS_GONE_QUIET_MS,
  PROCESS_LISTING_MAX_AGE_MS,
  ProcessGoneWatch,
  SharedProcessListing,
  folderKey
} from './processGone'

const T0 = 1_790_900_000_000
const S = 1_000
const HERE = 'C:\\Users\\j\\Project'

function world(options: { platform?: NodeJS.Platform; links?: Record<string, string> } = {}) {
  const clock = new FakeClock(T0)
  const processes = new FakeProcessControl()
  const listing = new SharedProcessListing({ processes, stems: ['codex', 'opencode'], clock })
  const watch = new ProcessGoneWatch({
    listing,
    stems: ['codex'],
    clock,
    platform: options.platform ?? 'win32',
    resolveFolder: (folder) => Promise.resolve(options.links?.[folder] ?? folder)
  })
  /** Moves to `atMs` after T0 and evaluates with the listing that moment asks for. */
  const at = async (atMs: number, folder: string | null = HERE): Promise<boolean> => {
    clock.advance(T0 + atMs - clock.now())
    await watch.gone('s1', folder)
    await listing.settled()
    return watch.gone('s1', folder)
  }
  return { clock, processes, listing, watch, at }
}

describe('ProcessGoneWatch', () => {
  it('[FM-059, BR-11, INV-26] a session quiet for less than 300 s is never closed and lists no process, even with no process of its provider anywhere', async () => {
    const { watch, processes, at } = world()
    watch.active('s1')

    for (let t = 0; t < PROCESS_GONE_QUIET_MS; t += 10 * S) expect(await at(t)).toBe(false)
    expect(await at(PROCESS_GONE_QUIET_MS - 1)).toBe(false)

    expect(processes.listings).toBe(0)
  })

  it('[FM-059, S4.33] a quiet session closes once two readable listings 30 s apart show no process of its provider in its folder, and not on the first', async () => {
    const { watch, at } = world()
    watch.active('s1')

    expect(await at(PROCESS_GONE_QUIET_MS)).toBe(false)
    expect(await at(PROCESS_GONE_QUIET_MS + 15 * S)).toBe(false)
    expect(await at(PROCESS_GONE_QUIET_MS + PROCESS_GONE_CONFIRM_MS - 1)).toBe(false)
    expect(await at(PROCESS_GONE_QUIET_MS + PROCESS_GONE_CONFIRM_MS)).toBe(true)
    // Closed stays closed until the session is active again.
    expect(await at(PROCESS_GONE_QUIET_MS + 600 * S)).toBe(true)
    watch.active('s1')
    expect(await at(PROCESS_GONE_QUIET_MS + 601 * S)).toBe(false)
  })

  it('[FM-059, INV-26] an unreadable listing, or a process of the provider whose working folder cannot be read, never closes anything and restarts the confirmation', async () => {
    const { watch, processes, at } = world()
    watch.active('s1')
    processes.scriptListing('unreadable')
    for (let t = PROCESS_GONE_QUIET_MS; t <= PROCESS_GONE_QUIET_MS + 120 * S; t += 15 * S) {
      expect(await at(t)).toBe(false)
    }

    processes.scriptListing('readable')
    processes.scriptProcess({ stem: 'codex', cwd: null })
    for (
      let t = PROCESS_GONE_QUIET_MS + 135 * S;
      t <= PROCESS_GONE_QUIET_MS + 240 * S;
      t += 15 * S
    ) {
      expect(await at(t)).toBe(false)
    }

    // The unreadable process ends: absence must now hold on two reads 30 s apart again.
    processes.endListed(null)
    expect(await at(PROCESS_GONE_QUIET_MS + 255 * S)).toBe(false)
    processes.scriptListing('unreadable')
    expect(await at(PROCESS_GONE_QUIET_MS + 270 * S)).toBe(false)
    processes.scriptListing('readable')
    expect(await at(PROCESS_GONE_QUIET_MS + 285 * S)).toBe(false)
    expect(await at(PROCESS_GONE_QUIET_MS + 300 * S)).toBe(false)
    expect(await at(PROCESS_GONE_QUIET_MS + 315 * S)).toBe(true)
  })

  it("[FM-059] only a process of the session's own provider in the session's own folder keeps it: one in another folder, or another provider's, does not", async () => {
    const kept = world()
    kept.watch.active('s1')
    // The same folder, spelled with another case and a trailing separator (Windows folds case).
    kept.processes.scriptProcess({ stem: 'codex', cwd: 'c:\\users\\j\\project\\' })
    for (let t = PROCESS_GONE_QUIET_MS; t <= PROCESS_GONE_QUIET_MS + 120 * S; t += 15 * S) {
      expect(await kept.at(t)).toBe(false)
    }

    const elsewhere = world()
    elsewhere.watch.active('s1')
    elsewhere.processes.scriptProcess({ stem: 'codex', cwd: 'C:\\Users\\j\\Other-Project' })
    elsewhere.processes.scriptProcess({ stem: 'opencode', cwd: HERE })
    expect(await elsewhere.at(PROCESS_GONE_QUIET_MS)).toBe(false)
    expect(await elsewhere.at(PROCESS_GONE_QUIET_MS + PROCESS_GONE_CONFIRM_MS)).toBe(true)
  })

  it('[FM-059] a folder reached through a link is the folder it resolves to, and case counts where the OS does not fold it', async () => {
    const linked = world({ platform: 'linux', links: { '/home/j/link': '/home/j/project' } })
    linked.watch.active('s1')
    linked.processes.scriptProcess({ stem: 'codex', cwd: '/home/j/project' })
    for (let t = PROCESS_GONE_QUIET_MS; t <= PROCESS_GONE_QUIET_MS + 60 * S; t += 15 * S) {
      expect(await linked.at(t, '/home/j/link')).toBe(false)
    }

    expect(folderKey('/home/j/Project/', 'linux')).not.toBe(folderKey('/home/j/project', 'linux'))
    expect(folderKey('/Users/j/Project/', 'darwin')).toBe(folderKey('/Users/j/project', 'darwin'))
    expect(folderKey('C:/Users/j/Project', 'win32')).toBe(
      folderKey('c:\\users\\j\\project\\', 'win32')
    )
  })

  it('[FM-059] a session with no known folder is never closed by process', async () => {
    const { watch, at } = world()
    watch.active('s1')

    for (let t = PROCESS_GONE_QUIET_MS; t <= PROCESS_GONE_QUIET_MS + 120 * S; t += 15 * S) {
      expect(await at(t, null)).toBe(false)
    }
  })

  it('[FM-059] activity after the first absent read restarts both the quiet gate and the confirmation', async () => {
    const { watch, at } = world()
    watch.active('s1')
    expect(await at(PROCESS_GONE_QUIET_MS)).toBe(false)
    watch.active('s1')

    expect(await at(PROCESS_GONE_QUIET_MS + PROCESS_GONE_CONFIRM_MS)).toBe(false)
    expect(await at(2 * PROCESS_GONE_QUIET_MS + 15 * S)).toBe(false)
    expect(await at(2 * PROCESS_GONE_QUIET_MS + 15 * S + PROCESS_GONE_CONFIRM_MS)).toBe(true)
  })
})

describe('SharedProcessListing', () => {
  it('[FM-059] one listing serves every caller for 15 s, and a read never waits for it', async () => {
    const clock = new FakeClock(T0)
    const processes = new FakeProcessControl()
    const listing = new SharedProcessListing({ processes, stems: ['codex', 'opencode'], clock })

    expect(listing.latest()).toBe(null)
    expect(listing.latest()).toBe(null)
    await listing.settled()
    for (let n = 0; n < 5; n++) expect(listing.latest()?.takenAt).toBe(T0)
    clock.advance(PROCESS_LISTING_MAX_AGE_MS - 1)
    expect(listing.latest()?.takenAt).toBe(T0)
    await listing.settled()
    expect(processes.listings).toBe(1)

    clock.advance(1)
    expect(listing.latest()?.takenAt).toBe(T0)
    await listing.settled()
    expect(listing.latest()?.takenAt).toBe(T0 + PROCESS_LISTING_MAX_AGE_MS)
    expect(processes.listings).toBe(2)
  })
})
