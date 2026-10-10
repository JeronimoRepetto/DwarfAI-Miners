// layer: L2
// The hook ingress's persisted port (ADR-016 item 3; 07 S14.10; 16 §13 O-16-08): the transport's
// `IngressPortRecord` seam onto `app_meta.ingress_port`, bound by the wiring over the Host database.
import { describe, expect, it } from 'vitest'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'
import { appMetaIngressPort } from './ingressPort'

describe('IngressPortRecord bridge (app_meta.ingress_port)', () => {
  it('[ADR-016] a fresh database has no ingress port; a written port is read back, and the latest write wins', () => {
    const { db } = openTemplateCopy()
    const record = appMetaIngressPort(db)

    expect(record.read()).toBeNull()
    record.write(41_234)
    expect(record.read()).toBe(41_234)
    record.write(50_001)
    expect(record.read()).toBe(50_001)
    expect(appMetaIngressPort(db).read()).toBe(50_001)
  })

  it('[ADR-016] a port outside 1024–65535 is refused by the column and the stored port is kept', () => {
    const { db } = openTemplateCopy()
    const record = appMetaIngressPort(db)
    record.write(41_234)

    expect(() => record.write(80)).toThrow()
    expect(record.read()).toBe(41_234)
  })
})
