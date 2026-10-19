import { describe, expect, it } from 'vitest'
import {
  BTM_ALLOWED_NOT_ENABLED,
  BTM_BOTH_WORDS,
  BTM_FORMAT_CHANGED,
  BTM_MATCH_BY_URL,
  BTM_NO_ALLOWANCE,
  BTM_NO_RECORD,
  BTM_OFF,
  BTM_ON,
  BTM_ON_CRLF,
  BTM_ONLY_OTHER_USER,
  BTM_REFUSED,
  BTM_STALE_AND_NEW,
  LABEL,
  LAUNCHCTL_LOADED,
  LAUNCHCTL_NOT_FOUND,
  UID
} from './btmFixtures.ts'
import {
  decideMacLoginSwitch,
  parseLaunchctlPrint,
  type BtmSource,
  type LaunchdState,
  type MacSwitchInput
} from './macLoginSwitch.ts'

/**
 * Spike S-027-4, macOS reader of the person's Login Items switch (ADR-027 item 7; `spike-results/S-027-4.md`, "Owner
 * steps still needed" item 2). Pure parsing of captured output, so it runs on every OS lane; the outputs are synthetic
 * (`btmFixtures.ts`). The load-bearing rule: the reader answers "on" only when the BTM record of this account says
 * `enabled` and `allowed`; anything it cannot settle is "unknown", never "on".
 */

function input(
  btm: BtmSource,
  launchd: LaunchdState = 'unknown',
  plistPresent = true
): MacSwitchInput {
  return { label: LABEL, uid: UID, plistPresent, btm, launchd }
}

const text = (value: string): BtmSource => ({ kind: 'text', text: value })

describe('S-027-4: the macOS Login Items switch, read from BTM (ADR-027 item 7)', () => {
  it('[S-027-4, ADR-027] the row on in Login Items reads as on, from this account’s record only', () => {
    const decision = decideMacLoginSwitch(input(text(BTM_ON), 'loaded'))
    expect(decision.state).toBe('on')
    expect(decision.btmRecords.map((record) => [record.uid, record.identifier])).toEqual([
      [UID, `8.${LABEL}`]
    ])
  })

  it('[S-027-4, ADR-027] the row off in Login Items reads as off, whatever launchd says', () => {
    for (const launchd of ['loaded', 'not-found', 'unknown'] as const) {
      const decision = decideMacLoginSwitch(input(text(BTM_OFF), launchd))
      expect(decision.state, launchd).toBe('off')
      expect(decision.btmRecords[0]?.dispositionRaw).toBe('[enabled, disallowed, notified] (0x9)')
    }
  })

  it('[S-027-4] a dump copied with CRLF line ends reads the same', () => {
    const decision = decideMacLoginSwitch(input(text(BTM_ON_CRLF)))
    expect(decision.state).toBe('on')
    expect(decision.btmRecords.map((record) => record.dispositionRaw)).toEqual([
      '[enabled, allowed, notified] (0xb)'
    ])
  })

  it('[S-027-4] the record is also found by the plist URL when the identifier has another shape', () => {
    const decision = decideMacLoginSwitch(input(text(BTM_MATCH_BY_URL)))
    expect(decision.state).toBe('on')
    expect(decision.btmRecords).toHaveLength(1)
  })

  it.each([
    ['BTM was not read', { kind: 'not-read', reason: 'skipped' } as BtmSource, 'btm-not-read'],
    ['the output has an unknown format', text(BTM_FORMAT_CHANGED), 'btm-format-unrecognized'],
    ['the command was refused', text(BTM_REFUSED), 'btm-format-unrecognized'],
    ['this account has no record for the label', text(BTM_NO_RECORD), 'btm-no-record'],
    ['only another account has the label', text(BTM_ONLY_OTHER_USER), 'btm-no-record'],
    ['a stale record disagrees with a new one', text(BTM_STALE_AND_NEW), 'btm-records-disagree'],
    [
      'the disposition names neither allowed nor disallowed',
      text(BTM_NO_ALLOWANCE),
      'btm-disposition-unclear'
    ],
    ['the disposition names both', text(BTM_BOTH_WORDS), 'btm-disposition-unclear'],
    [
      'the record is allowed but not enabled',
      text(BTM_ALLOWED_NOT_ENABLED),
      'btm-disposition-unclear'
    ]
  ])(
    '[S-027-4, ADR-027] never a false "on": %s reads as unknown, even with the service loaded',
    (_case, btm, reason) => {
      const decision = decideMacLoginSwitch(input(btm, 'loaded'))
      expect(decision.state).toBe('unknown')
      expect(decision.reason).toBe(reason)
    }
  )

  it('[S-027-4] launchd alone settles nothing: absent with the plist present reads as unknown', () => {
    const decision = decideMacLoginSwitch(
      input({ kind: 'not-read', reason: 'skipped' }, 'not-found')
    )
    expect(decision.state).toBe('unknown')
    expect(decision.launchd).toBe('not-found')
  })

  it('[S-027-4] no plist means no entry to switch: unknown, BTM not consulted', () => {
    const decision = decideMacLoginSwitch(input(text(BTM_ON), 'loaded', false))
    expect(decision.state).toBe('unknown')
    expect(decision.reason).toBe('no-plist')
  })
})

describe('S-027-4: launchctl print gui/<uid>/<label>, parsed', () => {
  it('[S-027-4] exit 0 naming the service reads as loaded', () => {
    expect(parseLaunchctlPrint(0, LAUNCHCTL_LOADED, LABEL)).toBe('loaded')
  })

  it('[S-027-4] "Could not find service" reads as not found, whatever the exit code', () => {
    expect(parseLaunchctlPrint(113, LAUNCHCTL_NOT_FOUND, LABEL)).toBe('not-found')
    expect(parseLaunchctlPrint(1, LAUNCHCTL_NOT_FOUND, LABEL)).toBe('not-found')
  })

  it('[S-027-4] anything else reads as unknown', () => {
    expect(parseLaunchctlPrint(null, '', LABEL)).toBe('unknown')
    expect(parseLaunchctlPrint(0, 'gui/501/com.example.other = {\n}\n', LABEL)).toBe('unknown')
    expect(parseLaunchctlPrint(5, 'Operation not permitted\n', LABEL)).toBe('unknown')
  })
})
