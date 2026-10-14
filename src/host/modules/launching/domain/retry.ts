// Retry of a failed launch (ADR-020 item 8; 06 INV-54; 07 S5.08a). Pure (05 §2.2, R1).
import type { HostEpoch, LaunchId, Result } from '../../../kernel/domain/values'
import { requestLaunch, type Launch, type LaunchStep } from './launch'

export interface RetryInput {
  id: LaunchId // the new attempt's id
  hostEpoch: HostEpoch // the boot running the new attempt
}

/**
 * Retry never moves the failed launch: it is a new `Launch` with the identical request (never a
 * cleared field) and `retryOf`, entering at S5.10 (Jev on) or S5.11 (Jev off). Only a failed launch
 * whose cause allows Retry can be retried; nothing retries on its own (INV-54).
 */
export function retryLaunch<P, D>(
  failed: Launch<P, D>,
  input: RetryInput
): Result<LaunchStep<P, D>, 'not-retryable'> {
  if (failed.state !== 'failed' || !failed.failure?.actions.includes('retry')) {
    return { ok: false, error: 'not-retryable' }
  }
  const step = requestLaunch({ ...input, request: failed.request, retryOf: failed.id })
  // the request was sendable when it was first sent and is immutable since (INV-50)
  return step.ok ? step : { ok: false, error: 'not-retryable' }
}
