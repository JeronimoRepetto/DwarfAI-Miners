// L3 (17 §1.3): the per-OS process listings of `ProcessControl.listProcesses` (owner amendment I),
// each over scripted OS answers (procfs reads, `ps` / `lsof` output, the PowerShell rows), so the
// macOS and Linux rules are asserted on every host. No real process is listed here; the L8 lane
// (`NodeProcessControl.os.test.ts`) lists real stubs.
import { describe, expect, it } from 'vitest'
import type { QueryOutcome, QueryRunner } from '../probe/types'
import {
  createDarwinListing,
  createLinuxListing,
  createWin32Listing,
  matchedStem,
  parseWin32Listing,
  win32ListingScript
} from './listing'

const b64 = (text: string): string => Buffer.from(text, 'utf16le').toString('base64')
const errno = (code: string): Error => Object.assign(new Error(code), { code })

describe('matchedStem', () => {
  it('[INV-51, FM-059] a process carries a stem by its executable, a native build of it, or a script it runs under node, bun or deno', () => {
    const stems = ['codex', 'opencode']

    expect(matchedStem({ executable: 'C:\\Tools\\Codex.EXE', argv: [] }, stems)).toBe('codex')
    expect(
      matchedStem({ executable: '/opt/codex-x86_64-unknown-linux-musl', argv: [] }, stems)
    ).toBe('codex')
    expect(
      matchedStem(
        {
          executable: '/usr/bin/node',
          argv: ['node', '--no-warnings', '/usr/lib/node_modules/opencode-ai/bin/opencode']
        },
        stems
      )
    ).toBe('opencode')
    // A script path split on a space by `ps` still ends in the script's own name.
    expect(
      matchedStem(
        {
          executable: '/usr/local/bin/node',
          argv: ['node', '/Users/j/Application', 'Support/codex.js']
        },
        stems
      )
    ).toBe('codex')
    expect(matchedStem({ executable: null, argv: ['codex', 'resume'] }, stems)).toBe('codex')
  })

  it('[INV-51, FM-059] a process carrying no wanted stem is not listed: a codex argument to another program, or a stem only sharing a prefix', () => {
    const stems = ['codex']

    expect(matchedStem({ executable: '/usr/bin/vim', argv: ['vim', 'codex.js'] }, stems)).toBe(null)
    expect(matchedStem({ executable: '/usr/bin/codexplorer', argv: [] }, stems)).toBe(null)
    expect(matchedStem({ executable: '/usr/bin/node', argv: ['node', 'build.js'] }, stems)).toBe(
      null
    )
    expect(matchedStem({ executable: '/usr/bin/codex', argv: [] }, [])).toBe(null)
  })
})

describe('createLinuxListing', () => {
  /** A scripted procfs: pid → cmdline, exe link, cwd link (null = unreadable). */
  function procfs(
    table: Record<number, { cmdline: string[] | null; exe?: string | null; cwd?: string | null }>
  ) {
    return createLinuxListing({
      listDir: (path) => {
        if (path !== '/proc') return Promise.reject(errno('ENOENT'))
        return Promise.resolve([...Object.keys(table), 'self', 'stat'])
      },
      readText: (path) => {
        const pid = Number(/^\/proc\/(\d+)\/cmdline$/.exec(path)?.[1])
        const argv = table[pid]?.cmdline
        if (argv === undefined || argv === null) return Promise.reject(errno('ENOENT'))
        return Promise.resolve(`${argv.join('\0')}\0`)
      },
      readLink: (path) => {
        const [, pid, link] = /^\/proc\/(\d+)\/(exe|cwd)$/.exec(path) ?? []
        const value = table[Number(pid)]?.[link as 'exe' | 'cwd']
        return value === undefined || value === null
          ? Promise.reject(errno('EACCES'))
          : Promise.resolve(value)
      }
    })
  }

  it('[INV-51, FM-059] Linux lists the processes carrying a stem with the working folder procfs links, and null where the link cannot be read', async () => {
    const listing = procfs({
      10: { cmdline: ['/usr/bin/codex'], exe: '/usr/bin/codex', cwd: '/home/j/project-a' },
      11: { cmdline: ['node', '/usr/lib/codex/bin/codex.js'], exe: '/usr/bin/node', cwd: null },
      12: { cmdline: ['/usr/bin/bash'], exe: '/usr/bin/bash', cwd: '/home/j/project-a' },
      // Ended between the folder listing and its read: simply not there.
      13: { cmdline: null }
    })

    expect(await listing(['codex'])).toEqual({
      ok: true,
      value: [
        { executable: '/usr/bin/codex', argv: ['/usr/bin/codex'], cwd: '/home/j/project-a' },
        {
          executable: '/usr/bin/node',
          argv: ['node', '/usr/lib/codex/bin/codex.js'],
          cwd: null
        }
      ]
    })
  })

  it('[INV-51, FM-059] Linux answers why when /proc itself cannot be listed', async () => {
    const listing = createLinuxListing({
      listDir: () => Promise.reject(errno('EACCES')),
      readText: () => Promise.reject(errno('EACCES')),
      readLink: () => Promise.reject(errno('EACCES'))
    })

    expect(await listing(['codex'])).toEqual({ ok: false, cause: 'could not read /proc (EACCES)' })
  })
})

describe('createDarwinListing', () => {
  /** A scripted macOS: answers ps and lsof from the argv, recording each call. */
  function darwin(answers: { comm: QueryOutcome; args?: QueryOutcome; lsof?: QueryOutcome }): {
    runQuery: QueryRunner
    calls: Array<{ file: string; args: readonly string[] }>
  } {
    const calls: Array<{ file: string; args: readonly string[] }> = []
    const runQuery: QueryRunner = (file, args) => {
      calls.push({ file, args })
      if (file === '/bin/ps' && args.includes('pid=,comm=')) return Promise.resolve(answers.comm)
      if (file === '/bin/ps') return Promise.resolve(answers.args ?? { ok: false, cause: 'none' })
      return Promise.resolve(answers.lsof ?? { ok: false, cause: 'none' })
    }
    return { runQuery, calls }
  }

  it("[INV-51, FM-059] macOS names each process by ps's executable path, reads an interpreter's arguments, and reads working folders with lsof for the matches only", async () => {
    const { runQuery, calls } = darwin({
      comm: {
        ok: true,
        stdout: [
          '  1 /sbin/launchd',
          ' 20 /Users/j/Library/Application Support/bin/codex',
          ' 21 /usr/local/bin/node',
          ' 22 /usr/local/bin/node',
          ''
        ].join('\n')
      },
      args: {
        ok: true,
        stdout: ' 21 node /usr/local/lib/node_modules/opencode-ai/bin/opencode\n 22 node build.js\n'
      },
      lsof: { ok: true, stdout: 'p20\nfcwd\nn/Users/j/Project A\np21\nfcwd\nn/Users/j/b\n' }
    })

    const listed = await createDarwinListing({ runQuery })(['codex', 'opencode'])

    expect(listed).toEqual({
      ok: true,
      value: [
        {
          executable: '/Users/j/Library/Application Support/bin/codex',
          argv: [],
          cwd: '/Users/j/Project A'
        },
        {
          executable: '/usr/local/bin/node',
          argv: ['node', '/usr/local/lib/node_modules/opencode-ai/bin/opencode'],
          cwd: '/Users/j/b'
        }
      ]
    })
    expect(calls.map((call) => [call.file, ...call.args])).toEqual([
      ['/bin/ps', '-A', '-o', 'pid=,comm='],
      ['/bin/ps', '-o', 'pid=,args=', '-p', '21,22'],
      ['/usr/sbin/lsof', '-a', '-d', 'cwd', '-Fn', '-p', '20,21']
    ])
  })

  it('[INV-51, FM-059] macOS keeps a match whose folder lsof could not read as null, and answers why when ps fails', async () => {
    const unreadableFolders = darwin({
      comm: { ok: true, stdout: ' 20 /usr/local/bin/codex\n' },
      lsof: { ok: false, cause: 'exited with code 1' }
    })
    expect(await createDarwinListing(unreadableFolders)(['codex'])).toEqual({
      ok: true,
      value: [{ executable: '/usr/local/bin/codex', argv: [], cwd: null }]
    })

    const noPs = darwin({ comm: { ok: false, cause: 'timed out after 10000 ms' } })
    expect(await createDarwinListing(noPs)(['codex'])).toEqual({
      ok: false,
      cause: 'timed out after 10000 ms'
    })

    // An interpreter whose arguments cannot be read might be the provider: the listing is unreadable.
    const noArgs = darwin({
      comm: { ok: true, stdout: ' 21 /usr/local/bin/node\n' },
      args: { ok: false, cause: 'exited with code 1' }
    })
    expect(await createDarwinListing(noArgs)(['codex'])).toEqual({
      ok: false,
      cause: 'exited with code 1'
    })
  })
})

describe('createWin32Listing', () => {
  it('[INV-51, FM-059] Windows lists through Windows PowerShell 5.1 with an encoded script that prefilters by stem and reads the working folder of the matches', async () => {
    const calls: Array<{ file: string; args: readonly string[]; dropEnv?: readonly string[] }> = []
    const runQuery: QueryRunner = (file, args, options) => {
      calls.push({
        file,
        args,
        ...(options.dropEnv === undefined ? {} : { dropEnv: options.dropEnv })
      })
      return Promise.resolve({
        ok: true,
        stdout: [
          `R\t${b64('C:\\Tools\\codex.exe')}\t${b64('codex.exe resume')}\t${b64('C:\\Users\\j\\Project\\')}`,
          `R\t${b64('C:\\Program Files\\nodejs\\node.exe')}\t${b64('"C:\\Program Files\\nodejs\\node.exe" C:\\npm\\codex.js')}\t-`,
          'END',
          ''
        ].join('\r\n')
      })
    }

    const listed = await createWin32Listing({ runQuery, env: { SystemRoot: 'C:\\Windows' } })([
      'codex'
    ])

    expect(listed).toEqual({
      ok: true,
      value: [
        {
          executable: 'C:\\Tools\\codex.exe',
          argv: ['codex.exe', 'resume'],
          cwd: 'C:\\Users\\j\\Project'
        },
        {
          executable: 'C:\\Program Files\\nodejs\\node.exe',
          argv: ['C:\\Program Files\\nodejs\\node.exe', 'C:\\npm\\codex.js'],
          cwd: null
        }
      ]
    })
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call?.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(call?.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand'])
    expect(Buffer.from(call?.args[3] ?? '', 'base64').toString('utf16le')).toBe(
      win32ListingScript(['codex'])
    )
    expect(call?.dropEnv).toEqual(['PSModulePath'])
  })

  it('[INV-51, FM-059] a Windows answer without its end line, or a failed PowerShell, is unreadable, never an empty listing', async () => {
    expect(parseWin32Listing(`R\t${b64('C:\\codex.exe')}\t-\t-\r\n`)).toBe(null)
    expect(parseWin32Listing('END\r\n')).toEqual([])
    expect(parseWin32Listing('R\tnot base64 at all\t-\t-\r\nEND\r\n')).toBe(null)

    const failing = createWin32Listing({
      runQuery: () => Promise.resolve({ ok: false, cause: 'exited with code 1' }),
      env: {}
    })
    expect(await failing(['codex'])).toEqual({ ok: false, cause: 'exited with code 1' })
  })

  it('[INV-51] the Windows script keeps only stem characters, so no stem can inject into it', () => {
    const script = win32ListingScript(["codex'; Remove-Item C:\\ -Recurse; '", 'open code'])

    expect(script).toContain("'(?i)(codexRemove-ItemC-Recurse|opencode)'")
    expect(script).not.toContain('Remove-Item C:')
  })
})
