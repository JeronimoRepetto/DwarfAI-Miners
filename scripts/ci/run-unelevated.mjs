#!/usr/bin/env node
// Runs one command of a Windows CI leg as a standard local user, never elevated (ISSUE-051; ISSUE-021 L8 "not
// elevated for the test user"; ADR-002 D6: the DwarfAI Host refuses to start elevated, and GitHub's hosted Windows
// runner runs every step elevated). The gap is closed here, in CI; the Host has no bypass.
//
//   node scripts/ci/run-unelevated.mjs --probe          prints the user's whoami /groups, fails unless medium or below
//   node scripts/ci/run-unelevated.mjs -- pnpm test:os  runs the command as that user; its exit code is this script's
//
// What it does, with Windows' own tools only:
// 1. creates the local user `dwarfai-ci` (or resets its password) with a fresh random password, a member of Users
//    (well-known SID S-1-5-32-545), through Windows PowerShell's LocalAccounts module; the password travels in an
//    environment variable, never in argv;
// 2. gives it Modify on the checkout and read and execute on the Node.js and pnpm folders of the job (icacls);
// 3. writes the command and the job's environment (scripts/ci/unelevated.mjs `childEnvironment`) into a file only
//    that user and the job can read, and starts scripts/ci/start-as-user.ps1, which logs the user on with its profile
//    (CreateProcessWithLogonW, through .NET `ProcessStartInfo.UserName`) on the job's desktop, streams the merged
//    output into the job log and answers the command's exit code;
// 4. with --probe, which runs first in each Windows job and so performs the user's first logon (its profile is created
//    then), waits until the runner's CPUs are quiet again before the step ends: that logon starts background work that
//    outlives it and slowed the lane after it 2.5 to 10 times (main run 36910936637). The processes that used the CPU
//    meanwhile are named in the log.
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  childEnvironment,
  cpuBusyFraction,
  generatePassword,
  integrityRid,
  isElevatedRid,
  isSettled,
  parseArgs,
  ensureUserScript,
  PASSWORD_ENV,
  SETTLE,
  topCpuConsumers,
  windowsPowerShellEnvironment
} from './unelevated.mjs'

const USER = 'dwarfai-ci'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const POWERSHELL = path.join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
)
const PROBE_COMMAND = 'whoami /groups /fo csv /nh && whoami'

function fail(message) {
  console.error(`run-unelevated: ${message}`)
  process.exit(2)
}

/** Runs a Windows tool with an argv array (no shell); its output goes to the job log. */
function tool(file, args, env = process.env) {
  execFileSync(file, args, { stdio: 'inherit', env, windowsHide: true })
}

function powershell(script, env) {
  tool(
    POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    windowsPowerShellEnvironment(env)
  )
}

function ensureUser(password) {
  powershell(ensureUserScript(USER, PASSWORD_ENV), { ...process.env, [PASSWORD_ENV]: password })
}

function grant(folder, rights) {
  tool('icacls', [folder, '/grant', `${USER}:(OI)(CI)${rights}`, '/C', '/Q'])
}

/** The runner's processes and their CPU seconds, as Get-Process | ConvertTo-Json answers them; null when unreadable. */
function processSnapshot() {
  try {
    return JSON.parse(
      execFileSync(
        POWERSHELL,
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-Process | Select-Object Id, ProcessName, CPU | ConvertTo-Json -Compress'
        ],
        { encoding: 'utf8', env: windowsPowerShellEnvironment(process.env), windowsHide: true }
      )
    )
  } catch (error) {
    console.log(`run-unelevated: the process list was not read: ${error.message}`)
    return null
  }
}

/** Waits until the runner's CPUs are quiet (SETTLE), at most SETTLE.capMs; logs the samples and the busiest processes. */
async function settle() {
  const startedAt = Date.now()
  const before = processSnapshot()
  const samples = []
  let reading = cpus()
  while (!isSettled(samples, SETTLE) && Date.now() - startedAt < SETTLE.capMs) {
    await new Promise((resolve) => setTimeout(resolve, SETTLE.intervalMs))
    const next = cpus()
    samples.push(cpuBusyFraction(reading, next))
    reading = next
  }
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
  const settled = isSettled(samples, SETTLE)
  console.log(
    `run-unelevated: runner ${settled ? 'settled' : 'still busy'} after ${seconds} s; CPU busy per second: ${samples
      .map((busy) => Math.round(busy * 100))
      .join(' ')}%`
  )
  const after = processSnapshot()
  if (before !== null && after !== null) {
    const top = topCpuConsumers(before, after, 8)
      .map((process) => `${process.name} (${process.id}) ${process.seconds.toFixed(1)} s`)
      .join(', ')
    console.log(`run-unelevated: CPU used while waiting: ${top === '' ? 'none measurable' : top}`)
  }
  if (!settled)
    console.log(
      `::warning::the runner did not settle within ${SETTLE.capMs / 1000} s after the first logon`
    )
}

/** Starts the command as the user; resolves with its exit code, teeing its output into `seen` when given. */
function runAsUser(command, password, seen) {
  const workDir = process.cwd()
  const specDir = path.join(process.env.RUNNER_TEMP ?? tmpdir(), 'dwarfai-unelevated')
  mkdirSync(specDir, { recursive: true })
  grant(specDir, 'R')
  const specFile = path.join(specDir, `spec-${process.pid}.json`)
  writeFileSync(specFile, JSON.stringify({ command, env: childEnvironment(process.env) }), 'utf8')
  return new Promise((resolve) => {
    const child = spawn(
      POWERSHELL,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(HERE, 'start-as-user.ps1'),
        '-User',
        USER,
        '-SpecFile',
        specFile,
        '-WorkDir',
        workDir
      ],
      {
        env: windowsPowerShellEnvironment({ ...process.env, [PASSWORD_ENV]: password }),
        stdio: ['ignore', 'pipe', 'inherit'],
        windowsHide: true
      }
    )
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk)
      if (seen !== undefined) seen.push(chunk.toString('utf8'))
    })
    child.on('error', (error) => {
      console.error(`run-unelevated: the launcher did not start: ${error.message}`)
      resolve(2)
    })
    // The output is read to its end ('close'), but a process the command left behind may hold the launcher's output
    // open: 5 s after the launcher exited, its exit code is taken anyway.
    let exitCode = null
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      rmSync(specFile, { force: true })
      resolve(exitCode ?? 1)
    }
    child.on('exit', (code) => {
      exitCode = code
      setTimeout(finish, 5_000).unref()
    })
    child.on('close', finish)
  })
}

async function main() {
  if (process.platform !== 'win32') fail('Windows only')
  const args = parseArgs(process.argv.slice(2))
  if (args.kind === 'usage') fail('usage: run-unelevated.mjs --probe | -- <command…>')
  const password = generatePassword((n) => randomBytes(n))
  ensureUser(password)
  grant(process.cwd(), 'M')
  for (const folder of new Set([path.dirname(process.execPath), process.env.PNPM_HOME])) {
    if (folder !== undefined && folder !== '') grant(folder, 'RX')
  }
  if (args.kind === 'probe') {
    const seen = []
    const logonAt = Date.now()
    const code = await runAsUser(PROBE_COMMAND, password, seen)
    console.log(
      `run-unelevated: the first logon and the probe took ${((Date.now() - logonAt) / 1000).toFixed(1)} s`
    )
    const rid = integrityRid(seen.join(''))
    console.log(
      `run-unelevated: integrity RID ${String(rid)} (${isElevatedRid(rid) ? 'elevated' : 'not elevated'})`
    )
    if (code !== 0 || isElevatedRid(rid)) process.exit(1)
    await settle()
    process.exit(0)
  }
  process.exit(await runAsUser(args.command, password))
}

await main()
