# Contributing

## Setup

```sh
npm install
cp .env.example .env
docker compose up -d
npm test
```

`npm test` runs the unit suites always and the Postgres suites when
`PULSE_TEST_DATABASE_URL` is set, which `.env.example` does. The test database is wiped
on every run. `npm run lint` and `npm run typecheck` must both pass.

## Ground rules

- **No game schema in the repo.** Real configs live in `./config`, which is gitignored.
  Anything that needs a record shape uses the demo game in `examples/demo-game`.
- **Snapshots are sacred.** Nothing downstream may modify or delete `snapshot` rows
  except `purge`. Every other table must be rebuildable from them.
- **Exceptions are documented where they live.** When code departs from the obvious,
  say why in a comment next to it, not in a doc. The docs describe the normal path.
- **Schema changes** follow `db/README.md`: edit `schema.sql`, mirror the change in the
  next release's migration, keep the migration idempotent.
- **Tests before behaviour.** New behaviour in sync, assemble, extract or derive gets a
  unit test for the pure part and an integration test against the mock server where
  the database is involved.

## Releasing

1. Update `CHANGELOG.md` and the version in `package.json` and on the first line of
   `db/schema.sql`.
2. Tag `vX.Y.Z`. The `v` prefix matters: the schema test uses the newest such tag to
   check that the previous release plus its migration equals the current `schema.sql`.
3. From then on that release's migration file is frozen.

## Docs

| File | What it is for |
|---|---|
| `README.md` | What this is, and the five-minute path to seeing it work |
| `docs/ARCHITECTURE.md` | How it works; evergreen |
| `docs/CONFIG.md` | Every config file and field |
| `docs/EXPRESSIONS.md` | JSONata bindings, helpers, recipes |
| `docs/OPERATIONS.md` | Running it on a schedule; upgrading |
| `db/README.md` | Schema and migration practice |
| `docs/decisions/` | Dated records of why things are the way they are |
