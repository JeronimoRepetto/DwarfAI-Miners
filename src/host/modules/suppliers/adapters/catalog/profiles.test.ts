// The Claude catalog record as the stream-json driver reads it (15 §4 `childEnv`, §5 Claude row;
// ADR-009 D4): its transports in preference order and the one documented variable it carries.
import { describe, expect, it } from 'vitest'
import { childEnv } from '../drivers/shared/childEnv'
import type { PermissionModeCatalog } from '../../domain/profile'
import { CATALOG_RECORDS, publicLaunchOf } from './profiles'

const claude = CATALOG_RECORDS.find((record) => record.profile.id === 'claude')

describe('the Claude catalog record', () => {
  it('[C-23, ADR-009] the stream-json child keeps the person CLAUDE_CONFIG_DIR and nothing outside the allowlist', () => {
    expect(claude?.profile.drivers).toEqual(['acp', 'stream-json'])
    const env = childEnv(
      {
        PATH: '/usr/bin',
        CLAUDE_CONFIG_DIR: '/home/j/.claude-work',
        ANTHROPIC_API_KEY: 'never-forwarded',
        CLAUDE_CODE_OAUTH_TOKEN: 'never-forwarded'
      },
      'v1:install:launch-1:epoch',
      { providerVars: claude?.providerEnvVars ?? [], loopbackRelay: false, platform: 'linux' }
    )
    expect(env).toEqual({
      PATH: '/usr/bin',
      CLAUDE_CONFIG_DIR: '/home/j/.claude-work',
      DWARFAI_SPAWN: 'v1:install:launch-1:epoch'
    })
  })
})

describe('the public launch of a catalog record', () => {
  it('[C-22, ADR-011] a permission ceiling of none with no verified deny policy is gated in public builds, and every catalog record keeps that rule', () => {
    const verified: PermissionModeCatalog = { specs: [], denyPolicyVerified: true }
    const unverified: PermissionModeCatalog = { specs: [], denyPolicyVerified: false }
    expect(publicLaunchOf({ permission: 'none' })).toBe('gated')
    expect(publicLaunchOf({ permission: 'none' }, unverified)).toBe('gated')
    expect(publicLaunchOf({ permission: 'none' }, verified)).toBe('enabled')
    expect(publicLaunchOf({ permission: 'policy-only' })).toBe('enabled')
    expect(publicLaunchOf({ permission: 'interactive' })).toBe('enabled')
    // A development-only record never reaches a public build (recordsForBuild), so it is exempt.
    for (const record of CATALOG_RECORDS.filter((entry) => entry.developmentOnly !== true)) {
      if (publicLaunchOf(record.ceiling, record.modes) === 'gated') {
        expect(record.profile.publicLaunch, record.profile.id).toBe('gated')
      }
    }
  })
})
