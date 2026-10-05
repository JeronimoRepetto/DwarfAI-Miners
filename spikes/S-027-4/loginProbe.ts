import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, release, tmpdir, uptime, userInfo } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loginEntryFor, type EntryCommand } from './loginEntry.ts'

/**
 * Spike S-027-4, the real-login half (guide `clean-vm.md`): installs the candidate per-user login entry under the
 * fixed throwaway name `…s0274…login-probe`, pointing at the throwaway app `backgroundApp.cjs` with `--background`
 * and a marker file, so that after a real sign-out and sign-in the OS's own login start can be checked. Run from the
 * repository root with Node 24:
 *
 *   node spikes/S-027-4/loginProbe.ts install           write the entry (no elevation)
 *   node spikes/S-027-4/loginProbe.ts read              print what the entry reads back (also after the person
 *                                                       switched it off in the OS's startup list)
 *   node spikes/S-027-4/loginProbe.ts check --out <f>   after signing in again: did the OS start the app, with
 *                                                       --background and no window? Writes the scrubbed result
 *   node spikes/S-027-4/loginProbe.ts remove            remove the entry and the probe folder
 *
 * It never reads or changes an entry whose name it did not build itself.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ELECTRON = createRequire(import.meta.url)('electron') as unknown as string
const PROBE_DIR = path.resolve('coverage', 's0274-login-probe')
const APP_DIR = path.join(PROBE_DIR, 'app')
const MARKER = path.join(PROBE_DIR, 'marker.jsonl')
const INSTALLED = path.join(PROBE_DIR, 'installed.json')
const entry = loginEntryFor(process.platform, 'login-probe')

function scrub(text: string): string {
  let out = text
  for (const [value, placeholder] of [
    [tmpdir(), '<tmp>'],
    [process.cwd(), '<repo>'],
    [homedir(), '<home>'],
    [userInfo().username, '<user>']
  ] as const) {
    if (value === '') continue
    for (const spelling of [JSON.stringify(value).slice(1, -1), value]) {
      out = out.split(spelling).join(placeholder)
    }
  }
  return out
}

function print(value: unknown): void {
  console.log(scrub(JSON.stringify(value, null, 2)))
}

function install(): void {
  rmSync(PROBE_DIR, { recursive: true, force: true })
  mkdirSync(APP_DIR, { recursive: true })
  copyFileSync(path.join(HERE, 'backgroundApp.cjs'), path.join(APP_DIR, 'main.cjs'))
  writeFileSync(
    path.join(APP_DIR, 'package.json'),
    JSON.stringify({ name: 'dwarfai-s0274-login-probe', main: 'main.cjs' })
  )
  // A syntax error in an Electron main file opens a modal: Node checks it first.
  execFileSync(process.execPath, ['--check', path.join(APP_DIR, 'main.cjs')])
  const command: EntryCommand = {
    executable: ELECTRON,
    args: [
      APP_DIR,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      '--background',
      `--s0274-marker=${MARKER}`
    ]
  }
  entry.write(command)
  writeFileSync(INSTALLED, JSON.stringify({ installedAt: new Date().toISOString() }))
  print({ installed: entry.kind, location: entry.location, readBack: entry.read() })
  console.log(
    'INSTALLED. Now sign out, sign in again, wait one minute, then run the check command.'
  )
}

function check(out: string | undefined): void {
  const installedAt = existsSync(INSTALLED)
    ? (JSON.parse(readFileSync(INSTALLED, 'utf8')) as { installedAt: string }).installedAt
    : null
  const events = existsSync(MARKER)
    ? readFileSync(MARKER, 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : []
  const started = events.find((event) => event['event'] === 'started')
  const result = {
    spike: 'S-027-4',
    step: 'real login',
    platform: process.platform,
    osRelease: release(),
    checkedAt: new Date().toISOString(),
    systemUptimeSeconds: Math.round(uptime()),
    desktop:
      process.platform === 'linux'
        ? {
            XDG_CURRENT_DESKTOP: process.env['XDG_CURRENT_DESKTOP'] ?? '(unset)',
            XDG_SESSION_TYPE: process.env['XDG_SESSION_TYPE'] ?? '(unset)'
          }
        : null,
    installedAt,
    entry: { kind: entry.kind, location: entry.location },
    readBack: entry.read(),
    markerEvents: events,
    answers: {
      startedByTheOsAfterInstall:
        started !== undefined && installedAt !== null && String(started['startedAt']) > installedAt,
      startedWithBackground: started?.['background'] === true,
      windowsOpened: started?.['windows'] ?? null,
      trayIcon: started?.['tray'] ?? null
    }
  }
  if (out) {
    mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
    writeFileSync(path.resolve(out), `${scrub(JSON.stringify(result, null, 2))}\n`)
  }
  print(result.answers)
  const ok =
    result.answers.startedByTheOsAfterInstall &&
    result.answers.startedWithBackground &&
    result.answers.windowsOpened === 0
  console.log(ok ? 'CHECK PASSED' : 'CHECK FAILED')
}

function remove(): void {
  entry.remove()
  const back = entry.read()
  rmSync(PROBE_DIR, { recursive: true, force: true })
  print({ removed: !back.present, location: entry.location })
}

const [command, flag, value] = process.argv.slice(2)
if (command === 'install') install()
else if (command === 'read') print(entry.read())
else if (command === 'check') check(flag === '--out' ? value : undefined)
else if (command === 'remove') remove()
else {
  console.error(
    'usage: node spikes/S-027-4/loginProbe.ts install | read | check --out <file> | remove'
  )
  process.exit(2)
}
