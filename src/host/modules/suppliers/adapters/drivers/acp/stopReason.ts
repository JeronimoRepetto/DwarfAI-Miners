// The ACP turn-end vocabulary (ADR-021 item 5; 15 §4.10 Turns): `session/prompt` resolves with a
// `stopReason` of the pinned schema (`StopReason`, five values), mapped onto `TurnEndKind`. An
// unknown word is `errored` with the raw word as its detail, never dropped silently (invariant
// §6a-11, ADR-029). Pure: no I/O. Every ACP driver reads it through the shared client.
import type { TurnEndKind } from '../../../../../kernel/domain/sharedContracts'

export function turnEndOf(stopReason: string): { kind: TurnEndKind; detail?: string } {
  switch (stopReason) {
    case 'end_turn':
      return { kind: 'concluded' }
    case 'max_tokens':
    case 'max_turn_requests':
      return { kind: 'capped', detail: stopReason }
    case 'cancelled':
      return { kind: 'interrupted' }
    case 'refusal':
      return { kind: 'errored', detail: stopReason }
    default:
      return {
        kind: 'errored',
        detail: stopReason === '' ? 'stopReason without a value' : stopReason
      }
  }
}
