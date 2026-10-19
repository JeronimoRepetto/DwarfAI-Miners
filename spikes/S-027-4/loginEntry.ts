import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  decideMacLoginSwitch,
  parseLaunchctlPrint,
  type BtmSource,
  type MacSwitchDecision
} from './macLoginSwitch.ts'

/**
 * Spike S-027-4: the candidate per-user login entry of each OS (ADR-027 item 7; spike register S-027-4), written,
 * read back and removed under a caller-given throwaway name. Nothing here needs elevation, and nothing here touches
 * an entry whose name it did not build itself.
 *
 * - Windows: a `REG_SZ` value under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, through `reg.exe` (ships with
 *   Windows; `shell: false`). Whether the person disabled it in Settings → Apps → Startup (or Task Manager) is the
 *   `StartupApproved\Run` value of the same name: absent or an even first byte (02) means enabled, an odd one (03)
 *   disabled (UNVERIFIED beyond this spike; Microsoft does not document the format).
 * - macOS: a per-user LaunchAgent `~/Library/LaunchAgents/<label>.plist` (`RunAtLoad`, no `KeepAlive`), read back with
 *   `plutil`. The person's switch in System Settings → General → Login Items is read from the Background Task
 *   Management record (`sfltool dumpbtm`, decided in `macLoginSwitch.ts`), with `launchctl print gui/<uid>/<label>`
 *   kept as evidence: `launchctl print-disabled` does not hold that switch on macOS 26 (owner's Mac, 2026-10-03). BTM
 *   is read only when asked (`macBtm`), because the privileges `sfltool dumpbtm` needs on macOS 26 are not measured.
 * - Linux: an XDG autostart entry `$XDG_CONFIG_HOME/autostart/<name>.desktop` (default `~/.config`); disabled means
 *   `Hidden=true` or `X-GNOME-Autostart-enabled=false` (Desktop Application Autostart Specification).
 */

export interface EntryCommand {
  readonly executable: string
  readonly args: readonly string[]
}

export interface ReadBack {
  readonly present: boolean
  readonly command: EntryCommand | null
  /** Whether the person switched the entry off in the OS's own startup list; null when this OS cannot say. */
  readonly disabledByPerson: boolean | null
  /** The entry as stored. */
  readonly raw: string | null
  /** macOS only: how `disabledByPerson` was decided, and what each source answered. */
  readonly macSwitch?: MacSwitchReport
}

/** Where the macOS reader gets the BTM dump: nowhere, `sfltool dumpbtm` run without sudo, or a file. */
export type MacBtmMode = 'skip' | 'run' | { readonly file: string }

export interface MacSwitchReport extends MacSwitchDecision {
  /** What the BTM source answered (the command's exit, or the file read); never the dump itself (privacy). */
  readonly btmSource: string
}

export interface LoginEntryOptions {
  /** macOS: where the BTM dump comes from (default `skip`: the switch then reads as `null`). */
  readonly macBtm?: MacBtmMode
}

export interface LoginEntry {
  readonly kind: 'windows-run-value' | 'macos-launch-agent' | 'linux-xdg-autostart'
  /** Where the entry lives (a registry value or a file). */
  readonly location: string
  write(command: EntryCommand): void
  read(): ReadBack
  /** Switches the entry off the way the OS's own startup list does; false where the spike does not simulate it. */
  disableAsPerson(): boolean
  /** Removes the entry; a missing entry is already removed. */
  remove(): void
}

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const APPROVED_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run'
const LAUNCH_AGENTS = ['Library', 'LaunchAgents'] as const

export function loginEntryFor(
  platform: NodeJS.Platform,
  suffix: string,
  options: LoginEntryOptions = {}
): LoginEntry {
  if (platform === 'win32') return windowsRunValue(`DwarfAI-S0274-${suffix}`)
  if (platform === 'darwin') {
    return macLaunchAgent(`com.dwarfai.spike.s0274.${suffix}`, options.macBtm ?? 'skip')
  }
  return linuxAutostart(`dwarfai-spike-s0274-${suffix}`, process.env)
}

function tool(file: string, args: readonly string[]): string {
  return execFileSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    windowsHide: true
  })
}

function tryTool(file: string, args: readonly string[]): string | null {
  try {
    return tool(file, args)
  } catch {
    return null
  }
}

// ---- Windows ----

function regExe(): string {
  return path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'reg.exe')
}

/** The Run value: every part quoted, as Explorer re-parses the string. */
export function windowsCommandLine(command: EntryCommand): string {
  return [command.executable, ...command.args].map((part) => `"${part}"`).join(' ')
}

/** Splits a command line the way `CommandLineToArgvW` does (quotes and the backslash-before-quote rule). */
export function splitWindowsCommandLine(line: string): string[] {
  const parts: string[] = []
  let current = ''
  let quoted = false
  let started = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '\\') {
      let slashes = 0
      while (line[index + slashes] === '\\') slashes += 1
      if (line[index + slashes] === '"') {
        current += '\\'.repeat(Math.floor(slashes / 2))
        index += slashes - 1
        if (slashes % 2 === 1) {
          current += '"'
          index += 1
        }
      } else {
        current += '\\'.repeat(slashes)
        index += slashes - 1
      }
      started = true
    } else if (char === '"') {
      quoted = !quoted
      started = true
    } else if ((char === ' ' || char === '\t') && !quoted) {
      if (started) parts.push(current)
      current = ''
      started = false
    } else {
      current += char
      started = true
    }
  }
  if (started) parts.push(current)
  return parts
}

function regValue(key: string, name: string): { type: string; data: string } | null {
  const output = tryTool(regExe(), ['query', key, '/v', name])
  if (output === null) return null
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s+(.+?)\s{4}(REG_\w+)\s{4}(.*)$/.exec(line)
    if (match && match[1] === name) return { type: match[2] ?? '', data: match[3] ?? '' }
  }
  return null
}

function windowsRunValue(name: string): LoginEntry {
  return {
    kind: 'windows-run-value',
    location: `${RUN_KEY}\\${name}`,
    write(command) {
      tool(regExe(), [
        'add',
        RUN_KEY,
        '/v',
        name,
        '/t',
        'REG_SZ',
        '/d',
        windowsCommandLine(command),
        '/f'
      ])
    },
    read() {
      const value = regValue(RUN_KEY, name)
      if (value === null)
        return { present: false, command: null, disabledByPerson: null, raw: null }
      const [executable, ...args] = splitWindowsCommandLine(value.data)
      const approved = regValue(APPROVED_KEY, name)
      const firstByte = approved === null ? null : Number.parseInt(approved.data.slice(0, 2), 16)
      return {
        present: true,
        command: executable === undefined ? null : { executable, args },
        disabledByPerson: firstByte === null ? false : firstByte % 2 === 1,
        raw: value.data
      }
    },
    disableAsPerson() {
      tool(regExe(), [
        'add',
        APPROVED_KEY,
        '/v',
        name,
        '/t',
        'REG_BINARY',
        '/d',
        '030000000000000000000000',
        '/f'
      ])
      return true
    },
    remove() {
      tryTool(regExe(), ['delete', RUN_KEY, '/v', name, '/f'])
      tryTool(regExe(), ['delete', APPROVED_KEY, '/v', name, '/f'])
    }
  }
}

// ---- macOS ----

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function launchAgentPlist(label: string, command: EntryCommand): string {
  const argumentsXml = [command.executable, ...command.args]
    .map((part) => `\t\t<string>${escapeXml(part)}</string>`)
    .join('\n')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>Label</key>',
    `\t<string>${escapeXml(label)}</string>`,
    '\t<key>ProgramArguments</key>',
    '\t<array>',
    argumentsXml,
    '\t</array>',
    '\t<key>RunAtLoad</key>',
    '\t<true/>',
    '\t<key>KeepAlive</key>',
    '\t<false/>',
    '</dict>',
    '</plist>',
    ''
  ].join('\n')
}

/** A command's exit code (null when it did not exit) and its stdout and stderr; `shell: false`, no stdin. */
function runCaptured(
  file: string,
  args: readonly string[]
): { code: number | null; output: string } {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    shell: false
  })
  return {
    code: result.error === undefined ? result.status : null,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`
  }
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim() !== '') ?? '(no output)'
}

/** The BTM dump, by the mode asked, with a one-line note of what the source answered. */
function readBtm(mode: MacBtmMode): { source: BtmSource; note: string } {
  if (mode === 'skip') return { source: { kind: 'not-read', reason: 'skipped' }, note: 'skipped' }
  if (mode === 'run') {
    const { code, output } = runCaptured('/usr/bin/sfltool', ['dumpbtm'])
    const note = `sfltool dumpbtm, no sudo: exit ${String(code)}`
    return code === 0
      ? { source: { kind: 'text', text: output }, note }
      : {
          source: { kind: 'not-read', reason: 'sfltool failed' },
          note: `${note}: ${firstLine(output)}`
        }
  }
  if (!existsSync(mode.file)) {
    return { source: { kind: 'not-read', reason: 'no file' }, note: 'BTM file not found' }
  }
  return { source: { kind: 'text', text: readFileSync(mode.file, 'utf8') }, note: 'BTM file read' }
}

function macLaunchAgent(label: string, btmMode: MacBtmMode): LoginEntry {
  const file = path.join(homedir(), ...LAUNCH_AGENTS, `${label}.plist`)
  return {
    kind: 'macos-launch-agent',
    location: file,
    write(command) {
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, launchAgentPlist(label, command), 'utf8')
      tool('/usr/bin/plutil', ['-lint', file])
    },
    read() {
      if (!existsSync(file))
        return { present: false, command: null, disabledByPerson: null, raw: null }
      const json = JSON.parse(tool('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file])) as {
        ProgramArguments?: string[]
      }
      const [executable, ...args] = json.ProgramArguments ?? []
      const uid = process.getuid?.() ?? -1
      const printed = runCaptured('/bin/launchctl', ['print', `gui/${String(uid)}/${label}`])
      const btm = readBtm(btmMode)
      const decision = decideMacLoginSwitch({
        label,
        uid,
        plistPresent: true,
        btm: btm.source,
        launchd: parseLaunchctlPrint(printed.code, printed.output, label)
      })
      return {
        present: true,
        command: executable === undefined ? null : { executable, args },
        // Only an "off" BTM says the person switched it off; anything unsettled is null, never a guess.
        disabledByPerson: decision.state === 'off' ? true : decision.state === 'on' ? false : null,
        raw: readFileSync(file, 'utf8'),
        macSwitch: { ...decision, btmSource: btm.note }
      }
    },
    // Not simulated: `launchctl disable` leaves an override for the label in launchd's own database after the
    // entry is gone. The person's switch in Login Items is the manual half.
    disableAsPerson: () => false,
    remove() {
      rmSync(file, { force: true })
    }
  }
}

// ---- Linux ----

const RESERVED = /[\s"'\\><~|&;$*?#()`]/

/** One Exec argument, quoted per the Desktop Entry Specification, then escaped as a string value. */
function execArgument(part: string): string {
  const percent = part.replaceAll('%', '%%')
  const quoted = RESERVED.test(percent)
    ? `"${percent.replace(/["`$\\]/g, (char) => `\\${char}`)}"`
    : percent
  return quoted.replaceAll('\\', '\\\\')
}

export function desktopEntry(command: EntryCommand): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=DwarfAI spike S-027-4',
    `Exec=${[command.executable, ...command.args].map(execArgument).join(' ')}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    ''
  ].join('\n')
}

/** The Exec value back to its arguments: string unescaping first, then the quoting rule, then `%%`. */
export function parseExec(value: string): string[] {
  const unescaped = value.replace(/\\([\\snrt])/g, (_all, char: string) =>
    char === 's' ? ' ' : char === 'n' ? '\n' : char === 'r' ? '\r' : char === 't' ? '\t' : '\\'
  )
  const parts: string[] = []
  let current = ''
  let quoted = false
  let started = false
  for (let index = 0; index < unescaped.length; index += 1) {
    const char = unescaped[index] ?? ''
    if (quoted && char === '\\' && index + 1 < unescaped.length) {
      current += unescaped[index + 1]
      index += 1
    } else if (char === '"') {
      quoted = !quoted
      started = true
    } else if (char === ' ' && !quoted) {
      if (started) parts.push(current)
      current = ''
      started = false
    } else {
      current += char
      started = true
    }
  }
  if (started) parts.push(current)
  return parts.map((part) => part.replaceAll('%%', '%'))
}

function desktopKeys(text: string): Map<string, string> {
  const keys = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9-]+)=(.*)$/.exec(line)
    if (match?.[1] !== undefined) keys.set(match[1], match[2] ?? '')
  }
  return keys
}

function linuxAutostart(name: string, env: NodeJS.ProcessEnv): LoginEntry {
  const configured = env['XDG_CONFIG_HOME']
  const configHome =
    configured !== undefined && configured.startsWith('/')
      ? configured
      : path.join(homedir(), '.config')
  const file = path.join(configHome, 'autostart', `${name}.desktop`)
  return {
    kind: 'linux-xdg-autostart',
    location: file,
    write(command) {
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, desktopEntry(command), 'utf8')
    },
    read() {
      if (!existsSync(file))
        return { present: false, command: null, disabledByPerson: null, raw: null }
      const raw = readFileSync(file, 'utf8')
      const keys = desktopKeys(raw)
      const [executable, ...args] = parseExec(keys.get('Exec') ?? '')
      return {
        present: true,
        command: executable === undefined ? null : { executable, args },
        disabledByPerson:
          keys.get('Hidden') === 'true' || keys.get('X-GNOME-Autostart-enabled') === 'false',
        raw
      }
    },
    disableAsPerson() {
      writeFileSync(file, `${readFileSync(file, 'utf8')}Hidden=true\n`, 'utf8')
      return true
    },
    remove() {
      rmSync(file, { force: true })
    }
  }
}
