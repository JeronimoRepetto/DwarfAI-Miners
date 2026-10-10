/**
 * Spike S-027-4, macOS: whether the person's switch in System Settings → General → Login Items & Extensions is on for
 * a per-user LaunchAgent, decided from captured command output so that it is testable on any OS. Pure: no I/O.
 *
 * Why BTM: on macOS 26 the switch is kept in the Background Task Management (BTM) database, not in the plist and not in
 * `launchctl print-disabled` (observed on the owner's Mac, `spike-results/S-027-4.md`). `sfltool dumpbtm` prints that
 * database; the record of the agent carries a `Disposition` whose words included `disallowed` with the row off. Apple
 * documents the command, not its output format, so the reader is strict:
 *
 * - "on" only when this account's records for the label all say `enabled` and `allowed` (and none `disallowed`);
 * - "off" only when they all say `disallowed` (and none `allowed`);
 * - "unknown" for everything else: BTM not read or refused, an unrecognised format, no record for this account,
 *   records that disagree (a stale one beside a new one), or a disposition that does not settle it.
 *
 * launchd (`launchctl print gui/<uid>/<label>`) is kept as evidence only. After the switch was turned off the service
 * was gone while the plist stayed, but an agent written in this session is not loaded either until the next login, so
 * its absence is not "off", and its presence does not prove the switch is still on.
 */

export type MacLoginSwitch = 'on' | 'off' | 'unknown'

export interface BtmRecord {
  /** The `Records for UID <uid>` section the record sits in. */
  readonly uid: number | null
  readonly name: string | null
  readonly type: string | null
  readonly identifier: string | null
  readonly url: string | null
  /** The bracketed words of `Disposition`, lower case. */
  readonly dispositionWords: readonly string[]
  /** `Disposition` as printed, for the record (the hex value is not interpreted). */
  readonly dispositionRaw: string | null
}

export interface BtmDump {
  /** Whether the text has the layout the reader knows: a `Records for UID` section holding `Disposition` lines. */
  readonly recognized: boolean
  readonly records: readonly BtmRecord[]
}

export type BtmSource =
  | { readonly kind: 'not-read'; readonly reason: string }
  | { readonly kind: 'text'; readonly text: string }

export type LaunchdState = 'loaded' | 'not-found' | 'unknown'

export interface MacSwitchInput {
  readonly label: string
  readonly uid: number
  readonly plistPresent: boolean
  readonly btm: BtmSource
  readonly launchd: LaunchdState
}

export interface MacSwitchDecision {
  readonly state: MacLoginSwitch
  /** Why: `btm-allowed`, `btm-disallowed`, or why it could not be settled. */
  readonly reason: string
  /** This account's records for the label (empty when none were read). */
  readonly btmRecords: readonly BtmRecord[]
  readonly launchd: LaunchdState
}

const SECTION = /^\s*Records for UID (-?\d+)\b/
const ITEM = /^\s*#\d+:\s*$/
const FIELD = /^\s*([A-Za-z][A-Za-z ]*?):\s?(.*)$/

interface Draft {
  uid: number | null
  fields: Map<string, string>
}

function toRecord(draft: Draft): BtmRecord {
  const disposition = draft.fields.get('Disposition') ?? null
  const words = /\[([^\]]*)\]/.exec(disposition ?? '')?.[1] ?? ''
  return {
    uid: draft.uid,
    name: draft.fields.get('Name') ?? null,
    type: draft.fields.get('Type') ?? null,
    identifier: draft.fields.get('Identifier') ?? null,
    url: draft.fields.get('URL') ?? null,
    dispositionWords: words
      .split(',')
      .map((word) => word.trim().toLowerCase())
      .filter((word) => word !== ''),
    dispositionRaw: disposition
  }
}

/** The records of an `sfltool dumpbtm` output, each with the UID section it sits in. */
export function parseBtmDump(text: string): BtmDump {
  const records: BtmRecord[] = []
  let uid: number | null = null
  let sawSection = false
  let draft: Draft | null = null
  const flush = (): void => {
    if (draft !== null && draft.fields.size > 0) records.push(toRecord(draft))
    draft = null
  }
  for (const line of text.split(/\r?\n/)) {
    const section = SECTION.exec(line)
    if (section) {
      flush()
      uid = Number(section[1])
      sawSection = true
      continue
    }
    if (ITEM.test(line)) {
      flush()
      draft = { uid, fields: new Map() }
      continue
    }
    if (draft === null) continue
    const field = FIELD.exec(line)
    if (field?.[1] !== undefined) draft.fields.set(field[1].trim(), (field[2] ?? '').trim())
  }
  flush()
  const recognized = sawSection && records.some((record) => record.dispositionRaw !== null)
  return { recognized, records }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isFor(record: BtmRecord, label: string): boolean {
  const identifier = new RegExp(`^(\\d+\\.)?${escapeRegExp(label)}$`)
  const url = new RegExp(`/LaunchAgents/${escapeRegExp(label)}\\.plist$`)
  return (
    (record.identifier !== null && identifier.test(record.identifier)) ||
    (record.url !== null && url.test(record.url))
  )
}

/** What one record says about the switch. */
function recordSwitch(record: BtmRecord): MacLoginSwitch {
  const words = new Set(record.dispositionWords)
  const allowed = words.has('allowed')
  const disallowed = words.has('disallowed')
  if (disallowed && !allowed) return 'off'
  if (allowed && !disallowed && words.has('enabled') && !words.has('disabled')) return 'on'
  return 'unknown'
}

/** `launchctl print gui/<uid>/<label>`: its exit code and its combined stdout and stderr. */
export function parseLaunchctlPrint(
  exitCode: number | null,
  output: string,
  label: string
): LaunchdState {
  if (/Could not find service/i.test(output)) return 'not-found'
  const header = new RegExp(`^\\S*/${escapeRegExp(label)} = \\{`, 'm')
  if (exitCode === 0 && header.test(output)) return 'loaded'
  return 'unknown'
}

/** The person's switch for `label`, from BTM; launchd is carried as evidence only (module comment). */
export function decideMacLoginSwitch(input: MacSwitchInput): MacSwitchDecision {
  const settle = (
    state: MacLoginSwitch,
    reason: string,
    btmRecords: readonly BtmRecord[] = []
  ): MacSwitchDecision => ({ state, reason, btmRecords, launchd: input.launchd })
  if (!input.plistPresent) return settle('unknown', 'no-plist')
  if (input.btm.kind === 'not-read') return settle('unknown', 'btm-not-read')
  const dump = parseBtmDump(input.btm.text)
  if (!dump.recognized) return settle('unknown', 'btm-format-unrecognized')
  const mine = dump.records.filter(
    (record) => record.uid === input.uid && isFor(record, input.label)
  )
  if (mine.length === 0) return settle('unknown', 'btm-no-record')
  const states = new Set(mine.map(recordSwitch))
  if (states.has('on') && states.has('off')) return settle('unknown', 'btm-records-disagree', mine)
  if (states.size !== 1 || states.has('unknown')) {
    return settle('unknown', 'btm-disposition-unclear', mine)
  }
  return states.has('on')
    ? settle('on', 'btm-allowed', mine)
    : settle('off', 'btm-disallowed', mine)
}
