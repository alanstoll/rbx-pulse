# Configuration

All game-specific knowledge lives in one directory of YAML files, `./config` by default
(gitignored) or wherever `PULSE_CONFIG_DIR` or `--config` points. `pulse config validate`
reports every problem in every file at once, including expressions that do not compile.

| File | Required | Contents |
|---|---|---|
| `game.yaml` | yes | universe, API key, datastores, sync pacing |
| `facts.yaml` | no | values extracted from each profile version |
| `milestones.yaml` | no | ordered progression conditions |
| `flags.yaml` | no | unordered conditions |
| `segments.yaml` | no | cohort membership or labels |
| `constants.yaml` | no | lookup tables available to every expression |

Keys (`key:` fields) are snake_case identifiers. Fact and segment keys become columns
of the generated views, so they must be distinct from each other and from the fixed
columns `user_id`, `username`, `display_name`, `profile_version_id`, `version_no`,
`valid_from`, `valid_to`, `revision_created_at`.

Editor support: `pulse config schema` writes a JSON Schema per file to `schema/`. Add
`# yaml-language-server: $schema=../schema/facts.json` (adjusting the path) as the first
line of a YAML file to get validation and completion in VS Code and other editors.

## game.yaml

```yaml
universeId: 123456789
apiKeyEnv: ROBLOX_API_KEY          # environment variable holding the Open Cloud key
datastores:
  - name: PlayerData               # the first datastore is the primary
    scope: global
    keyTemplate: "Player_{userId}"
    envelope: documentservice
  - name: Purchases                # any further datastore is supplemental
    keyTemplate: "{userId}"
    envelope: raw
    mount: purchases
    sync: { discovery: list, backfill: false }
sync:
  maxRequestsPerMinute: 120
  budgetFraction: 0.25
  concurrency: 4
  includeTestPlayers: false
  window: { start: "02:00", end: "07:00", timezone: "America/New_York" }
  index:
    orderedDatastore: LastLogin
    scope: global
    keyTemplate: "{userId}"
    valueUnit: seconds
    marginMinutes: 120
```

| Field | Default | Meaning |
|---|---|---|
| `universeId` | required | The universe the API key is scoped to. |
| `apiKeyEnv` | `ROBLOX_API_KEY` | Name of the environment variable that holds the key. The key itself never goes in config. |
| `baseUrl` | `https://apis.roblox.com` | Override for the mock server. |
| `datastores` | required, at least one | See below. |
| `sync` | all defaults | See below. |

### datastores[]

| Field | Default | Meaning |
|---|---|---|
| `name` | required | DataStore name as registered in the game. |
| `scope` | `global` | DataStore scope. |
| `keyTemplate` | required | Key pattern containing `{userId}`. Keys that do not match are skipped. |
| `envelope` | `raw` | `raw` uses the stored value as is. `documentservice` unwraps the DocumentService wrapper, exposing its fields as `$meta`. |
| `mount` | none | Supplemental stores only. Path in the document where this store's data appears, e.g. `purchases` or `extras.purchases`. Not allowed on the primary. |
| `alias` | last segment of `mount`, else `name` | Key under `$stores`. |
| `sync.discovery` | `index` if `sync.index` is set, else `list` | `list` enumerates this store's own keys every run. `index` fetches it for players the login index reports active. Use `list` when the store has fewer keys than the index reports active players. |
| `sync.backfill` | `true` | Whether `pulse backfill` reads this store's revision history. |

### sync

| Field | Default | Meaning |
|---|---|---|
| `maxRequestsPerMinute` | `120` | Hard ceiling. The DataStore budget is `300 + 40 × concurrent users` per minute, shared with the live game; stay well under it. |
| `budgetFraction` | `0.25` | Share of the limit reported by rate-limit headers this tool may use. Those headers report the API key's limit, not the DataStore budget, so this is a secondary guard. |
| `concurrency` | `4` | Parallel fetches within a page. |
| `includeTestPlayers` | `false` | Negative user ids are Studio test players; skipped unless true. |
| `window` | none | `start`, `end` as `HH:MM`, and `timezone`. Outside the window the sync sleeps. |
| `index` | none | A game-written OrderedDataStore of last-login times, which makes runs incremental. `orderedDatastore`, `scope` (`global`), `keyTemplate` (`{userId}`), `valueUnit` (`seconds` or `millis`), `marginMinutes` (`120`, how far before the previous run to look). Needs the API scope `universe.ordered-data-store.scope.entry:read`. |

## facts.yaml

A list. Each fact is evaluated against every profile version.

```yaml
- key: xp
  semantics: counter
  expr: stats.xp
- key: quest_completed_at
  shape: keyed
  semantics: timestamp
  unit: seconds
  expr: '$entries(progress.quests.completed).{ "dim": key, "value": value.at }'
- key: activity
  shape: events
  unit: seconds
  expr: 'recentEvents.{ "type": t, "data": $string(d), "ts": ts }'
```

| Field | Default | Meaning |
|---|---|---|
| `key` | required | Column name in the wide views. |
| `description` | none | Free text. |
| `expr` | required | JSONata. See `docs/EXPRESSIONS.md`. |
| `shape` | `scalar` | `scalar`: one value per version. `keyed`: a map or list, one row per key stored in `dim`. `events`: a list of `{type, data, ts, attrs?}` merged into the event table. |
| `semantics` | required unless `shape: events` | `counter` (only goes up; deltas and resets are derived), `gauge` (any number), `boolean`, `timestamp`, `label` (text). |
| `unit` | required for `timestamp` and `events` | `seconds` or `millis`, the unit of the numbers in the record. ISO strings are accepted too. |

Coercion: counters and gauges need a finite number, otherwise no row. Booleans default to
false when missing. Timestamps treat 0 as unset. Labels stringify scalars. A keyed
result may be `[{dim, value}]`, a plain map, or a list of strings (each becomes a `true`).

## milestones.yaml and flags.yaml

Both are lists with the same fields. Milestones are ordered and appear in that order in
funnels; flags are unordered.

```yaml
- key: finished_tutorial
  when: progress.quests.completed.q_intro
  at: progress.quests.completed.q_intro.at
  unit: seconds
```

| Field | Default | Meaning |
|---|---|---|
| `key` | required | |
| `description` | none | |
| `when` | required | JSONata condition. Truthy means reached. Empty arrays, 0 and empty strings are false. |
| `at` | none | JSONata yielding the exact time it was reached. With it, precision is `exact`; without, the time is bounded by sync intervals. |
| `unit` | `seconds` | Unit of `at`. |

## segments.yaml

A list. Each segment has exactly one of `boolean` or `label`.

```yaml
- key: is_premium
  boolean: flags.premium
- key: join_week
  label: $fromMillis($toMillis($entry.createTime), "[Y0001]-W[W01]")
```

| Field | Meaning |
|---|---|
| `key` | Column name in the wide views. |
| `description` | Free text. |
| `boolean` | JSONata yielding membership. |
| `label` | JSONata yielding a category; no label means not a member. |

Membership is recorded per profile version, so cohort composition at any past time is
reconstructible.

## constants.yaml

A map of name to any YAML value. Each is available to every expression as `$name`.

```yaml
xpPerLevel: 100
levelThresholds: [0, 100, 250, 500, 1000]
```

Names must be valid variable names and may not be `meta`, `entry` or `stores`.

## What changes when config changes

| Edited | Effect on the next `pulse extract` or `pulse run` |
|---|---|
| `facts.yaml`, `segments.yaml`, `constants.yaml` | Every version is re-extracted. Views are regenerated. |
| `milestones.yaml`, `flags.yaml` | Every player is re-derived. Milestones from the old config are discarded. |
| `game.yaml` datastores | A paused sync run is abandoned and a fresh one started. A newly added datastore gets a full listing; other datastores stay incremental. Players who have the new store get their history rebuilt with it. |

Snapshots are never affected by config changes.
