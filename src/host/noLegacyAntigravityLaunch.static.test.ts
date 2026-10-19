// layer: L7
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The step-3e deletion (ISSUE-189; 21 §2 row 3e "Legacy deleted"; §2.1 item 4): today's Antigravity launch leaves the
 * tree. Antigravity is launched (in development builds) only by the Host's `AntigravityNdjsonDriver`, which replaced
 * today's `antigravityHeldSession.ts` (the ISSUE-156 candidate decision). Read as text, because the Host never imports
 * legacy code (R16): today's runtime composes no Antigravity held session, and today's launcher neither lists
 * Antigravity as launchable nor builds an `agy` launch argv, so no legacy path starts an Antigravity session.
 */
const SRC = resolve(import.meta.dirname, '..')

describe('step-3e deletion (21 §2 row 3e)', () => {
  it('[ADR-001] runtime.ts composes no Antigravity held session and no legacy Antigravity launch path remains', () => {
    // AMENDED for ISSUE-243: today's runtime itself left the tree (21 §2 cut 5); while it existed it composed none.
    const runtimePath = resolve(SRC, 'main/runtime/runtime.ts')
    const runtime = existsSync(runtimePath) ? readFileSync(runtimePath, 'utf8') : ''
    expect(runtime).not.toMatch(
      /sessionLaunch\/antigravityHeldSession'|\bcreateAntigravityHeldSession\b/
    )
    expect(existsSync(resolve(SRC, 'main/sessionLaunch/antigravityHeldSession.ts'))).toBe(false)
    // Today's detached launch: no `agy` argv, and Antigravity is no launchable provider of today's launcher.
    // AMENDED for ISSUE-245: today's launcher itself left the tree (21 §2 cut 5); while it existed it built no agy argv.
    const launchPath = resolve(SRC, 'main/sessionLaunch/launch.ts')
    const launch = existsSync(launchPath) ? readFileSync(launchPath, 'utf8') : ''
    expect(launch).not.toMatch(/\bbuildAntigravityLaunchArgs\b/)
    // AMENDED for ISSUE-341: today's launchable-provider list itself left the tree (21 §2 cut 5); while it existed it
    // did not list Antigravity.
    const providersPath = resolve(SRC, 'main/domain/launchProviders.ts')
    const providers = existsSync(providersPath) ? readFileSync(providersPath, 'utf8') : ''
    const launchable = /export const LAUNCHABLE_PROVIDERS[^=]*=\s*\[([^\]]*)\]/.exec(providers)
    expect(launchable?.[1] ?? '').not.toMatch(/'antigravity'/)
  })
})
