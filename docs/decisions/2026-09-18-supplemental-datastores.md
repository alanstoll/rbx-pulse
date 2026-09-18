# Plan: supplemental datastores

Status: implemented 2026-09-18 (all seven steps; the tombstone item under "Deleted
entries" remains deferred). ARCHITECTURE.md, CONFIG.md and OPERATIONS.md carry the resulting behaviour;
this document is the rationale. One deviation from the plan: `alias` defaults to the
mount's last segment rather than the full path, so a nested mount such as
`extras.purchases` reads as `$stores.purchases`. One bug found on the way: `isPrefix`
compared component maps as JSON strings, but JSONB returns keys ordered by length, so
two stores whose names differ in length forced a rebuild of every multi-store player on
every extract. It now compares key-order independently.

Motivating case: `PlaygroundPurchases_v1`, a flat array of
timestamped purchases keyed by user id, held by roughly 415 of 157k players. It could
have been an array inside the primary record; it was split out for size. The design
below treats that as the general case: **a supplemental datastore is a piece of the
player record that happens to live under another key**, and the framework should make
it look that way to config authors while syncing it at a cost that matches its shape.

## What already works

Most of the machinery exists. `game.yaml` accepts several datastores; the sync lists and
fetches each independently; assembly cuts a new `profile_version` whenever any
component snapshot changes; `buildDocument` exposes every store as `$stores.<alias>`;
`composeVersions` orders snapshots by Roblox revision time so a store first synced
today is interleaved at the time it was actually written. Nothing in extract, derive,
segments or the wide views knows how many stores a profile has.

So the work is not "add multi-store support". It is five smaller things:

1. Make a supplemental store feel inline (`mount`), so `purchases` reads like a field.
2. Let each store pick how its keys are discovered, so a sparse store is cheap.
3. Fix lifecycle edges that only appear with more than one store: absent-vs-missing,
   versions without a primary, incremental state after adding a store.
4. Tooling: test expressions locally against several sample files; demo coverage.
5. Optional: richer event payloads, since timestamped lists are what these stores hold.

## 1. Configuration

```yaml
datastores:
  - name: PlaygroundPlayerData_v4        # first entry is the primary (unchanged rule)
    keyTemplate: "{userId}"
    envelope: documentservice

  - name: PlaygroundPurchases_v1
    keyTemplate: "{userId}"
    envelope: raw                        # flat array, no wrapper
    mount: purchases                     # appears as `purchases` in the root document
    sync:
      discovery: list                    # list | index   (see section 2)
      backfill: false                    # revisions carry no extra history here
```

Per-datastore fields:

| Field | Meaning | Default |
|---|---|---|
| `mount` | Path in the root document where this store's unwrapped `data` is placed. Identifier or dotted path (`extras.purchases`). Also the `$stores` key. Required on non-primary stores; an error on the primary. | none |
| `alias` | Kept for the `$stores` key only, for configs that do not want a mount. | `mount`, else name |
| `sync.discovery` | `list`: enumerate this store's own keys every run. `index`: fetch it for players the last-login index reports as active. | `index` when `sync.index` is configured, else `list` |
| `sync.backfill` | Whether `pulse backfill` reads this store's revision history. | `true` |

Validation additions in `load.ts`: mount paths unique and non-overlapping; mount absent
on the primary; `discovery: index` requires `sync.index`.

Collision rule: if the primary record already has a value at the mount path, the mounted
store wins and the extract stage warns once per key (reported in `ExtractStats.errors`
under `mount <path>`). The config is the contract; a stale inline copy left behind by a
game migration must not shadow the live store.

## 2. Sync cost: discovery modes

Open Cloud has no "does this key exist" cheaper than a read, so for a store held by a
small fraction of players the two strategies cost:

| Mode | Requests per run | Right when |
|---|---|---|
| `list` | pages of 256 keys + one read per existing key (417 for purchases) | keys in the store < players the index would report active |
| `index` | one read per active player, most returning 404 | the store is dense, or its key count is unknown and large |

Both are correct. A player who has not logged in cannot have gained a purchase record,
so `index` never misses a change; it just pays for 404s. `list` re-reads every existing
entry each run because there is no changed-since, which is fine while the store is
small. The rule of thumb goes in OPERATIONS.md; the default (index if an index exists)
is the safe choice for dense stores, and the sparse case opts into `list`.

Engine changes in `sync/engine.ts`:

- The `sinceMs !== undefined` branch becomes per-datastore: `listIndexPage` is used only
  when the store's effective discovery is `index`; `list` stores always call
  `client.listEntries`.
- `stats` gains a per-datastore breakdown (`stats.datastores[name] = {listed, checked,
  changed, absent, ...}`) so the sync-health dashboard can show each store.

### Absent is not missing

Today a 404 writes an `observation` with `status = 'missing'`. For a supplemental store in
`index` mode that is the expected outcome for 99% of players and would flood the table
and the stats. New status `absent`: a non-primary store returned 404 for a player who has
a primary record. `missing` stays reserved for a listed key that vanished. Stats count
them separately. No migration needed: `observation.status` is free text.

### Incremental state after adding a store

`configHash` covers the whole `datastores` list, so adding a store changes it and
`lastCompletedRunStart(hash)` finds nothing: the next run lists the primary in full. The
same query also has a latent bug: a run with `--datastore X` finishes as `completed`,
so the next incremental run for the primary would take its `since` from a run that never
touched the primary.

Fix both by tracking completion per datastore rather than per run. `sync_run.cursor`
already records `datastores[name].done`; `lastCompletedRunStart` becomes
`lastCompletedFor(datastoreName)`: the latest non-limited run in which that store's
cursor is `done`. JSONB predicate, no migration. A newly added store then gets a full
listing while the primary stays incremental, and the onboarding sequence is simply:

```sh
pulse sync --datastore PlaygroundPurchases_v1   # 417 requests
pulse extract                                    # rebuilds versions for the ~415 payers
```

Resumption keeps the whole-config hash: a paused run predates the config change, and
starting fresh is the right outcome.

## 3. Assembly and history

### Versions need a primary

`composeVersions` cuts a version for any snapshot, so a purchase snapshot whose revision
time predates the player's first primary snapshot (or a `--datastore` sync on an empty
database) produces a version whose root document is `{}`. Rule change: versions start at
the first primary snapshot; earlier supplemental snapshots are carried into that first
version. `composeVersions` takes the primary datastore name as a parameter; the runner
passes `config.game.datastores[0].name`.

### Retroactive interleaving

The first sync of the purchase store inserts one snapshot per payer with
`revision_created_at` = the last write to their purchase record. Assembly sorts it into
that player's history at that time, `isPrefix` fails for versions after it, and the
player's versions, facts, segments, milestones and deltas are rebuilt from there. This is
the correct outcome: the purchase record has held that state since that write. It
touches only players who have the store (415), so cost is negligible. Document it,
because operators will see `playersRebuilt` jump on the run after adding a store.

Two consequences worth stating in the architecture doc:

- A change in any mounted store cuts a version even if the primary did not change, so
  `v_player_activity` ("last time the record changed") now includes purchase writes.
  That is arguably more correct, and it is what "could have been inline" implies.
- The first version that includes the store gets a `revision`-precision bound for any
  flag derived from it, unless the flag has an `at`. For timestamped lists, always
  give the flag an `at` (see the worked config) so it is `exact`.

### Deleted entries (deferred)

Snapshots never record deletion: if a purchase record (or a primary record) is deleted,
the profile keeps its last snapshot forever. The generic fix is a tombstone snapshot
(`body = null`, `source = 'tombstone'`) written when a key with prior snapshots returns
404 in `list` mode or `absent` in `index` mode; assembly then drops the component. Not
needed for purchases; noted so it is not forgotten when purge-on-request comes up.

## 4. Extraction: bindings and tooling

`buildDocument` changes:

- Mounted stores are placed into a shallow copy of the primary's `data` at their mount
  path. Absent stores leave the path undefined; JSONata then behaves the way a missing
  inline field would: `$count(purchases)` is 0, `$sum(purchases.robuxSpent)` is
  undefined (no fact row), `$count(purchases) > 0` is false. Verified with `pulse eval`
  against the samples.
- `$stores.<alias>` gains `entry` alongside `data` and `meta`, with `createTime`,
  `revisionCreateTime`, `observedAt`. For a store whose items carry no timestamps,
  `revisionCreateTime` is still "last time this player's list changed" and
  `createTime` is "first item", which is real history for free.

Helper: add `$default(value, fallback)` to the JSONata helpers. Counters that should read
0 for players without the store currently need
`$exists(purchases) ? $sum(purchases.robuxSpent) : 0`; the helper makes that
`$default($sum(purchases.robuxSpent), 0)`.

`pulse eval` gains a repeatable `--store <alias>=<file>` option. With `--config`, the
alias resolves to the datastore's envelope and mount from `game.yaml`, so the document
under test is assembled exactly as extract would assemble it:

```sh
pulse eval '$count(purchases)' --record config/samples/dev-record.json \
  --store purchases=config/samples/dev-purchases.json --config config
```

`pulse facts <userId>` is unchanged; it already reads the composite document.

## 5. Events with attributes (optional, recommended)

The natural extraction for a timestamped list is the existing `events` fact shape, which
dedupes on `(user, type, data, ts)` and survives the record's rolling window. Purchase
analysis wants more than one string per event (product, currency, robux, place). Two
options:

- Pack JSON into `data` and query `data::jsonb` in SQL. Works today, no changes.
- Add `event.attrs JSONB` (migration 0007) and let the events shape accept an optional
  `attrs` object. Dedupe key unchanged. Grafana panels can then group by
  `attrs->>'currency'` without parsing.

Recommend the second: it is a small generic improvement and keeps `data` as the
human-readable identity of the event.

## 6. Demo coverage

Add a sparse `Purchases` datastore to the demo game: the generator gives ~3% of players
a purchase list, the mock server already serves any `<name>.jsonl`. Tests to add:

- sync: `list` discovery fetches only existing keys; `index` discovery records `absent`
  for players without the store; per-datastore completion keeps the primary incremental
  after a `--datastore` run.
- assemble: no version before the first primary snapshot; a late-synced store
  interleaves at its revision time and rebuilds the affected player only.
- extract: mount is visible at the root and via `$stores`; absent mount yields 0 / no
  row / false as above; collision warning fires once.
- eval: `--store` assembles the document the same way.

## 7. Worked config for the purchase store (private `config/`)

The sample rows are `{at, currency, placeId, productId, productKey, purchaseId,
robuxSpent}`. Note `robuxSpent` is 0 for in-game-currency purchases, so "payer" (spent
Robux) and "purchaser" (bought anything) are different questions.

```yaml
# facts.yaml
- key: purchase_count
  semantics: counter
  expr: $count(purchases)
- key: robux_spent
  semantics: counter
  expr: $default($sum(purchases.robuxSpent), 0)
- key: first_purchase_at
  semantics: timestamp
  unit: seconds
  expr: $min(purchases.at)
- key: last_purchase_at
  semantics: timestamp
  unit: seconds
  expr: $max(purchases.at)
- key: purchases_by_product
  shape: keyed
  semantics: counter
  expr: purchases{productKey: $count($)}
- key: spend_by_currency
  shape: keyed
  semantics: counter
  expr: purchases{currency: $sum(robuxSpent)}
- key: purchase_events
  shape: events
  unit: seconds
  expr: >-
    purchases.{"type": "purchase", "data": productKey, "ts": at,
               "attrs": {"currency": currency, "robux": robuxSpent, "placeId": placeId}}

# flags.yaml
- key: first_purchase
  when: $count(purchases) > 0
  at: $min(purchases.at)            # exact precision from the first sync
- key: paid_robux
  when: $sum(purchases.robuxSpent) > 0
  at: $min(purchases[robuxSpent > 0].at)

# segments.yaml
- key: purchaser
  boolean: $count(purchases) > 0
- key: purchase_band
  label: >-
    ($n := $count(purchases); $n = 0 ? "0" : $n < 3 ? "1-2" : $n < 10 ? "3-9" : "10+")
```

`stat_delta` on `purchase_count` then gives purchases per period per player with no
further config, and the Progression dashboard's funnel can include `first_purchase`
relative to any milestone.

## Order of work

1. Config schema and validation (`mount`, per-store `sync.discovery` / `sync.backfill`,
   `$default` helper). `pulse eval --store`.
2. `buildDocument`: mount placement, `$stores.*.entry`, collision warning.
3. Assembly: primary-required rule.
4. Sync: discovery modes, `absent` status, per-datastore completion, per-store stats.
5. Migration 0007 + `attrs` on events.
6. Demo store, tests, sync-health dashboard per-store panel.
7. Architecture and operations docs ("Adding a datastore"), README config table; apply the
   worked config to the real game and run the onboarding sequence against the dev
   universe.

Each step is independently shippable; 1 to 3 already make the purchase store usable
via `pulse sync --datastore` before the sync work lands.
