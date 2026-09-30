// macOS start-time and boot-id reader (ADR-014 item 1, ADR-015 items 1 and 4). Kept from the
// legacy `parseDarwinProcessStart` rule (candidate adapted, ISSUE-018), plus a C locale so `ps`
// prints English month names whatever the person's locale.
import type { OsProcessReader, QueryRunner } from './types'

const MONTHS: Readonly<Record<string, number>> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11
}

const LSTART =
  /^\s*[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/

/**
 * Epoch ms from `ps -o lstart=` ("Sat Aug 29 11:07:36 2026"). lstart is local wall-clock time with
 * one-second resolution, well inside the 2 000 ms tolerance; the local-time Date constructor
 * recovers the instant (the query inherits the Host's TZ).
 */
export function parseDarwinLstart(text: string): number | null {
  const match = LSTART.exec(text)
  if (match === null) return null
  const month = MONTHS[match[1] as string]
  if (month === undefined) return null
  const [, , day, hours, minutes, seconds, year] = match.map(Number) as number[]
  return new Date(
    year as number,
    month,
    day as number,
    hours as number,
    minutes as number,
    seconds as number
  ).getTime()
}

export function createDarwinReader(deps: { runQuery: QueryRunner }): OsProcessReader {
  return {
    async startTimeMs(pid) {
      const out = await deps.runQuery('ps', ['-p', String(pid), '-o', 'lstart='], { LC_ALL: 'C' })
      return out === null ? null : parseDarwinLstart(out)
    },
    async bootId() {
      const id = (await deps.runQuery('sysctl', ['-n', 'kern.bootsessionuuid']))?.trim() ?? ''
      return /^[0-9A-Fa-f-]{8,}$/.test(id) ? id : null
    }
  }
}
