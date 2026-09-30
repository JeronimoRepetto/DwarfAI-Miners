// The build's known migrations, in version order (ADR-005 item 4; 22 §5: one migration per PR).
// Append only: an entry is never edited, reordered or removed once the first internal build has
// shipped it (21 §5.1).
//
// Migration 1 binds its seed rows' install id and instant (09 §4.9) from the Host's
// `IdGenerator` and `Clock`, so the list is built over those ports: `migrationsFor` for a
// composition that owns them (the boot, tests), `knownMigrations` over the production clock and
// id generator for the runner's default. Every build of the list carries the same names, SQL and
// checksums; only the seed values differ.
import { SystemClock } from '../../clock/SystemClock'
import { UuidV7Generator } from '../../ids/UuidV7Generator'
import { initialMigration, type InitialMigrationPorts } from './0001-initial'
import type { Migration } from './types'

export function migrationsFor(ports: InitialMigrationPorts): readonly Migration[] {
  return [initialMigration(ports)]
}

const systemClock = new SystemClock()

export const knownMigrations: readonly Migration[] = migrationsFor({
  clock: systemClock,
  ids: new UuidV7Generator({ clock: systemClock })
})
