import { execFile } from 'node:child_process'
import type { Platform } from '../platform/platform'
import type { TextDeliveryOutcome } from './port'
import {
  buildRelayArgs,
  buildRelayEnv,
  buildRelayInstruction,
  resolveClaudeBinaryPath
} from './relay'

/**
 * Running the `claude -p` relay turn. Shared by every platform's
 * TextDeliveryPort: the relay is the one delivery tier that is not
 * platform-specific — it spawns a CLI rather than talking to a window server —
 * so only the binary path and the PATH separator differ (see relay.ts), and
 * the verdict mapping below is identical everywhere.
 */

export interface RelayInvocation {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd: string
  timeoutMs: number
}

export interface RelayResult {
  exitCode: number
  timedOut: boolean
}

export type RelayRunner = (invocation: RelayInvocation) => Promise<RelayResult>

export function runRelayProcess(invocation: RelayInvocation): Promise<RelayResult> {
  return new Promise((resolve, reject) => {
    execFile(
      invocation.command,
      invocation.args,
      {
        cwd: invocation.cwd,
        env: invocation.env,
        timeout: invocation.timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      },
      (error) => {
        if (error === null) {
          resolve({ exitCode: 0, timedOut: false })
          return
        }
        // execFile reports a timeout kill through `killed`, with no exit code.
        if (error.killed === true) {
          resolve({ exitCode: 1, timedOut: true })
          return
        }
        if (typeof error.code === 'number') {
          resolve({ exitCode: error.code, timedOut: false })
          return
        }
        reject(error) // the binary could not be started at all
      }
    )
  })
}

export interface RelayDeliveryOptions {
  sessionName: string
  text: string
  home: string
  env: NodeJS.ProcessEnv
  platform: Platform
  model: string
  timeoutMs: number
  run: RelayRunner
}

/**
 * Hand one message to a named Claude session through a throwaway relay turn.
 * Every failure mode becomes a `delivered: false` outcome with a reason the
 * panel can show, and the outcome never echoes the message back.
 */
export async function deliverViaRelay(options: RelayDeliveryOptions): Promise<TextDeliveryOutcome> {
  const command = resolveClaudeBinaryPath(options.home, options.platform)
  try {
    const result = await options.run({
      command,
      args: buildRelayArgs({
        model: options.model,
        instruction: buildRelayInstruction(options.sessionName, options.text)
      }),
      env: buildRelayEnv(options.env, command, options.platform),
      cwd: options.home,
      timeoutMs: options.timeoutMs
    })
    if (result.timedOut) {
      return {
        delivered: false,
        error: `The relay timed out after ${Math.round(options.timeoutMs / 1_000)}s.`
      }
    }
    if (result.exitCode !== 0) {
      return {
        delivered: false,
        error: `The relay could not deliver the message (exit ${result.exitCode}).`
      }
    }
    return { delivered: true }
  } catch {
    // The one failure that PROVES nothing was handed over: the binary never
    // ran, so no SendMessage call can have happened. Both branches above are
    // deliberately not marked — a non-zero exit and a timeout kill can each
    // land after the tool call succeeded — and that is what decides whether
    // the console tier behind this may retry the same text (#308).
    return { delivered: false, error: 'The relay could not be started.', neverStarted: true }
  }
}
