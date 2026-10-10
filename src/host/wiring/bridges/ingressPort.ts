// The `IngressPortRecord` bridge (ADR-016 item 3; 07 S14.10; transport/ingress/ingressPort.ts): the
// hook ingress's stable port in `app_meta.ingress_port`. `app_meta` has no module port (16 §13
// O-16-08: written by platform/transport), so the wiring binds the transport's own seam onto that
// column over the Host database. The ingress writes it when it first binds and when the persisted
// port was taken (later: ISSUE-140, ISSUE-209); the Claude hooks entry reads it when it is written
// (bridges/hostConfigWriter.ts). The column's CHECK keeps it within 1024–65535 (migration 1).
import { HostInvariantError } from '../../kernel/domain/errors'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import type { IngressPortRecord } from '../../transport/ingress/ingressPort'

const READ = 'SELECT ingress_port FROM app_meta WHERE id = 1'
const WRITE = 'UPDATE app_meta SET ingress_port = ? WHERE id = 1'

export function appMetaIngressPort(db: SqliteDatabase): IngressPortRecord {
  return {
    read: () => {
      const [row] = db.all(READ)
      if (row === undefined) {
        throw new HostInvariantError('app_meta has no row 1; migration 1 seeds it (09 §4.9)')
      }
      const port = row['ingress_port']
      return typeof port === 'number' ? port : null
    },
    write: (port) => {
      db.run(WRITE, [port])
    }
  }
}
