import { describe, expect, it } from 'vitest'
import { reduceThirdPartyError } from './redact'

describe('reduceThirdPartyError (ADR-026 item 5)', () => {
  it('[ADR-026] a third-party error is reduced to its name and code, never its message', () => {
    const secretMessage = 'open C:\\Users\\alice\\secret-mine\\.env failed for Thorin'
    const enoent = Object.assign(new Error(secretMessage), { code: 'ENOENT' })
    expect(reduceThirdPartyError(enoent)).toEqual({ msg: 'Error', errCode: 'ENOENT' })

    const rpc = Object.assign(new TypeError(secretMessage), { code: -32600 })
    expect(reduceThirdPartyError(rpc)).toEqual({ msg: 'TypeError', errCode: '-32600' })

    expect(reduceThirdPartyError(new RangeError(secretMessage))).toEqual({ msg: 'RangeError' })

    for (const thrown of [secretMessage, 42, null, undefined]) {
      expect(reduceThirdPartyError(thrown), String(thrown)).toEqual({})
    }
    for (const reduced of [enoent, rpc].map(reduceThirdPartyError)) {
      expect(JSON.stringify(reduced)).not.toMatch(/alice|secret-mine|Thorin/)
    }
  })
})
