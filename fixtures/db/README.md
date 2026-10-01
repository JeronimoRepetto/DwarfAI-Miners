# fixtures/db/ — the DB fixture ladder

One SQL text dump of the Host database per internal release, at that release's final schema version, with
representative rows (`17-testing-strategy.md` §1.5 "From every previous version"; ADR-005 item 6; `21-migration-plan.md`
§5.1). The ladder test (`src/host/platform/sqlite/migrations/ladder.test.ts`) builds every rung into a temp file,
migrates it to head with the Host's own runner and runs the data-contract checks
(`src/host/platform/sqlite/testing/dataContract.ts`). So the first public release is already proven to migrate from
every internal version.

## The rules

- **One rung per release.** The rung is named after the release that ships it (`cut-0.sql`, `cut-1.sql`, …). A rung is
  never edited or deleted once its release has been built: it keeps proving that the release still migrates to head.
- **Text only, never a binary database.** A `.db`, `.sqlite` or `.sqlite3` file, or any file holding the SQLite header,
  is refused by the ladder test and by `node scripts/checks/fixtures-layout.mjs fixtures`. Text can be reviewed, and the
  privacy guard can scan it.
- **Scrubbed** (`17` §1.4): no home path, user or host name, e-mail address or secret. The rows come from a synthetic
  seed, and the dump also scrubs every value. Read the written file before committing it (skill `privacy-guard`).
- **Generated, never hand-edited.** Each rung is the output of `scripts/db/dump-fixture.mjs` for its seed in
  `src/host/platform/sqlite/testing/fixtureSeeds.ts`. The ladder test regenerates every seeded rung and fails when the
  committed text differs, so a regeneration is a reviewed diff (`17` §1.4).
- **The ladder is never empty.** With no rung, the ladder test fails rather than passing vacuously.
- **A rung above head is a future file.** The ladder test reports it and never builds or migrates it (ADR-005 item 5).

## A schema-changing PR adds a rung

A PR that adds a migration (the migrations hot spot, `22-roadmap.md` §5) must, in the same PR:

1. Add the seed of the release that ships the migration to `fixtureSeeds.ts`. The seed's `release` is that release,
   its `version` is the new head, and its rows exercise what the migration added.
2. Write that release's rung with `node scripts/db/dump-fixture.mjs --seed <release>`.
3. Leave every earlier seed and rung unchanged. They keep proving that their releases migrate to the new head.

If the release is not built yet and already has a seed and a rung from an earlier PR, raise that seed's `version` to the
new head instead, then regenerate its rung as a reviewed diff.

## Rung format

`scripts/db/dump-fixture.mjs` writes this layout (the renderer is `src/host/platform/sqlite/testing/fixtureDump.ts`):

1. header comments, ending with `-- schema-version: <n>`, the highest applied migration;
2. `PRAGMA foreign_keys = OFF;` and `BEGIN;`;
3. every table's `CREATE`, in creation order;
4. every row as an `INSERT`, tables in foreign-key order and rows in primary-key order, `schema_migrations` included;
5. the indexes, then the triggers, so no trigger fires while the rows are replayed;
6. `PRAGMA application_id`, then `COMMIT;`.

Line breaks inside a value are written as `char(10)` / `char(13)`, so a checkout's line-end conversion cannot change the
data.

## Commands

```sh
node scripts/db/dump-fixture.mjs --seed cut-0           # write fixtures/db/cut-0.sql
node scripts/db/dump-fixture.mjs --seed cut-0 --check   # exit 1 when the committed rung differs from a fresh dump
pnpm vitest run src/host/platform/sqlite/migrations/ladder.test.ts
```

The nightly full ladder run on the release lane is EPIC-17's job (`17` §5.2).
