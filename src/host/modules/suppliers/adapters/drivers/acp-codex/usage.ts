// The Codex acp usage normalisation (ADR-006 item 4: raw vs net amounts are normalised per adapter).
// codex-acp 1.13.1 reports each turn's `session/prompt` usage with `inputTokens` already net of
// `cachedReadTokens` and `outputTokens` that include `thoughtTokens` (recorded,
// fixtures/codex/acp/0.153.4/: totalTokens = inputTokens + cachedReadTokens + outputTokens). The
// Codex app-server driver keeps the amounts disjoint (`output = output − reasoning`,
// ../codex-app-server/usage.ts), so this one does too. Pure: no I/O.
import { acpUsageTokens, type AcpUsage } from '../acp/client/AcpClient'

export function codexAcpUsage(usage: AcpUsage): ReturnType<typeof acpUsageTokens> {
  const reported = acpUsageTokens(usage)
  return { ...reported, output: Math.max(0, reported.output - reported.reasoning) }
}
