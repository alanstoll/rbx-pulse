# Architecture

rbx-pulse reads a Roblox game's player DataStores through Open Cloud, keeps every
version of every record it has seen in Postgres, and evaluates analytics defined in
YAML and JSONata on top. It never writes to Roblox. The game's schema stays in the
operator's private config; the code knows nothing about any particular game.

## Pipeline

```
Open Cloud --> sync --> snapshot --> assemble --> profile_version --> extract --> fact, event, segment_membership
                                                                             --> derive  --> milestone_event, stat_delta
                                                                             --> views   --> v_player_current, v_player_history
```

Each stage is rebuildable from the stage before it. Snapshots are the only source of
truth; everything downstream can be dropped and regenerated, and is, whenever the
config that produced it changes.

**Sync** lists each configured datastore's keys, fetches each entry, and writes an
`observation` for every check. A `snapshot` is written only when the content hash
differs from the player's latest snapshot for that datastore. Runs are resumable:
progress is saved as a per-datastore cursor and a paused run continues where it
stopped. With a game-written last-login index, a run fetches only players active since
the previous completed listing of that datastore.

**Assemble** turns a player's snapshots into a sequence of profile versions. A version
is one snapshot per datastore, the latest of each at that moment, and a new version is
cut whenever any component changes. Versions are ordered by the write time Roblox
reports, so snapshots reconstructed from revision history slot into the right place
regardless of when they were fetched. No version exists before the player's first
primary snapshot.

**Extract** evaluates every fact and segment expression against each version's
document and writes typed rows. It is incremental: a version is re-extracted only when
it has never been extracted or the config hash it was extracted with differs from the
current one. Events are additive and deduplicated.

**Derive** finds, per player, the first version where each milestone and flag holds,
and computes the change in every counter and gauge between consecutive versions.

**Views** regenerate `v_player_current` and `v_player_history`, one column per scalar
fact and per segment, so dashboards and ad hoc SQL read naturally.

## The document

Expressions see one JSON document per profile version: the primary datastore's stored
value with any wrapper envelope removed, plus every supplemental datastore's value
mounted at its configured path. A supplemental store that has no entry for the player is
simply absent from the document, so `$count(purchases)` is 0 and `$sum(purchases.robuxSpent)`
is undefined, exactly as if the field were missing from the record.

Bindings available to every expression: `$meta` (wrapper metadata), `$entry` (Open
Cloud create, revision and observation times), `$stores` (every datastore by alias, with
its own data, meta and entry), and every value from `constants.yaml` by name.

## Time

Three clocks matter and they are kept apart.

- `revision_created_at` is when Roblox says the entry was written. Versions are ordered
  by it and `valid_from` / `valid_to` are derived from it.
- `observed_at` is when this tool saw the state. It is the last moment the previous
  state is known to have held.
- Timestamps inside the record are whatever the game stored, converted by the fact's
  declared unit.

A milestone reached between two syncs is therefore reported as an interval
`[reached_lo, reached_hi]` with a precision tag: `exact` when the record carries the
time, `revision` when bounded by the previous observation and this version's write
time, `interval` when only observation times are known. Milestones and flags never
regress: the first satisfying version wins.

## Datastores

The first datastore in `game.yaml` is the primary. Its entry's `createTime` is treated
as the player's install date, and its data is the root of the document. Every other
datastore is supplemental: part of the player record that the game keeps under another
key. Each one declares a `mount` path and how its keys are discovered on each run:
`list` enumerates the store's own keys, which is cheap when few players have an entry;
`index` fetches it for every player the login index reports active, which is cheap when
most do. Both are correct, since a player who has not logged in cannot have gained an
entry.

## Storage shape

Facts live in one long table keyed by version, fact key and (for keyed facts) a
dimension, with one typed value column per kind. There are no per-config tables or
migrations: changing the config changes which rows exist, not the schema. The wide
views are the only generated SQL, and they are regenerated from config on demand.

Each version records the hash of the config that extracted and derived it. Changing
`facts.yaml` re-extracts every version on the next run; changing `milestones.yaml`
re-derives every player. Snapshots are never touched by config changes.

## Open Cloud constraints

- The DataStore request budget is per universe and shared with the live game. The sync
  is paced by a hard requests-per-minute ceiling and by an optional schedule window.
  The rate-limit headers Open Cloud returns describe the API key's limit, not the
  universe's DataStore throttle, so the ceiling is the safeguard that matters.
- Listing returns keys only. There is no "changed since", which is why a game-written
  last-login index is the only way to make runs incremental.
- Overwritten revisions are retained for about 30 days. `backfill` reads them into
  earlier snapshots for recently active players.
- Deleted entries are not detected. A purged or reset record keeps its last snapshot.

## Tenants and schema

One Postgres server, one database per tenant: `pulse` for the operator's game,
`pulse_demo` for the turn-key demo, `pulse_test` for the integration suites. The code
only ever sees a connection URL. The schema is a single `db/schema.sql` for fresh
databases plus one migration file per release for existing ones; `db/README.md` has
the rules.

Grafana is provisioned with a datasource per tenant and dashboards that read every
fact, segment and milestone through template variables, so they work for any config
without editing panels.

## Non-goals

Writing anything back to Roblox. MemoryStores. More than one universe per database.
Hosted or multi-user deployment.
