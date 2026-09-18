# rbx-pulse

Analytics for Roblox games, from the DataStores you already have. rbx-pulse reads
player records read-only through Open Cloud into a local Postgres, keeps every version
it sees, and evaluates **milestones**, **flags**, **stats over time** and **cohorts**
that you define in YAML and [JSONata](https://jsonata.org/). Grafana dashboards come
provisioned and work for any config.

Your game's schema never enters this repository. Everything game-specific lives in a
gitignored `config/` directory.

## See it working in five minutes

No Roblox account or API key needed. A synthetic game is generated and eight weeks of
weekly syncs are replayed through the whole pipeline into a separate demo database.

```sh
npm install
cp .env.example .env
docker compose up -d                 # Postgres + Grafana
npm run pulse -- demo seed           # ~1 minute: 500 players, 9 weekly syncs
```

Open Grafana at http://localhost:3000 (admin / pulse), folder **Pulse**, and set the
**Database** dropdown to `pulse-demo`. The demo game's config in
`examples/demo-game/config` is a worked example of every feature.

```sh
npm run pulse -- facts <userId> --database-url postgres://pulse:pulse@localhost:5432/pulse_demo
npm run pulse -- demo seed --weeks 26 --players 2000
```

## Your own game

1. Create an Open Cloud API key with **Data Stores: Read** scoped to your universe and
   put it in `.env` as `ROBLOX_API_KEY`.
2. Write `config/game.yaml`, then facts, milestones, flags and segments. `docs/CONFIG.md`
   lists every field; `docs/EXPRESSIONS.md` has recipes; `pulse eval` tries expressions
   against a record file before anything is synced.
3. Run the job.

```sh
npm run pulse -- config validate
npm run pulse -- run               # sync, extract, derive, enrich
npm run pulse -- facts <userId>
```

Schedule `pulse run` weekly (see `docs/OPERATIONS.md`) and switch the Grafana
**Database** dropdown to `pulse`. The demo and your data never share a database.

Other commands: `sync`, `extract`, `derive`, `backfill`, `enrich`, `runs`, `export`,
`purge`, `config apply`, `config schema`, `db migrate`, and the `demo` group. Each has
`--help`.

## Documentation

| | |
|---|---|
| `docs/ARCHITECTURE.md` | How the pipeline, document, and time model work |
| `docs/CONFIG.md` | Every config file and field |
| `docs/EXPRESSIONS.md` | JSONata bindings, helpers, recipes |
| `docs/OPERATIONS.md` | Scheduling, incremental sync, backfill, upgrading, backups |
| `db/README.md` | Schema and migration practice |
| `CONTRIBUTING.md` | Working on rbx-pulse |

## Layout

```
src/config     YAML loading, zod schemas, JSON Schema export
src/expr       JSONata engine and helpers
src/envelope   wrapper-library presets (raw, documentservice)
src/db         Postgres pool and schema runner
src/sync       Open Cloud client, rate limiter, sync engine, backfill, enrich
src/profile    profile versions, document composition, extraction, derivation, views
src/demo       synthetic game, mock Open Cloud server, demo seeder
db/            schema.sql and per-release migrations
docker/        Grafana provisioning, dashboards, Postgres init
examples/      the demo game
schema/        JSON Schema for the config files
scripts/       scheduler entry points
```

## License

MIT
