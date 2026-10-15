import { describe } from 'vitest'
import { SqliteTransactionRunner } from '../../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../../platform/sqlite/testing/templateDb'
import {
  runDelegationTicketStoreContract,
  TICKET_OTHER_WORKER,
  TICKET_PARENT,
  TICKET_WORKER
} from '../../testing/delegationTicketStore.contract'
import { seedDelegationRows } from '../../testing/seedDelegationRows'
import { SqliteDelegationTicketStore } from './SqliteDelegationTicketStore'

// L3 (17 §1.3): the contract over a copy of the run's template database (schema v1, migration 1
// applied), so every row meets the real 09 §4.6 CHECKs, UNIQUEs and foreign keys. `rows` reads
// back through the adapter's own mapping, by id.
describe('SqliteDelegationTicketStore', () => {
  runDelegationTicketStoreContract(() => {
    const { db } = openTemplateCopy()
    seedDelegationRows(db, {
      dwarfs: [TICKET_PARENT, TICKET_WORKER, TICKET_OTHER_WORKER],
      launches: []
    })
    const runner = new SqliteTransactionRunner(db)
    const store = new SqliteDelegationTicketStore(db)
    const tickets = () =>
      db.all('SELECT ticket FROM delegations ORDER BY id').map((row) => String(row['ticket']))
    return {
      store,
      inTransaction: (work) => runner.inTransaction(work),
      rows: () => tickets().flatMap((ticket) => store.byTicket(ticket) ?? []),
      storedText: () => JSON.stringify(db.all('SELECT * FROM delegations ORDER BY id')),
      dispose: () => undefined
    }
  })
})
