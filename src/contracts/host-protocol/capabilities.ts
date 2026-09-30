// Capability names of hello.ok.capabilities (14 §1.3): every method, frame and snapshot section the Host serves,
// as exact strings. The UI feature-gates on these names (ADR-027 D4); protocolVersion is never a feature gate.
// Additive only inside a generation: a changed schema is a new name (`<name>.v2`), never a match on the old one.

export const methodCapability = <N extends string>(name: N): N => name

export const frameCapability = <N extends string>(name: N): `frame:${N}` => `frame:${name}`

export const sectionCapability = <N extends string>(name: N): `section:${N}` => `section:${name}`

/** True when `name` is listed exactly (no prefix, case or version matching). */
export const isAdvertised = (capabilities: readonly string[], name: string): boolean =>
  capabilities.includes(name)
