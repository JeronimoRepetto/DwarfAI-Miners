import { describe } from 'vitest'
import { runSecretReaderContract } from '../../kernel/testing/secretReader.contract'
import { failClosedSecretReader } from './secretReader'

// Cut 1: the OS secret store is not wired (later: ISSUE-324), so nothing is configured (ADR-017).
describe('failClosedSecretReader', () => {
  runSecretReaderContract(() => ({ reader: failClosedSecretReader, configured: {} }))
})
