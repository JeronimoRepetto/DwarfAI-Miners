// The DelegationTokenStore conformance suite (16 §4.8; 06 §11.1 `DelegationToken`; ADR-013
// item 3; 17 §1.3): run on the in-memory double and on the SQLite adapter over the template
// database (schema v1). One row per launch (`launch_id` PK); only the SHA-256 of the credential is
// stored, and only for `ticket-file` and `protocol` (09 §4.6 CHECK as amended by owner amendment N
// (AMENDMENT-14, OQ-85), 2026-10-15); `byLaunch` finds a token until it is revoked, and a revoked
// row is kept with its first `revoked_at`; the parent is bound once after the dwarf arrives;
// `live` lists the unrevoked rows; the store joins the caller's transaction, so a rollback undoes
// its write. Never imported by production code (R14).
//
// The credentials are drawn at run time, so no credential value is written into the repository.
import { createHash, randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { DwarfId, Instant, LaunchId } from '../../../kernel/domain/values'
import type { DelegationToken, DelegationTokenStore } from '../ports/delegationStores'

/** The launches and parent dwarfs every subject provides (the SQLite subject seeds their rows). */
export const TOKEN_LAUNCH = '00000000-0000-7000-8000-0000000d1a01' as LaunchId
export const TOKEN_SPARE_LAUNCH = '00000000-0000-7000-8000-0000000d1a02' as LaunchId
export const TOKEN_PARENT = '00000000-0000-7000-8000-0000000d1d01' as DwarfId
export const TOKEN_OTHER_PARENT = '00000000-0000-7000-8000-0000000d1d02' as DwarfId

export interface DelegationTokenStoreSubject {
  store: DelegationTokenStore
  /** The caller's transaction: commits when `work` returns, rolls back when it throws. */
  inTransaction<T>(work: () => T): T
  /** Every stored row, revoked ones included, by launch id. */
  rows(): DelegationToken[]
  /** Every value the subject stores, serialized, to prove what never reaches it. */
  storedText(): string
  dispose(): void | Promise<void>
}

class CallerFailure extends Error {}

const T0: Instant = 1_750_000_000_000
const T1: Instant = T0 + 60_000
const T2: Instant = T0 + 120_000

/** A fresh credential as the issuer mints it: 32 random bytes as lower-case hex (ADR-013 item 3). */
function drawCredential(): string {
  return randomBytes(32).toString('hex')
}

/** The stored form of a credential: the SHA-256 of its hex text, as lower-case hex. */
function hashOf(credential: string): string {
  return createHash('sha256').update(credential, 'utf8').digest('hex')
}

function ticketFile(credentialHash: string, launchId = TOKEN_LAUNCH): DelegationToken {
  return {
    launchId,
    parentDwarfId: TOKEN_PARENT,
    mechanism: 'ticket-file',
    credentialHash,
    issuedAt: T0
  }
}

export function runDelegationTokenStoreContract(
  makeSubject: () => DelegationTokenStoreSubject | Promise<DelegationTokenStoreSubject>
): void {
  describe('DelegationTokenStore contract', () => {
    let subject: DelegationTokenStoreSubject | null = null

    afterEach(async () => {
      await subject?.dispose()
      subject = null
    })

    const setUp = async (): Promise<DelegationTokenStoreSubject> => {
      subject = await makeSubject()
      return subject
    }

    const issue = (s: DelegationTokenStoreSubject, token: DelegationToken): void =>
      s.inTransaction(() => s.store.issue(token))

    it('[INV-83] a token row stores only the SHA-256 of the credential and byLaunch finds it until revoked', async () => {
      const s = await setUp()
      const credential = drawCredential()
      const token = ticketFile(hashOf(credential))

      expect(s.store.byLaunch(TOKEN_LAUNCH)).toBeNull()
      issue(s, token)

      expect(s.store.byLaunch(TOKEN_LAUNCH)).toStrictEqual(token)
      expect(s.store.byLaunch(TOKEN_SPARE_LAUNCH)).toBeNull()
      const stored = s.storedText()
      expect(stored).toContain(token.credentialHash)
      expect(stored.toLowerCase()).not.toContain(credential.toLowerCase())

      s.inTransaction(() => s.store.revoke(TOKEN_LAUNCH, T1))

      expect(s.store.byLaunch(TOKEN_LAUNCH)).toBeNull()
      expect(s.rows()).toStrictEqual([{ ...token, revokedAt: T1 }])
    })

    it('[ADR-013] a second token for the same launch is rejected (one row per launch)', async () => {
      const s = await setUp()
      const first = ticketFile(hashOf(drawCredential()))
      issue(s, first)

      expect(() => issue(s, ticketFile(hashOf(drawCredential())))).toThrow()
      expect(() =>
        issue(s, {
          launchId: TOKEN_LAUNCH,
          parentDwarfId: TOKEN_PARENT,
          mechanism: 'protocol',
          issuedAt: T1
        })
      ).toThrow()
      // A revoked row still holds its launch: a launch is issued once.
      s.inTransaction(() => s.store.revoke(TOKEN_LAUNCH, T1))
      expect(() => issue(s, ticketFile(hashOf(drawCredential())))).toThrow()

      expect(s.rows()).toStrictEqual([{ ...first, revokedAt: T1 }])
    })

    // Owner amendment N (AMENDMENT-14, OQ-85), 2026-10-15 (A14-05, migration 0002): every relay
    // entry (`ticket-file`, `protocol`) authenticates with the credential file, so both keep its
    // hash; `in-process` never has one.
    it('[ADR-013] each mechanism stores with the hash on ticket-file and protocol only; a relay entry without a 64-character hash, or a hash on in-process, is rejected', async () => {
      const s = await setUp()
      const inProcess: DelegationToken = {
        launchId: TOKEN_LAUNCH,
        parentDwarfId: TOKEN_PARENT,
        mechanism: 'in-process',
        issuedAt: T0
      }
      const hash = hashOf(drawCredential())
      const protocol: DelegationToken = {
        launchId: TOKEN_SPARE_LAUNCH,
        parentDwarfId: TOKEN_OTHER_PARENT,
        mechanism: 'protocol',
        credentialHash: hash,
        issuedAt: T1
      }

      expect(() =>
        issue(s, {
          launchId: TOKEN_LAUNCH,
          parentDwarfId: TOKEN_PARENT,
          mechanism: 'ticket-file',
          issuedAt: T0
        })
      ).toThrow()
      expect(() =>
        issue(s, {
          launchId: TOKEN_LAUNCH,
          parentDwarfId: TOKEN_PARENT,
          mechanism: 'protocol',
          issuedAt: T0
        })
      ).toThrow()
      expect(() => issue(s, ticketFile(hash.slice(0, 63)))).toThrow()
      expect(() => issue(s, { ...protocol, credentialHash: hash.slice(0, 63) })).toThrow()
      expect(() => issue(s, { ...inProcess, credentialHash: hash })).toThrow()
      expect(s.rows()).toStrictEqual([])

      issue(s, inProcess)
      issue(s, protocol)

      expect(s.store.byLaunch(TOKEN_LAUNCH)).toStrictEqual(inProcess)
      expect(s.store.byLaunch(TOKEN_SPARE_LAUNCH)).toStrictEqual(protocol)
    })

    // A14-06: the row is written before the driver starts, and the launch's dwarf exists only
    // after the handshake, so the parent is NULL until `bindParent` sets it, once.
    it('[ADR-013] a token issued before its dwarf arrives has no parent until bindParent sets it once; the same pair again changes nothing and another dwarf is refused', async () => {
      const s = await setUp()
      const unbound: DelegationToken = {
        ...ticketFile(hashOf(drawCredential())),
        parentDwarfId: null
      }
      issue(s, unbound)

      expect(s.store.byLaunch(TOKEN_LAUNCH)).toStrictEqual(unbound)
      s.inTransaction(() => s.store.bindParent(TOKEN_LAUNCH, TOKEN_PARENT))
      s.inTransaction(() => s.store.bindParent(TOKEN_LAUNCH, TOKEN_PARENT))
      s.inTransaction(() => s.store.bindParent(TOKEN_SPARE_LAUNCH, TOKEN_PARENT))

      const bound = { ...unbound, parentDwarfId: TOKEN_PARENT }
      expect(s.store.byLaunch(TOKEN_LAUNCH)).toStrictEqual(bound)
      expect(() =>
        s.inTransaction(() => s.store.bindParent(TOKEN_LAUNCH, TOKEN_OTHER_PARENT))
      ).toThrow()
      expect(s.rows()).toStrictEqual([bound])
    })

    it('[ADR-013] live lists every unrevoked token by launch id, bound or not, and never a revoked one', async () => {
      const s = await setUp()
      const first = ticketFile(hashOf(drawCredential()))
      const second: DelegationToken = {
        ...ticketFile(hashOf(drawCredential()), TOKEN_SPARE_LAUNCH),
        parentDwarfId: null
      }

      expect(s.store.live()).toStrictEqual([])
      issue(s, second)
      issue(s, first)
      expect(s.store.live()).toStrictEqual([first, second])

      s.inTransaction(() => s.store.revoke(TOKEN_LAUNCH, T1))
      expect(s.store.live()).toStrictEqual([second])
    })

    it('[ADR-013] revoke stamps a token once; a second revoke and a revoke of an unknown launch change nothing', async () => {
      const s = await setUp()
      const token = ticketFile(hashOf(drawCredential()))
      const other = ticketFile(hashOf(drawCredential()), TOKEN_SPARE_LAUNCH)
      issue(s, token)
      issue(s, other)

      s.inTransaction(() => s.store.revoke(TOKEN_LAUNCH, T1))
      s.inTransaction(() => s.store.revoke(TOKEN_LAUNCH, T2))
      s.inTransaction(() => s.store.revoke('00000000-0000-7000-8000-0000000d1aff' as LaunchId, T2))

      expect(s.store.byLaunch(TOKEN_LAUNCH)).toBeNull()
      expect(s.store.byLaunch(TOKEN_SPARE_LAUNCH)).toStrictEqual(other)
      expect(s.rows()).toStrictEqual([{ ...token, revokedAt: T1 }, other])
    })

    it('[ADR-013] a rolled-back caller transaction leaves no token and no revocation', async () => {
      const s = await setUp()
      const kept = ticketFile(hashOf(drawCredential()))
      issue(s, kept)

      expect(() =>
        s.inTransaction(() => {
          s.store.revoke(TOKEN_LAUNCH, T1)
          s.store.issue(ticketFile(hashOf(drawCredential()), TOKEN_SPARE_LAUNCH))
          throw new CallerFailure('the caller failed after the writes')
        })
      ).toThrow(CallerFailure)

      expect(s.store.byLaunch(TOKEN_LAUNCH)).toStrictEqual(kept)
      expect(s.rows()).toStrictEqual([kept])
    })
  })
}
