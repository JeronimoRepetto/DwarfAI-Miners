#!/usr/bin/env node
// A stub for the Host's in-job read on Windows (13 FM-012; ISSUE-056; 17 §1.8: processes under test are stubs, never
// provider CLIs). Started with no shell as `node job-probe.mjs <mode> ...`:
//
//   report <winPipeNode> <outFile>
//     loads the Host's native helper and writes {"atStart": <isProcessInJob()>, "afterSpawn": <isProcessInJob()>} to
//     outFile: the first read before anything is spawned, the second after one plain (non-detached) child_process
//     spawn, which is when libuv adds this process to a job of its own. Exits once written.
//   launch <winLaunchNode> <winPipeNode> <outFile>
//     starts `report` through the UI's launch helper the way the launcher starts the Host (windows.ts; ADR-002 D6
//     items 1 and 2): job breakaway, and WMI `Win32_Process.Create` when breakaway is refused. Writes how it went to
//     `<outFile>.launch`, then exits; the started process writes outFile itself.
//   wmi <winLaunchNode> <winPipeNode> <outFile>
//     the WMI step alone, as `launch` takes it on a machine whose job forbids breakaway.
//
// Every process here exits within CAP_MS, so a forgotten stub never outlives its test run.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const CAP_MS = 20_000
setTimeout(() => process.exit(3), CAP_MS).unref()

function load(binary) {
  const module = { exports: {} }
  process.dlopen(module, binary)
  return module.exports
}

const [mode, ...rest] = process.argv.slice(2)

if (mode === 'report') {
  const [winPipe, outFile] = rest
  const helper = load(winPipe)
  const atStart = helper.isProcessInJob()
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true })
  child.once('exit', () => {
    writeFileSync(outFile, JSON.stringify({ atStart, afterSpawn: helper.isProcessInJob() }))
    process.exit(0)
  })
} else if (mode === 'launch' || mode === 'wmi') {
  const [winLaunch, winPipe, outFile] = rest
  const helper = load(winLaunch)
  const quote = (arg) => `"${arg.replace(/"/g, '\\"')}"`
  const commandLine = [process.execPath, fileURLToPath(import.meta.url), 'report', winPipe, outFile]
    .map(quote)
    .join(' ')
  const entries = Object.entries(process.env)
    .filter(([name, value]) => name !== '' && !name.includes('=') && value !== undefined)
    .sort(([a], [b]) => (a.toUpperCase() < b.toUpperCase() ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
  // Not the answer's folder: a working folder the started process still holds could not be removed after it.
  const cwd = os.tmpdir()
  const steps = []
  if (mode === 'launch') {
    // CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_BREAKAWAY_FROM_JOB | CREATE_NEW_PROCESS_GROUP |
    // CREATE_NO_WINDOW: the launcher's BREAKAWAY_CREATION_FLAGS (windows.ts).
    const flags = 0x4 | 0x400 | 0x01000000 | 0x200 | 0x08000000
    const result = helper.breakaway(
      process.execPath,
      commandLine,
      cwd,
      `${entries.join('\0')}\0\0`,
      flags
    )
    if (result.process) helper.release(result.process)
    steps.push({ how: 'breakaway', status: result.status, code: result.code })
  }
  if (steps.length === 0 || steps[0].status === 'refused') {
    const created = await helper.wmiCreate(commandLine, cwd, entries)
    steps.push({ how: 'wmi', status: created.status, code: created.code })
  }
  writeFileSync(`${outFile}.launch`, JSON.stringify(steps))
  process.exit(0)
} else {
  process.stderr.write(`job-probe: unknown mode ${JSON.stringify(mode)}\n`)
  process.exit(2)
}
