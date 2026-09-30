import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readReinventoryTable, scanIpc } from './ipc-reinventory.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureRoot = path.join(here, '__fixtures__', 'ipc-reinventory')
const repoRoot = path.resolve(here, '..', '..')
const tablePath = path.join(repoRoot, 'docs', 'strangler', 'registry-reinventory.md')

/** One found item as a short, readable line, so a failure names what was missed or added. */
const describeItem = (item) => `${item.source} ${item.wire} ${item.kind} ${item.name}`

describe('ipc re-inventory scanner', () => {
  it('[ADR-019] the scanner finds every ipcMain registration, preload member and push of the fixture tree', () => {
    const found = scanIpc(fixtureRoot).map(describeItem).sort()

    expect(found).toEqual(
      [
        'registration fixture:unlisted invoke null',
        'constant thing:changed null thingChanged',
        'push thing:changed push thingChanged',
        'constant thing:get null getThing',
        'registration thing:get invoke getThing',
        'preload thing:get invoke getThing',
        'constant thing:set null setThing',
        'registration thing:set send setThing'
      ].sort()
    )
  })

  it('[ADR-019] the scanner reports file and line for each found item and sorts by wire name', () => {
    const found = scanIpc(fixtureRoot)

    expect(found).toEqual([
      {
        wire: 'fixture:unlisted',
        source: 'registration',
        kind: 'invoke',
        name: null,
        file: 'src/main/index.ts',
        line: 11
      },
      {
        wire: 'thing:changed',
        source: 'push',
        kind: 'push',
        name: 'thingChanged',
        file: 'src/main/index.ts',
        line: 12
      },
      {
        wire: 'thing:changed',
        source: 'constant',
        kind: null,
        name: 'thingChanged',
        file: 'src/shared/contracts.ts',
        line: 7
      },
      {
        wire: 'thing:get',
        source: 'registration',
        kind: 'invoke',
        name: 'getThing',
        file: 'src/main/index.ts',
        line: 5
      },
      {
        wire: 'thing:get',
        source: 'preload',
        kind: 'invoke',
        name: 'getThing',
        file: 'src/preload/index.ts',
        line: 5
      },
      {
        wire: 'thing:get',
        source: 'constant',
        kind: null,
        name: 'getThing',
        file: 'src/shared/contracts.ts',
        line: 4
      },
      {
        wire: 'thing:set',
        source: 'registration',
        kind: 'send',
        name: 'setThing',
        file: 'src/main/index.ts',
        line: 6
      },
      {
        wire: 'thing:set',
        source: 'constant',
        kind: null,
        name: 'setThing',
        file: 'src/shared/contracts.ts',
        line: 6
      }
    ])
    const wires = found.map((item) => item.wire)
    expect(wires).toEqual([...wires].sort())
  })
})

/**
 * The seam A rows of `14` §2.1/§2.2 (id, wire name, member name, kind, status) plus the two legacy
 * channels of `14` §8 I-21, which share the reference `§8 I-21` and are told apart by wire name: a
 * hand-written, reviewed data fixture, not the contract text.
 */
const catalog14 = JSON.parse(
  readFileSync(path.join(fixtureRoot, 'catalog-14-seam-a.json'), 'utf8')
).rows
const I21 = '§8 I-21'

/** The fixture entry a row's `14` reference names, or undefined when there is none. */
const entryOf = (row) =>
  catalog14.find((entry) => entry.id === row.id && (row.id !== I21 || entry.wire === row.wire))

/** A channel is known by its wire name; the one preload helper with no wire, by its member name. */
const keyOf = (wire, member) => wire ?? `helper ${member}`

/** The found items of the real tree, one entry per channel (or helper), with the files it appears in. */
function foundChannels() {
  const groups = new Map()
  for (const item of scanIpc(repoRoot)) {
    const key = keyOf(item.wire, item.name)
    const group = groups.get(key) ?? {
      member: null,
      constant: null,
      kinds: new Set(),
      files: new Set()
    }
    if (item.source === 'preload') group.member = item.name
    if (item.source === 'constant') group.constant = item.name
    if (item.kind !== null) group.kinds.add(item.kind)
    group.files.add(item.file)
    groups.set(key, group)
  }
  return [...groups].map(([key, group]) => ({
    key,
    member: group.member ?? group.constant,
    kind: [...group.kinds].sort().join('+'),
    files: [...group.files].sort()
  }))
}

function tableRows() {
  expect(existsSync(tablePath), 'docs/strangler/registry-reinventory.md exists').toBe(true)
  const rows = readReinventoryTable(readFileSync(tablePath, 'utf8'))
  expect(rows.length, 'the re-inventory table has rows').toBeGreaterThan(0)
  return rows
}

describe('registry re-inventory (14 §6.5, P-3)', () => {
  it('[ADR-019] every found registration, preload member and push has exactly one row in registry-reinventory.md', () => {
    const rows = tableRows()
    const problems = []
    for (const channel of foundChannels()) {
      const matching = rows.filter((row) => keyOf(row.wire, row.member) === channel.key)
      if (matching.length !== 1) {
        problems.push(`${channel.key}: ${matching.length} rows`)
        continue
      }
      const [row] = matching
      const said = `${row.member} ${row.kind} ${row.files.join(',')}`
      const found = `${channel.member} ${channel.kind} ${channel.files.join(',')}`
      if (said !== found)
        problems.push(`${channel.key}: the row says ${said}, the tree has ${found}`)
    }

    expect(problems).toEqual([])
  })

  it('[ADR-019] every row names a 14 id and its 14 status, or is UNLISTED with an AR-P3 id', () => {
    const rows = tableRows()
    const problems = []
    const seenIds = new Set()
    const seenRequests = new Set()
    for (const row of rows) {
      const key = keyOf(row.wire, row.member)
      if (row.status === 'UNLISTED') {
        if (row.id !== null) problems.push(`${key}: UNLISTED but names ${row.id}`)
        const listed = catalog14.find((entry) => row.wire !== null && entry.wire === row.wire)
        if (listed) problems.push(`${key}: UNLISTED but 14 lists it as ${listed.id}`)
        if (!/^AR-P3-\d{2}$/.test(row.request ?? ''))
          problems.push(`${key}: UNLISTED without an AR-P3 id`)
        else if (seenRequests.has(row.request))
          problems.push(`${key}: ${row.request} is used twice`)
        seenRequests.add(row.request)
        continue
      }
      const entry = entryOf(row)
      if (!entry) {
        problems.push(`${key}: ${row.id} is not a 14 §2 id or a 14 §8 I-21 entry`)
        continue
      }
      if (entry.status !== row.status) {
        problems.push(`${key}: ${row.id} is ${entry.status} in 14, the row says ${row.status}`)
      }
      const said = `${row.wire} ${row.member} ${row.kind}`
      const listed = `${entry.wire} ${entry.member} ${entry.kind}`
      if (said !== listed)
        problems.push(`${key}: ${row.id} is ${listed} in 14, the row says ${said}`)
      const reference = row.id === I21 ? `${row.id} ${row.wire}` : row.id
      if (seenIds.has(reference)) problems.push(`${key}: ${reference} has a second row`)
      if (row.request !== null) problems.push(`${key}: a listed row carries ${row.request}`)
      seenIds.add(reference)
    }

    expect(problems).toEqual([])
  })

  it('[ADR-019] no row of the table is missing from the tree unless its 14 status is NEW', () => {
    const rows = tableRows()
    const found = new Set(foundChannels().map((channel) => channel.key))

    const stale = rows
      .filter((row) => !found.has(keyOf(row.wire, row.member)) && row.status !== 'NEW')
      .map((row) => `${keyOf(row.wire, row.member)} (${row.id ?? row.request} ${row.status})`)

    expect(stale).toEqual([])
  })
})
