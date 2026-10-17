// The Claude catalog record as the stream-json driver reads it (15 §4 `childEnv`, §5 Claude row;
// ADR-009 D4): its transports in preference order and the one documented variable it carries.
import { describe, expect, it } from 'vitest'
import { childEnv } from '../drivers/shared/childEnv'
import { CATALOG_RECORDS } from './profiles'

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
