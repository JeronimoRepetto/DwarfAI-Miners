// A test probe that "measures exactly the ceiling" (AMENDMENT-18, owner, 2026-10-16): a ceiling's
// unordered enums are sets, so the row a probe reports takes each set's first value, its preferred
// driver's; booleans and ordered enums are the ceiling's own.
import type { AllowedValues, CapabilityCeiling, ProviderCapabilities } from '../domain/capabilities'

const first = <T>(allowed: AllowedValues<T>): T => allowed[0]

export function preferredRow(ceiling: CapabilityCeiling): ProviderCapabilities {
  return {
    ...ceiling,
    usage: { ...ceiling.usage },
    resume: first(ceiling.resume),
    mcpInjection: first(ceiling.mcpInjection),
    console: first(ceiling.console),
    earlyFailure: first(ceiling.earlyFailure),
    installDetection: first(ceiling.installDetection)
  }
}
