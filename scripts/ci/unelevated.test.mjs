// layer: L7
import { describe, expect, it } from 'vitest'
import {
  childEnvironment,
  generatePassword,
  integrityRid,
  isElevatedRid,
  parseArgs,
  PASSWORD_ENV
} from './unelevated.mjs'

// The pure half of scripts/ci/run-unelevated.mjs: how the Windows CI legs run the real Host's lanes as a standard
// local user, never elevated (ISSUE-021 L8 "not elevated for the test user"; ADR-002 D6; ISSUE-051).

describe('run-unelevated (Windows CI legs)', () => {
  it('[ADR-002] the generated password meets the Windows complexity rule and holds no character net user reads specially', () => {
    let counter = 0
    const random = (n) => Uint8Array.from({ length: n }, () => (counter += 53) & 0xff)
    const password = generatePassword(random)
    expect(password).toHaveLength(24)
    expect(password).toMatch(/[A-Z]/)
    expect(password).toMatch(/[a-z]/)
    expect(password).toMatch(/[0-9]/)
    expect(password).toMatch(/[-_.!]/)
    expect(password).not.toMatch(/[\s"*/^&|<>%]/)
    expect(generatePassword(random)).not.toBe(password)
  })

  it('[ADR-002] the child environment keeps the job environment but not the profile folders, the password or the elevated user, and trusts the checkout for git', () => {
    const env = childEnvironment({
      PATH: 'C:\\node',
      TZ: 'UTC',
      USERPROFILE: 'C:\\Users\\runneradmin',
      APPDATA: 'C:\\Users\\runneradmin\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\runneradmin\\AppData\\Local',
      TEMP: 'C:\\Users\\runneradmin\\AppData\\Local\\Temp',
      tmp: 'C:\\Users\\runneradmin\\AppData\\Local\\Temp',
      HOMEDRIVE: 'C:',
      HOMEPATH: '\\Users\\runneradmin',
      USERNAME: 'runneradmin',
      [PASSWORD_ENV]: 'secret'
    })
    expect(env).toEqual({
      PATH: 'C:\\node',
      TZ: 'UTC',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: '*'
    })
  })

  it('[ADR-002] the integrity level is read from whoami /groups and only medium or below counts as not elevated', () => {
    const csv = (rid) =>
      `"Everyone","Well-known group","S-1-1-0","Mandatory group"\r\n"Mandatory Label\\Medium Mandatory Level","Label","S-1-16-${rid}",""\r\n`
    expect(integrityRid(csv(8192))).toBe(8192)
    expect(integrityRid(csv(12288))).toBe(12288)
    expect(integrityRid('"Everyone","Well-known group","S-1-1-0",""')).toBeNull()
    expect(isElevatedRid(8192)).toBe(false)
    expect(isElevatedRid(12288)).toBe(true)
    expect(isElevatedRid(16384)).toBe(true)
    expect(isElevatedRid(null)).toBe(true)
  })

  it('[ADR-002] the arguments name the probe or the command after --', () => {
    expect(parseArgs(['--probe'])).toEqual({ kind: 'probe' })
    expect(parseArgs(['--', 'pnpm', 'test:os'])).toEqual({ kind: 'run', command: 'pnpm test:os' })
    expect(parseArgs([])).toEqual({ kind: 'usage' })
    expect(parseArgs(['--'])).toEqual({ kind: 'usage' })
  })
})
