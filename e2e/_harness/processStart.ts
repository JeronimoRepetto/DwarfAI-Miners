import { createQueryRunner } from '../../src/host/platform/process/NodeProcessControl.ts'
import { createDarwinReader } from '../../src/host/platform/process/probe/darwin.ts'
import { createLinuxReader } from '../../src/host/platform/process/probe/linux.ts'
import type { OsProcessReader } from '../../src/host/platform/process/probe/types.ts'
import { createWin32Reader } from '../../src/host/platform/process/probe/win32.ts'

/**
 * A process's creation time (epoch ms) as the e2e worlds write it down: into Claude Code's own session registry
 * (`sessions/<pid>.json` `procStart`) and into a legacy `launched_sessions` row. Read with the Host's own per-OS
 * start-time readers (ADR-014 item 1), so no case reaches into the legacy `src/main` tree (05 §5.1 R16). They run the
 * legacy probe's queries (PowerShell `StartTime.ToFileTime()`, `/proc/<pid>/stat` + btime, `ps -o lstart=`), so a
 * reading is the same instant to within each query's resolution, well inside the legacy runtime's 2 000 ms tolerance
 * (`PROCESS_START_TOLERANCE_MS`).
 *
 * `null` when the process could not be read (it ended, or the query failed).
 */
export async function processStartTimeMs(pid: number): Promise<number | null> {
  const outcome = await readerForThisOs().startTimeMs(pid)
  return outcome.ok ? outcome.value : null
}

function readerForThisOs(): OsProcessReader {
  const runQuery = createQueryRunner()
  if (process.platform === 'win32') return createWin32Reader({ runQuery })
  if (process.platform === 'darwin') return createDarwinReader({ runQuery })
  return createLinuxReader()
}
