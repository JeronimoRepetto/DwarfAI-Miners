// `hello.ok.capabilities` (14 §1.3): every method, frame and snapshot section name this Host serves,
// as exact strings — methods bare, frames as `frame:<name>`, sections as `section:<name>` — built
// with the contracts' name helpers so both sides spell them alike. Methods come from the
// dispatcher's registry; frames and sections from the issues that publish them.
import { frameCapability, methodCapability, sectionCapability } from '@dwarfai/contracts'

export interface ServedNames {
  methods: Iterable<string>
  frames?: Iterable<string>
  sections?: Iterable<string>
}

/** The capability list, sorted and without duplicates. */
export function collectCapabilities(served: ServedNames): string[] {
  const names = new Set<string>()
  for (const method of served.methods) names.add(methodCapability(method))
  for (const frame of served.frames ?? []) names.add(frameCapability(frame))
  for (const section of served.sections ?? []) names.add(sectionCapability(section))
  return [...names].sort()
}
