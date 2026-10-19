// L8 OS lane (17 §1.3, §1.8): the ProcessIdentityProbe contract on this OS's real start-time reader (Windows
// PowerShell `StartTime`, Linux procfs, macOS `ps -o lstart=`), against this test process and a process that has
// exited. The double and the scripted-reader run are fakes/FakeIdentityProbe.test.ts and processStart.test.ts.
import { spawn } from 'node:child_process'
import { vi } from 'vitest'
import { createIdentityProbe, createProcessStartReader } from './processStart'
import { runIdentityProbeContract } from './testing/identityProbe.contract'
import { osQueryRunner, thisPlatform } from './testing/osQueryRunner'

// A cold Windows PowerShell answers one start-time read in up to a few seconds.
vi.setConfig({ testTimeout: 60_000 })

/** The pid of a process that ran and exited. */
function exitedPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true })
    child.once('error', reject)
    child.once('exit', () => resolve(child.pid ?? -1))
  })
}

runIdentityProbeContract(`createIdentityProbe on the real ${process.platform} reader`, async () => {
  const read = createProcessStartReader({ platform: thisPlatform(), runQuery: osQueryRunner() })
  const own = await read(process.pid)
  if (own.kind !== 'started') throw new Error(`this process's start time is ${own.kind}`)
  return {
    probe: createIdentityProbe(read),
    live: { pid: process.pid, processStartTimeMs: own.ms },
    gonePid: await exitedPid()
  }
})
