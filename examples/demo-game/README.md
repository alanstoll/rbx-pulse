# Demo game

A synthetic game used for tests, docs, and starter dashboards. It has nothing to do
with any real game; it exists so the framework can be exercised end to end without a
private schema.

The one-command path is `npm run pulse -- demo seed`: it generates the world, starts the
mock server on an ephemeral port, replays weekly syncs through sync, extract, derive and
enrich into the `pulse_demo` database, and prints where to look. Everything below is the
same machinery exposed piece by piece.

```sh
# 1. generate 500 players' worth of records (deterministic for a seed)
npm run pulse -- demo generate --players 500 --seed 42

# 2. serve them as a mock Open Cloud v2 API with rate limiting
npm run pulse -- demo serve --rpm 300

# 3. validate the demo config
npm run pulse -- config validate --config examples/demo-game/config

# 4. try expressions against a single record
npm run pulse -- eval "progress.quests.completed" --record examples/demo-game/sample-record.json

# later: simulate a week passing (10% of players return and play)
npm run pulse -- demo tick --fraction 0.1
```

Record shape (inside a DocumentService-style envelope by default):

| Path | Kind | Notes |
|---|---|---|
| `profile.createdAt`, `profile.lastSeenAt` | timestamps (unix seconds) | |
| `profile.playtimeSeconds`, `stats.xp`, `stats.enemiesDefeated`, `stats.distance` | counters | |
| `stats.coins`, `stats.gems` | gauges | |
| `progress.areas` | map of booleans | `[]` when empty (Lua quirk) |
| `progress.quests.completed` | map of `{at, count}` | exact timestamps for milestones |
| `flags.*` | booleans | |
| `collection` | map of `{found, firstAt, count}` | keyed fact source |
| `inventory.slots` | array of object or `false` | `false` placeholders (Lua quirk) |
| `recentEvents` | rolling last 10 `{t, d, ts}` | event harvesting source |

Level is intentionally not stored; it is derived from `stats.xp` in config.

## The `Purchases` store

About 5% of players also have an entry in a second, sparse datastore: a flat array of
`{at, currency, placeId, productId, productKey, purchaseId, robuxSpent}` with no
envelope, keyed by bare user id. `game.yaml` mounts it at `purchases`, so
`facts.yaml` reads `$count(purchases)` as if the array lived inside the record, and
`sync.discovery: list` keeps the sync from probing the 95% who have no entry.
`demo tick` adds purchases for some buyers and a few first-time buyers.

```sh
npm run pulse -- eval '$count(purchases)' --record examples/demo-game/sample-record.json \
  --store purchases=examples/demo-game/sample-purchases.json --config examples/demo-game/config
```
