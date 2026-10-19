// A real OS query runner for OS-lane tests (17 §1.8): one OS query as an argv array, never through a shell, killed
// at its timeout. The launcher's own runner is private to nodeHostLauncher.ts; this one answers in the same shape
// (processStart.ts `QueryRunner`) so the real start-time readers run on the real OS. Never imported by production
// code (R14); it lives under hostLauncher/ because that is the UI path allowed to start a process (R17).
import { execFile } from 'node:child_process'
import type { QueryRunner } from '../processStart'

export function osQueryRunner(): QueryRunner {
  return (file, args, { timeoutMs, env }) =>
    new Promise((resolve) => {
      execFile(
        file,
        [...args],
        {
          timeout: timeoutMs,
          windowsHide: true,
          shell: false,
          encoding: 'utf8',
          ...(env === undefined ? {} : { env: { ...process.env, ...env } })
        },
        (error, stdout) => {
          if (error === null) resolve({ ok: true, stdout })
          else if (error.killed === true)
            resolve({ ok: false, cause: `timed out after ${timeoutMs} ms` })
          else if (typeof error.code === 'number')
            resolve({
              ok: false,
              cause: `exited with code ${error.code}`,
              code: error.code,
              stdout
            })
          else resolve({ ok: false, cause: `could not start (${String(error.code)})` })
        }
      )
    })
}

/** This process's OS, as the launcher's readers name it. */
export function thisPlatform(): 'win32' | 'darwin' | 'linux' {
  return process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux'
}
