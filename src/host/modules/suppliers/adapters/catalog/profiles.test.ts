// The Claude and Codex catalog records as their drivers read them (15 §4 `childEnv`, §5 Claude and
// Codex rows; ADR-009 D4): their transports in preference order and the one documented variable
// each carries.
import { describe, expect, it } from 'vitest'
import { childEnv } from '../drivers/shared/childEnv'
import type { PermissionModeCatalog } from '../../domain/profile'
import type { CapabilityCeiling } from '../../domain/capabilities'
import { merge } from '../../domain/mergeCapabilities'
import { CATALOG_RECORDS, OPENCODE_ACP, publicLaunchOf } from './profiles'

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

const codex = CATALOG_RECORDS.find((record) => record.profile.id === 'codex')

describe('the Codex catalog record', () => {
  it('[C-23, ADR-009] the app-server child keeps the person CODEX_HOME, app-server-rpc first, and nothing outside the allowlist', () => {
    // ADR-009 D4: the preferred Codex driver is CodexAppServerDriver, then codex-acp (15 §4.4, §4.5).
    expect(codex?.profile.drivers).toEqual(['app-server-rpc', 'acp'])
    const env = childEnv(
      {
        PATH: '/usr/bin',
        CODEX_HOME: '/home/j/.codex-work',
        OPENAI_API_KEY: 'never-forwarded',
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'never-forwarded'
      },
      'v1:install:launch-1:epoch',
      { providerVars: codex?.providerEnvVars ?? [], loopbackRelay: false, platform: 'linux' }
    )
    // 15 §5 Codex row: honour CODEX_HOME, so the launched codex's login, config and rollouts are
    // the ones the observer reads. A path, never a credential (ADR-008 item 2).
    expect(env).toEqual({
      PATH: '/usr/bin',
      CODEX_HOME: '/home/j/.codex-work',
      DWARFAI_SPAWN: 'v1:install:launch-1:epoch'
    })
  })
})

const opencode = CATALOG_RECORDS.find((record) => record.profile.id === 'opencode')

describe('the OpenCode catalog record', () => {
  it('[FM-084, S-031-3, C-25] http-server then acp behind the opencode-permissions gate, and the acp entry runs opencode acp on row O2 within the ceiling', () => {
    // ADR-009 D4: the server driver first (its probe reports launch false while S-031-3 has
    // verified no protection), then the acp fallback, option (c).
    expect(opencode?.profile.drivers).toEqual(['http-server', 'acp'])
    expect(opencode?.profile.answerChannelGate).toBe('opencode-permissions')
    expect(OPENCODE_ACP.agentArgs).toEqual(['acp'])
    // 15 §4.7 (HR D8): no question channel; SP-12 (foreman ruling 2026-10-17): the path-only
    // ticket-file relay entry for `opencode acp`.
    expect(OPENCODE_ACP.row.question).toBe('none')
    expect(OPENCODE_ACP.row.mcpInjection).toBe('ticket-file')
    // The row is inside the ceiling: the ADR-009 D2 merge lowers none of its fields.
    const ceiling = opencode?.ceiling as CapabilityCeiling
    const row = { ...OPENCODE_ACP.row, resume: 'none' as const }
    expect(merge(ceiling, row)).toEqual(row)
  })
})
