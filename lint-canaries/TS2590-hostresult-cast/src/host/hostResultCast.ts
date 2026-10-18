// TS2590 (macOS CI heap): casting into HostResult inside Promise.resolve must fail the lint.
type HostResult = Record<string, unknown>

export function fake<M extends string>(value: unknown): Promise<HostResult[M]> {
  return Promise.resolve(value as HostResult[M])
}
