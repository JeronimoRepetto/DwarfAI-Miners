// layer: L6
// The step-3e public build (ISSUE-188 test 2; TC-188-02; 21 §2 row 3e; ADR-009 D6, PO #82; R-03): Antigravity's
// profile is `publicLaunch: 'gated'`, so a public build offers it on no launch surface and still observes it. The
// router's half is pinned here, over the table the root composes for a public build (`routesForBuild`, the one build
// flag, never a provider id):
//
// - the Add panel chips and the "Default provider" list read A-36 (`useAgentLaunch`, `useJevSettings`); Antigravity's
//   A-36 entry is the Host's in every 3e build, and a public Host lists no gated entry (the Host's half:
//   `antigravity-ndjson/publicBuild.test.ts`), so the merged catalog has none even though today's runtime offers one;
// - Antigravity's launch row (A-35 and its Retry path) is a development build's only: no `host` route reaches B-M33
//   for it in a public build;
// - Jev's candidates are the Host's `suppliers.launchable()` (A-50 `host`), and a delegated worker is launched only by
//   a Host driver (ADR-013), whose registry attaches no gated driver in a public build;
// - its sessions stay observed: A-13 and A-23 are the Host's for Antigravity, and today's feed keeps only the sessions
//   today's runtime launched (the Host observer reads the rest).
import { describe, expect, it } from 'vitest'
import { CATALOG_PROVIDER_IDS, type ChannelKey } from '@dwarfai/contracts'
import { legacyFeedModesOf } from '../index'
import { resolveRoute } from './routeResolver'
// AMENDED for ISSUE-235 (was: the release table `routesForBuild` / `ROUTES_RELEASE`): from the step-4a switch the 3e
// public build's table as it shipped is `testing/cut3eRoutes.ts`.
import { CUT_3E_RELEASE, cut3eRoutesForBuild } from './testing/cut3eRoutes'
import { dwarfWire, hostEntry, providerRowsWorld } from './testing/providerRowsWorld'

const [CLAUDE = '', CODEX = '', ANTIGRAVITY = '', OPENCODE = ''] = CATALOG_PROVIDER_IDS
const PUBLIC = cut3eRoutesForBuild({ publicBuild: true })
const LAUNCH_ROW: ChannelKey = 'agent:launch' // A-35
const PROVIDERS: ChannelKey = 'agent:providers' // A-36
const ACTIVATE: ChannelKey = 'dwarf:activate' // A-13
const SEND: ChannelKey = 'dwarf:sendText' // A-23
const JEV_ROUTE: ChannelKey = 'jev:route' // A-50
const REQUEST = '01920000-0000-7000-a000-000000000701'
const MESSAGE = '01920000-0000-7000-8000-0000000007b1'
const OBSERVED = '01920000-0000-7000-9000-000000000716'

describe('step 3e public build (21 §2 row 3e; ADR-009 D6)', () => {
  it('[ADR-009] a 3e public build offers Antigravity on no launch surface, as no Jev candidate, no default provider and no delegated worker, and still observes it', async () => {
    expect(CUT_3E_RELEASE).toBe('cut-3e')
    // A-35: no `host` route for Antigravity in a public build (the launch row is a development build's only).
    expect(resolveRoute(PUBLIC, LAUNCH_ROW, { provider: ANTIGRAVITY })?.owner).not.toBe('host')
    expect(
      PUBLIC.some(
        (route) =>
          route.channel === LAUNCH_ROW &&
          route.owner === 'host' &&
          route.qualifier?.provider === ANTIGRAVITY
      )
    ).toBe(false)
    // A-36, A-13, A-23 stay the Host's for Antigravity; Jev's candidates are the Host's (A-50).
    for (const key of [PROVIDERS, ACTIVATE, SEND]) {
      expect(resolveRoute(PUBLIC, key, { provider: ANTIGRAVITY })?.owner, key).toBe('host')
    }
    expect(resolveRoute(PUBLIC, JEV_ROUTE)?.owner).toBe('host')
    // Observed: today's feed keeps only what today's runtime launched; the Host observes the rest.
    expect(legacyFeedModesOf(PUBLIC)).toMatchObject({ [ANTIGRAVITY]: 'legacy-launched' })

    // Through the root's composition: the public Host lists no gated entry, and the merged catalog (the chips and the
    // "Default provider" list) holds no Antigravity entry although today's runtime offers Antigravity.
    const world = providerRowsWorld({
      table: PUBLIC,
      release: CUT_3E_RELEASE,
      dwarfs: [dwarfWire(OBSERVED, ANTIGRAVITY, false)],
      hostReplies: {
        'suppliers.launchable': [hostEntry(CLAUDE), hostEntry(CODEX)],
        'conversation.send': { ok: true, value: { messageId: MESSAGE } },
        'conversation.resolveConsole': {
          mode: 'log',
          command: { program: 'tail', args: [], cwd: '/w' }
        }
      },
      today: {
        'agent:providers': {
          providers: [
            { provider: CLAUDE, installed: true, launchable: true },
            { provider: CODEX, installed: true, launchable: true },
            { provider: ANTIGRAVITY, installed: true, launchable: true },
            { provider: OPENCODE, installed: true, launchable: true }
          ]
        }
      }
    })
    // AMENDED for ISSUE-240, the 4b deletion (was: the catalog through `CatalogMergeAdapter` listing Claude, Codex and
    // OpenCode, never Antigravity): the adapter left the tree.
    // The observed Antigravity dwarf's send and console reach the Host.
    expect(
      await world.invoke(SEND, {
        dwarfId: OBSERVED,
        text: 'go on',
        attachments: [],
        requestId: REQUEST
      })
    ).toEqual({ ok: true, value: { ok: true, value: { messageId: MESSAGE } } })
    expect(await world.invoke(ACTIVATE, { dwarfId: OBSERVED, purpose: 'open-console' })).toEqual({
      ok: true,
      value: { outcome: 'opened', mode: 'log' }
    })
    expect(world.hostCalls.map(([method]) => method)).toEqual([
      'conversation.send',
      'conversation.resolveConsole'
    ])
    expect(world.legacyServed).toEqual([])
    world.dispose()
  })
})
