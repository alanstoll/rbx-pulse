# Database schema and migrations

Two kinds of file, one rule each.

| File | Role | Mutable? |
|---|---|---|
| `schema.sql` | The complete current schema. A fresh database loads this and nothing else. Its first line declares the version it corresponds to. | Always: every schema change edits it. |
| `migrations/<version>.sql` | Upgrades a database from the previous release to `<version>`. One file per release that changed the schema. | Only while `<version>` is unreleased. Frozen at tag time. |

`pulse db migrate` does the right thing for both kinds of database:

- **Empty database:** loads `schema.sql`, then records every migration file as applied,
  because `schema.sql` always includes them.
- **Existing database:** applies, in version order, every migration it has not recorded.
  The newest migration is re-applied whenever its content changes, so a developer's
  database follows the file being worked on. An older migration whose content changed
  is an error.
- **Pre-release database** (built from the numbered `0001_core.sql` series during
  development): recognised and re-labelled as the `0.1.0` baseline. Data is untouched.

## Making a schema change

1. Edit `schema.sql` so a fresh install gets the new shape.
2. Put the same change into `migrations/<next version>.sql`, creating the file if this is
   the first schema change since the last release. Write it **idempotently**
   (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE VIEW`,
   `CREATE INDEX IF NOT EXISTS`) because it will run again every time it changes during
   development, and because a failed upgrade must be safe to re-run.
3. Bump the version on the first line of `schema.sql` to that same version.
4. Run `pulse db migrate` and the tests. `test/schema-db.test.ts` checks that a fresh
   `schema.sql` and an upgraded database have the same tables, columns, indexes,
   constraints and views, whenever a previous release tag exists to compare against.

## Releasing

Tag the release. From then on `migrations/<version>.sql` is frozen: fixes go into the
next version's file. Data migrations (backfilling a column, rewriting rows) belong in
the same file as the schema change that needs them, guarded so they are idempotent too.

## Upgrading an installation

```sh
git pull && npm install
npm run pulse -- db migrate
```

Every release's migration is kept, so any older database upgrades straight to the
newest version in one run. If that ever becomes unwieldy, the oldest migrations can be
folded into `schema.sql` with a documented minimum upgradable version, which is what
larger projects do at major-version boundaries.
