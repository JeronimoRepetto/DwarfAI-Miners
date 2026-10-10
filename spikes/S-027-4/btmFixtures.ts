/**
 * SYNTHETIC `sfltool dumpbtm` and `launchctl print` outputs for the macOS login-switch reader of spike S-027-4. None
 * of them was captured on a machine: they are modelled on the field layout of the record the owner's Mac printed on
 * macOS 26.6.2 (`spike-results/S-027-4.md`: `Type: legacy agent`, `Disposition: [enabled, disallowed, notified]
 * (0x9)`, `Identifier: 8.<label>`, `Parent Identifier: Unknown Developer`), on the `Records for UID <uid>` sections of
 * the same command, and on launchd's `Could not find service` message. Apple documents that `sfltool dumpbtm` prints
 * the status of login and background items, not its format, so every layout detail here is UNVERIFIED until the Mac
 * run of the guide records the real output. Account name `j` and every UUID are placeholders (privacy guard).
 */

export const LABEL = 'com.dwarfai.spike.s0274.login-probe'
export const UID = 501

function record(
  index: number,
  fields: { name: string; identifier: string; url: string; disposition: string; type?: string }
): string[] {
  return [
    ` #${String(index)}:`,
    '                 UUID: 00000000-0000-4000-8000-00000000000' + String(index),
    `                 Name: ${fields.name}`,
    '       Developer Name: (null)',
    '      Team Identifier: (null)',
    `                 Type: ${fields.type ?? 'legacy agent (0x10008)'}`,
    '                Flags: [  ] (0)',
    `          Disposition: ${fields.disposition}`,
    `           Identifier: ${fields.identifier}`,
    `                  URL: ${fields.url}`,
    '      Executable Path: /Users/j/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
    '           Generation: 1',
    '    Parent Identifier: Unknown Developer',
    ''
  ]
}

function section(uid: number, records: string[][]): string[] {
  return [
    '========================',
    ` Records for UID ${String(uid)} : 00000000-0000-4000-8000-0000000000${String(uid).slice(-2)}`,
    '========================',
    '',
    ' ServiceManagement migrated: true',
    ' SharedFileList migrated: true',
    '',
    ' Items:',
    '',
    ...records.flat()
  ]
}

const OTHER_APP = record(1, {
  name: 'Other App',
  identifier: '16.com.example.other.helper',
  url: 'file:///Applications/Other.app/',
  disposition: '[enabled, allowed, visible, notified] (0xb)',
  type: 'app (0x2)'
})

function probe(index: number, disposition: string): string[] {
  return record(index, {
    name: 'Electron',
    identifier: `8.${LABEL}`,
    url: `file:///Users/j/Library/LaunchAgents/${LABEL}.plist`,
    disposition
  })
}

/** Another account on the same Mac holds an entry with the same label, switched off: it must never count. */
const OTHER_USER = section(502, [
  record(1, {
    name: 'Electron',
    identifier: `8.${LABEL}`,
    url: `file:///Users/k/Library/LaunchAgents/${LABEL}.plist`,
    disposition: '[enabled, disallowed, notified] (0x9)'
  })
])

function dump(records: string[][]): string {
  return [...section(UID, [OTHER_APP, ...records]), ...OTHER_USER, ''].join('\n')
}

/** The row is on in Login Items. */
export const BTM_ON = dump([probe(2, '[enabled, allowed, notified] (0xb)')])

/** The row is off in Login Items (the disposition the owner's Mac printed). */
export const BTM_OFF = dump([probe(2, '[enabled, disallowed, notified] (0x9)')])

/** The same as `BTM_ON` with Windows line ends (a copied file). */
export const BTM_ON_CRLF = BTM_ON.replaceAll('\n', '\r\n')

/** A stale record from an earlier install, switched off, beside a new one that is on. */
export const BTM_STALE_AND_NEW = dump([
  probe(2, '[enabled, disallowed, notified] (0x9)'),
  probe(3, '[enabled, allowed, notified] (0xb)')
])

/** A disposition that names neither `allowed` nor `disallowed`. */
export const BTM_NO_ALLOWANCE = dump([probe(2, '[enabled, notified] (0x9)')])

/** A disposition that names both, which no reading can settle. */
export const BTM_BOTH_WORDS = dump([probe(2, '[enabled, allowed, disallowed] (0xb)')])

/** Allowed but not enabled: the entry itself is not active, whatever the switch says. */
export const BTM_ALLOWED_NOT_ENABLED = dump([probe(2, '[disabled, allowed, notified] (0xa)')])

/** Only the URL names the plist; the identifier has some other shape. */
export const BTM_MATCH_BY_URL = dump([
  record(2, {
    name: 'Electron',
    identifier: 'com.apple.unknown-shape',
    url: `file:///Users/j/Library/LaunchAgents/${LABEL}.plist`,
    disposition: '[enabled, allowed, notified] (0xb)'
  })
])

/** The person's section has no record for the label (for example before BTM noticed the plist). */
export const BTM_NO_RECORD = dump([])

/** Only the other account holds the label. */
export const BTM_ONLY_OTHER_USER = [...section(UID, [OTHER_APP]), ...OTHER_USER, ''].join('\n')

/** A later macOS that renamed the fields: nothing the reader knows is there. */
export const BTM_FORMAT_CHANGED = [
  'Background items for user 501',
  `- ${LABEL}: state=off source=user`,
  ''
].join('\n')

/** What a refusal could look like (exact wording UNVERIFIED): no records at all. */
export const BTM_REFUSED = 'sfltool: this command requires administrator privileges\n'

/** `launchctl print gui/501/<label>` for a loaded service (abridged). */
export const LAUNCHCTL_LOADED = [
  `gui/501/${LABEL} = {`,
  '\tactive count = 0',
  `\tpath = /Users/j/Library/LaunchAgents/${LABEL}.plist`,
  '\tstate = not running',
  '}',
  ''
].join('\n')

/** `launchctl print gui/501/<label>` when launchd holds no such service (the owner's Mac, after the switch off). */
export const LAUNCHCTL_NOT_FOUND = [
  `Bad request.`,
  `Could not find service "${LABEL}" in domain for user gui: 501`,
  ''
].join('\n')
