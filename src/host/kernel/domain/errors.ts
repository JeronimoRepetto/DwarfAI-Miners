// Programming errors only (16 §2.1); never an expected outcome. Expected outcomes are values.
export class HostInvariantError extends Error {}

/**
 * An infrastructure failure of the Host database (16 §2.1 case c): the statement failed with a
 * `SQLITE_*` result, and the current command aborts (its transaction rolls back). `code` is the
 * primary result name (`SQLITE_BUSY`, `SQLITE_FULL`, …); `errcode` is the extended numeric code.
 * The message never carries statement parameters.
 */
export class SqliteInfrastructureError extends Error {
  readonly code: `SQLITE_${string}`
  readonly errcode: number

  constructor(
    code: `SQLITE_${string}`,
    errcode: number,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = 'SqliteInfrastructureError'
    this.code = code
    this.errcode = errcode
  }
}
