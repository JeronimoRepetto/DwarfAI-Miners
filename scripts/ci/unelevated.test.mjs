// layer: L7
import { describe, expect, it } from 'vitest'
import {
  childEnvironment,
  cpuBusyFraction,
  ensureUserScript,
  generatePassword,
  integrityRid,
  isElevatedRid,
  isSettled,
  parseArgs,
  PASSWORD_ENV,
  topCpuConsumers,
  windowsPowerShellEnvironment
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

  it('[ADR-002] Windows PowerShell 5.1 started from a pwsh step does not inherit its PSModulePath', () => {
    expect(
      windowsPowerShellEnvironment({
        PATH: 'C:\node',
        PSModulePath: 'C:\pwsh7\Modules',
        psmodulepath: 'x'
      })
    ).toEqual({ PATH: 'C:\node' })
  })

  it('[ADR-002] the user script creates or resets the standard user from the password variable and adds it to Users by SID', () => {
    const script = ensureUserScript('dwarfai-ci', 'PW_VAR')
    const lines = script.split('\n')
    expect(lines[0]).toBe("$ErrorActionPreference = 'Stop'")
    expect(script).toContain('ConvertTo-SecureString $env:PW_VAR -AsPlainText -Force')
    expect(script).toMatch(
      /if \(\$null -eq \$user\) \{ New-LocalUser -Name 'dwarfai-ci' [^\n]*\} else \{ Set-LocalUser -Name 'dwarfai-ci' -Password \$password \}/
    )
    expect(script).toContain("Add-LocalGroupMember -SID 'S-1-5-32-545' -Member 'dwarfai-ci'")
    expect(script).not.toMatch(/Administrators|S-1-5-32-544/)
    // A statement that begins with `else` would not parse: else follows its if on the same statement.
    expect(lines.some((line) => /^\s*else\b/.test(line))).toBe(false)
  })

  it('[ADR-002] the arguments name the probe or the command after --', () => {
    expect(parseArgs(['--probe'])).toEqual({ kind: 'probe' })
    expect(parseArgs(['--', 'pnpm', 'test:os'])).toEqual({ kind: 'run', command: 'pnpm test:os' })
    expect(parseArgs([])).toEqual({ kind: 'usage' })
    expect(parseArgs(['--'])).toEqual({ kind: 'usage' })
  })
})

// The first logon of the freshly created user (the probe) starts background work on the runner that outlives it and
// slowed the OS lane's first wave 2.5 to 10 times (main run 36910936637). The probe therefore waits, after that logon,
// until the runner's CPUs stay quiet.
describe('run-unelevated: settling after the first logon (Windows CI legs)', () => {
  const cpu = (busy, idle) => ({ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } })

  it('[ADR-002] the busy fraction is the non-idle share of all CPU time between two readings', () => {
    const before = [cpu(1000, 9000), cpu(2000, 8000)]
    const after = [cpu(1900, 9100), cpu(2100, 8900)]
    // Busy 900 + 100 of 1000 + 1000 elapsed.
    expect(cpuBusyFraction(before, after)).toBeCloseTo(0.5, 10)
    expect(cpuBusyFraction(before, before)).toBe(0)
    expect(
      cpuBusyFraction(
        [{ times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }],
        [{ times: { user: 10, nice: 5, sys: 20, idle: 0, irq: 5 } }]
      )
    ).toBe(1)
  })

  it('[ADR-002] the runner counts as settled only once the last samples in a row are all below the threshold', () => {
    const rule = { threshold: 0.25, quiet: 3 }
    expect(isSettled([], rule)).toBe(false)
    expect(isSettled([0.1, 0.1], rule)).toBe(false)
    expect(isSettled([0.9, 0.1, 0.1, 0.1], rule)).toBe(true)
    expect(isSettled([0.1, 0.1, 0.1, 0.9], rule)).toBe(false)
    expect(isSettled([0.1, 0.25, 0.1], rule)).toBe(false)
  })

  it('[ADR-002] the processes that used the most CPU while waiting are named, a new process counting from zero', () => {
    const before = [
      { Id: 1, ProcessName: 'idle-ish', CPU: 10 },
      { Id: 2, ProcessName: 'MsMpEng', CPU: 100 },
      { Id: 3, ProcessName: 'gone', CPU: 50 }
    ]
    const after = [
      { Id: 1, ProcessName: 'idle-ish', CPU: 10.5 },
      { Id: 2, ProcessName: 'MsMpEng', CPU: 160 },
      { Id: 4, ProcessName: 'svchost', CPU: 20 },
      { Id: 5, ProcessName: 'protected', CPU: null }
    ]
    expect(topCpuConsumers(before, after, 2)).toEqual([
      { id: 2, name: 'MsMpEng', seconds: 60 },
      { id: 4, name: 'svchost', seconds: 20 }
    ])
    // ConvertTo-Json answers a lone process as an object, not an array.
    expect(
      topCpuConsumers(
        { Id: 2, ProcessName: 'MsMpEng', CPU: 1 },
        { Id: 2, ProcessName: 'MsMpEng', CPU: 3 },
        5
      )
    ).toEqual([{ id: 2, name: 'MsMpEng', seconds: 2 }])
  })
})
