# Operating rbx-pulse

## The scheduled job

`pulse run` is the one command a schedule needs. It syncs (resuming a paused run if
there is one), then assembles profiles, extracts facts and segments, derives
milestones, flags and stat deltas, regenerates the wide views, and enriches any
players that have no username yet. Exit code 0 means everything completed; 2 means the
sync paused (Ctrl-C, key limit, or outside the sync window) and the next run will
resume it; 1 means an error.

Weekly is a sensible cadence for longitudinal questions; run it more often if you
want finer milestone timing. Every run re-reads every key unless a last-login index is
configured (below), so budget the time: at the 300-per-minute floor of the DataStore
read budget, 157k keys is about nine hours.

### Windows Task Scheduler

`scripts\pulse-run.cmd` runs the job and appends to `logs\pulse-<date>.log`.
Register it weekly at 03:00 on Sundays:

```
schtasks /Create /TN "rbx-pulse weekly" /SC WEEKLY /D SUN /ST 03:00 ^
  /TR "\"D:\java\rbx-pulse\scripts\pulse-run.cmd\"" /F
```

Docker Desktop must be running for Postgres and Grafana to be reachable. If the
machine may be asleep at that time, enable "Wake the computer to run this task" in the
task's Conditions tab, or pick a time it is awake.

### cron

```
0 3 * * 0  /path/to/rbx-pulse/scripts/pulse-run.sh
```

### Sync window

To keep the job inside quiet hours regardless of when it starts, set a window in
`game.yaml`; the sync sleeps outside it and resumes when it opens:

```yaml
sync:
  window: { start: "02:00", end: "07:00", timezone: "America/New_York" }
```

## Incremental sync with a last-login index

Open Cloud cannot list "entries changed since". If the game writes an OrderedDataStore
keyed by user id with the login time as the value, the sync can list that index newest
first and stop at the previous run's start time, fetching only players who actually
played. Configure it in `game.yaml`:

```yaml
sync:
  index:
    orderedDatastore: LastLogin   # OrderedDataStore name
    scope: global
    keyTemplate: "{userId}"       # how index keys map to user ids
    valueUnit: seconds            # or millis
    marginMinutes: 120            # look back a little before the previous run
```

The first run, and any run with `--full`, still lists every key. The API key needs the
extra scope `universe.ordered-data-store.scope.entry:read`. Players who never log in
after the index was introduced are never re-fetched, which is correct: their records
cannot have changed.

Index mode has so far been exercised against the mock server only; no universe used in
development had such an index. Watch the first incremental run's `checked` count against
your expectations and fall back to `--full` if it looks wrong.

Game side, the write is one line per login, for example
`OrderedDataStore:SetAsync(tostring(userId), os.time())`, budgeted like any other
DataStore write.

## Adding a supplemental datastore

Any datastore listed after the first in `game.yaml` is supplemental: a piece of the
player record kept under a separate key. Mount it so expressions read it as a field of
the record, and pick how its keys are discovered:

```yaml
datastores:
  - name: PlayerData_v4                # primary: the root document
    keyTemplate: "{userId}"
    envelope: documentservice
  - name: Purchases_v1                 # supplemental
    keyTemplate: "{userId}"
    envelope: raw
    mount: purchases                   # appears as `purchases` in every expression
    sync:
      discovery: list                  # or index (default when sync.index is configured)
      backfill: false                  # rows are timestamped already
```

`discovery: list` enumerates the store's own keys and reads each existing entry on every
run (pages of 256 keys, one read per key). `discovery: index` reads the store for every
player the login index reports active, and most of those reads return nothing for a
sparse store. Rule of thumb: use `list` when the store has fewer keys than the index
reports active players per run, `index` otherwise. Both are correct.

Onboarding a new store does not disturb the primary's incremental sync:

```sh
pulse sync --datastore Purchases_v1      # list + one read per existing key
pulse extract                            # rebuilds versions for players who have the store
```

Expect `playersRebuilt` to jump on that extract: each of those players' histories gains
the store at its revision time, and everything after that point is recomputed. Players
without the store are untouched, and for them the mount is simply absent (`$count` is
0, `$sum` is undefined, comparisons are false).

Test expressions against local samples before syncing:

```sh
pulse eval '$count(purchases)' --record samples/record.json --store purchases=samples/purchases.json --config config
```

`pulse runs` and the "Latest run by datastore" panel in the sync-health dashboard show
each store's outcome, with `absent` (no entry for a player reached through the index;
expected) separate from `missing` (a listed key vanished).

## Backfill from revision history

Roblox keeps prior revisions of an entry for about 30 days after they are overwritten.
`pulse backfill` reads them for recently active players and stores them as earlier
snapshots, so milestone timing and stat deltas start with history instead of waiting
for the next sync. Each revision is one read request; `--max-revisions` caps the cost
per player. Run it once after the first full sync, and optionally again after a long
gap between syncs.

## Enrichment

`pulse enrich` fills username, display name, account creation time, locale and premium
status from the public users API. `pulse run` does this for new players automatically;
use `--refresh-days 90` to refresh older rows.

## Purging a player

`pulse purge <userId> --yes` removes every stored trace: snapshots, observations,
profile versions, facts, events, milestones, deltas, segment rows and the player row.
Use it to honour deletion requests forwarded by Roblox.

## Upgrading

```sh
git pull && npm install
npm run pulse -- db migrate     # applies any release migrations this database has not seen
```

Migrations are idempotent, so a run that failed halfway is safe to repeat. A database
created during rbx-pulse's pre-release development is recognised and carried forward
automatically. See `db/README.md` for how migrations are organised.

## Backups

The database is the only state. `docker compose exec postgres pg_dump -U pulse pulse > backup.sql`
is enough; raw snapshots are the source of truth and everything else is rebuildable
with `pulse extract --rebuild`.
