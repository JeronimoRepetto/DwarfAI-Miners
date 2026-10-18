// `reg.exe`, run with `shell: false` (R17), for the candidate login entry's Windows Run value
// (window/adapters/autostart/CandidateAutostart.ts; 21 §2 cut 1). It lives in the launcher's spawning path because R17
// (05 §5.1) allows `node:child_process` in UI main only here and in the console-terminal adapters; the composition
// root hands it to the window module. It goes with the candidate writer once S-027-4 passes on Windows (v1).
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Runs `reg` with these arguments; rejects when the command fails (a missing value included). */
export async function runRegExe(args: string[]): Promise<void> {
  await execFileAsync('reg', args, { shell: false, windowsHide: true })
}
